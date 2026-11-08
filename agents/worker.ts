// Agents worker: connects to SpacetimeDB as a client and runs the agent pipeline.
//   Weather research: on a timer (WEATHER_INTERVAL_MIN) and whenever a zone's researchStatus = 'requested'.
//   1. Monitor:  a zone at severity >= 3 without advice -> warning + safety instructions for people in it.
//   2. Triage:   every open case with no reason yet -> reason + needs (batched per zone).
//   3. Dispatch: every triaged, undispatched case -> services by disaster + needs, message, alerts + insurer.
// All three use whichever model the dashboard picker selects.
// Run: npm run dev   (in /agents)
import { env } from './config';
import { getActiveProvider, isProvider, llm, llmFor, setActiveProvider } from './llm';
import { fetchActiveAlerts } from './nws';
import { connectStdb, type Stdb } from './stdb';
import { runDispatch } from './dispatch';
import { runMonitor } from './monitor';
import { runTriage } from './triage';
import { runWeatherResearch } from './weather';
import type { ZoneRow } from './types';

async function researchZone(db: Stdb, zone: ZoneRow) {
  const nws = await fetchActiveAlerts(zone.centerLat, zone.centerLng);
  const news = db.news(zone.id);
  console.log(`[weather] ${zone.id}: ${nws.alerts.length} NWS alerts${nws.ok ? '' : ` (NWS error: ${nws.error})`}, ${news.length} news items`);
  const res = await runWeatherResearch({ zone, news, nwsAlerts: nws.alerts, nwsError: nws.error });
  await db.upsertZone({
    id: zone.id,
    name: zone.name,
    centerLat: zone.centerLat,
    centerLng: zone.centerLng,
    radiusKm: zone.radiusKm,
    ...res.data,
    source: res.source,
  });
  console.log(`[weather] ${zone.id}: severity ${res.data.severity} (${res.data.hazard}) source=${res.source}${res.note ? ` — ${res.note}` : ''}`);
}

