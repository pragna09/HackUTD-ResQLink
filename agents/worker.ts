// Agents worker: connects to SpacetimeDB as a client and runs the three agents.
//   Weather Research: on a timer (WEATHER_INTERVAL_MIN) and whenever a zone's researchStatus = 'requested'.
//   Triage:           for every open case with an empty rationale (batched).
//   Shelter:          for every open case without a matched offer (code shortlist -> agent note).
// Run: npm run dev   (in /agents)
import { env } from './config';
import { llm } from './llm';
import { fetchActiveAlerts } from './nws';
import { connectStdb, type Stdb } from './stdb';
import { buildShortlist, runShelter } from './shelter';
import { runTriage } from './triage';
import { runWeatherResearch } from './weather';
import type { ZoneRow } from './types';

const SHELTER_RETRY_MS = 60_000;

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
  const client = llm();
  console.log(
    `[agents] provider=${client.adapter.name} model=${client.adapter.model} ` +
      (client.adapter.available && !env.LLM_FORCE_FALLBACK ? 'LIVE' : `FALLBACK ONLY (${env.LLM_FORCE_FALLBACK ? 'LLM_FORCE_FALLBACK=1' : client.adapter.unavailableReason})`)
  );
  const db = await connectStdb();

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
  setInterval(() => {
    // Respect an operator's demo override: the timer never overwrites a 'simulated' zone.
    db.zones().filter(z => z.source !== 'simulated').forEach(research);
  }, env.WEATHER_INTERVAL_MIN * 60_000);

  // ---- Triage --------------------------------------------------------------------------------
  const triaged = new Set<string>();
  let triageRunning = false;
  const triage = async () => {
    if (triageRunning) return;
    triageRunning = true;
    try {
      for (;;) {
        const pending = db
          .cases()
          .filter(c => c.status !== 'resolved' && c.rationale === '' && !triaged.has(String(c.id)))
          .sort((a, b) => b.urgencyScore - a.urgencyScore);
        if (pending.length === 0) break;
        const zones = new Map(db.zones().map(z => [z.id, z]));
        // Group by zone so each prompt carries one zone summary.
        const byZone = new Map<string, typeof pending>();
        for (const c of pending) (byZone.get(c.zoneId) ?? byZone.set(c.zoneId, []).get(c.zoneId)!).push(c);
        for (const [zoneId, cases] of byZone) {
          cases.forEach(c => triaged.add(String(c.id)));
          const results = await runTriage(cases, zones.get(zoneId));
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

  // ---- Shelter -------------------------------------------------------------------------------
  const shelterTried = new Map<string, number>();
  let shelterRunning = false;
  const shelter = async () => {
    if (shelterRunning) return;
    shelterRunning = true;
    try {
      const now = Date.now();
      const pending = db
        .cases()
        .filter(c => c.status !== 'resolved' && c.matchedOffer === undefined)
        .filter(c => now - (shelterTried.get(String(c.id)) ?? 0) > SHELTER_RETRY_MS)
        .sort((a, b) => b.urgencyScore - a.urgencyScore);
      for (const c of pending) {
        shelterTried.set(String(c.id), Date.now());
        const shortlist = buildShortlist(c, db.offers()); // fresh capacities each time
        const pick = await runShelter(c, shortlist);
        if (!pick) continue; // nothing suitable yet; retried when offers change
        await db
          .setMatch(pick)
          .then(() => console.log(`[shelter] case ${c.id} -> offer ${pick.offerId} (${pick.source})`))
          .catch(e => console.error(`[shelter] case ${c.id}:`, e));
      }
    } finally {
      shelterRunning = false;
    }
  };

  let debounce: NodeJS.Timeout | undefined;
  const kick = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      void triage().then(shelter);
    }, 1500);
  };
  db.onChange('missing_case', kick);
  db.onChange('shelter_offer', () => {
    shelterTried.clear(); // new or freed capacity: try everyone again
    kick();
  });
  kick();
  setInterval(kick, 30_000);

  setInterval(() => {
    const s = client.stats;
    console.log(`[agents] llm calls=${s.calls} cacheHits=${s.cacheHits} fallbacks=${s.fallbacks}`);
  }, 5 * 60_000);
}

main().catch(e => {
  console.error('[agents] fatal:', e);
  process.exit(1);
});