async function main() {
  const describe = (p: 'gemini' | 'nvidia') => {
    const a = llmFor(p).adapter;
    const live = a.available && !env.LLM_FORCE_FALLBACK;
    return `${a.name} (${a.model}) ${live ? 'LIVE' : `FALLBACK ONLY (${env.LLM_FORCE_FALLBACK ? 'LLM_FORCE_FALLBACK=1' : a.unavailableReason})`}`;
  };
  console.log(`[agents] available models: ${describe('gemini')} | ${describe('nvidia')}`);
  const db = await connectStdb();

  // ---- Model picker --------------------------------------------------------------------------
  // The dashboard writes agent_config.llmProvider; every agent (weather + triage) follows it.
  const syncProvider = () => {
    const wanted = db.llmProvider();
    if (!isProvider(wanted) || wanted === getActiveProvider()) return;
    setActiveProvider(wanted);
    console.log(`[agents] dashboard switched all agents to ${describe(wanted)}`);
  };
  syncProvider();
  console.log(`[agents] active model: ${describe(getActiveProvider())}`);
  db.onChange('agent_config', syncProvider);

  // ---- Weather -------------------------------------------------------------------------------
  const weatherBusy = new Set<string>();
  const research = (zone: ZoneRow) => {
    if (weatherBusy.has(zone.id)) return;
    weatherBusy.add(zone.id);
    researchZone(db, zone)
      .catch(e => console.error(`[weather] ${zone.id} failed:`, e))
      .finally(() => weatherBusy.delete(zone.id));
  };
  const checkRequests = () => db.zones().filter(z => z.researchStatus === 'requested').forEach(research);
  db.onChange('zone', checkRequests);
  checkRequests();

  // ---- 1. Monitor ----------------------------------------------------------------------------
  const monitorBusy = new Set<string>();
  const monitor = () => {
    for (const z of db.zones()) {
      if (z.severity < 3 || (z.safetyAdvice?.length ?? 0) > 0 || monitorBusy.has(z.id)) continue;
      monitorBusy.add(z.id);
      runMonitor(z, db.news(z.id))
        .then(res => db.setZoneAdvice({ zoneId: z.id, warning: res.data.warning, instructions: res.data.instructions, source: res.source }).then(() => res))
        .then(res => console.log(`[monitor] ${z.id}: "${res.data.warning}" + ${res.data.instructions.length} instructions (${res.source})`))
        .catch(e => console.error(`[monitor] ${z.id} failed:`, e))
        .finally(() => monitorBusy.delete(z.id));
    }
  };
  db.onChange('zone', monitor);
  monitor();
  setInterval(() => {
    // Respect an operator's demo override: the timer never overwrites a 'simulated' zone.
    db.zones().filter(z => z.source !== 'simulated').forEach(research);
  }, env.WEATHER_INTERVAL_MIN * 60_000);

  // ---- 2. Triage --------------------------------------------------------------------------------
  // Keyed by id + SOS state: a case that later becomes an SOS (mesh relay) gets a fresh reason.
  const triaged = new Set<string>();
  const triageKey = (c: { id: bigint; sos?: boolean }) => `${c.id}${c.sos ? ':sos' : ''}`;
  let triageRunning = false;
  const triage = async () => {
    if (triageRunning) return;
    triageRunning = true;
    try {
      for (;;) {
        const pending = db
          .cases()
          .filter(c => c.status !== 'resolved' && c.rationale === '' && !triaged.has(triageKey(c)))
          .sort((a, b) => b.urgencyScore - a.urgencyScore);
        if (pending.length === 0) break;
        const zones = new Map(db.zones().map(z => [z.id, z]));
        // Group by zone so each prompt carries one zone summary.
        const byZone = new Map<string, typeof pending>();
        for (const c of pending) (byZone.get(c.zoneId) ?? byZone.set(c.zoneId, []).get(c.zoneId)!).push(c);
        for (const [zoneId, cases] of byZone) {
          cases.forEach(c => triaged.add(triageKey(c)));
          const withHousehold = cases.map(c => ({ ...c, person: c.user ? db.person(c.user) : undefined }));
          const results = await runTriage(withHousehold, zones.get(zoneId));
          for (const r of results) {
            await db.setRationale(r).catch(e => console.error(`[triage] case ${r.caseId}:`, e));
          }
          console.log(`[triage] wrote ${results.length} rationales (${results.filter(r => r.source === 'llm').length} llm)`);
        }
      }
    } finally {
      triageRunning = false;
    }
  };

  // ---- 3. Dispatch --------------------------------------------------------------------------
  const dispatchTried = new Set<string>();
  let dispatchRunning = false;
  const dispatch = async () => {
    if (dispatchRunning) return;
    dispatchRunning = true;
    try {
      const zones = new Map(db.zones().map(z => [z.id, z]));
      const centers = db.centers();
      const ready = db
        .cases()
        .filter(c => c.status !== 'resolved' && c.rationale !== '' && !c.dispatched && !dispatchTried.has(`${c.id}:${c.rationale}`))
        .sort((a, b) => Number(b.sos ?? false) - Number(a.sos ?? false) || b.urgencyScore - a.urgencyScore);
      for (const c of ready) {
        dispatchTried.add(`${c.id}:${c.rationale}`);
        const d = await runDispatch(c, zones.get(c.zoneId), centers, c.user ? db.person(c.user) : undefined);
        await db
          .dispatchCase({ caseId: d.caseId, centerIds: d.centerIds, message: d.message, source: d.source })
          .then(() => console.log(`[dispatch] case ${c.id} -> ${d.targets.map(t => t.type).join(', ')} (${d.source})`))
          .catch(e => console.error(`[dispatch] case ${c.id}:`, e));
      }
    } finally {
      dispatchRunning = false;
    }
  };

  let debounce: NodeJS.Timeout | undefined;
  const kick = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      // The pipeline: triage writes reasons + needs, then dispatch acts on them.
      void triage().then(dispatch);
    }, 1500);
  };
  db.onChange('missing_case', kick);
  kick();
  setInterval(kick, 30_000);

  setInterval(() => {
    const s = llm().stats;
    console.log(`[agents] ${getActiveProvider()} llm calls=${s.calls} cacheHits=${s.cacheHits} fallbacks=${s.fallbacks}`);
  }, 5 * 60_000);
}

main().catch(e => {
  console.error('[agents] fatal:', e);
  process.exit(1);
});
