// Runs each agent once on a sample input and prints the tagged result. No SpacetimeDB needed.
// With no API key (or LLM_FORCE_FALLBACK=1) every result is a stored fallback tagged source=fallback.
//   npm run sample            # also fetches live NWS alerts for the zone center
//   npm run sample -- --no-nws
import { buildSeedDataset } from '../module/src/seed_data';
import { urgencyScore } from '../module/src/logic';
import { llm } from './llm';
import { fetchActiveAlerts, type NwsResult } from './nws';
import { buildShortlist, runShelter } from './shelter';
import { runTriage } from './triage';
import { runWeatherResearch } from './weather';
import type { CaseRow, OfferRow } from './types';

const data = buildSeedDataset();
const zone = data.zone;
const client = llm();
console.log(`provider=${client.adapter.name} model=${client.adapter.model} available=${client.adapter.available}\n`);

// 1. Weather Research
const nws: NwsResult = process.argv.includes('--no-nws')
  ? { ok: false, alerts: [], error: 'skipped (--no-nws)' }
  : await fetchActiveAlerts(zone.centerLat, zone.centerLng);
console.log(`NWS: ok=${nws.ok} alerts=${nws.alerts.length}${nws.error ? ` error=${nws.error}` : ''}`);
const weather = await runWeatherResearch({ zone, news: data.news, nwsAlerts: nws.alerts, nwsError: nws.error });
console.log('WEATHER', JSON.stringify({ source: weather.source, note: weather.note, ...weather.data }, null, 2), '\n');

// 2. Triage on three synthetic silent users
const silent = data.users.filter(u => u.silent).slice(0, 3);
const cases: CaseRow[] = silent.map((u, i) => {
  const s = urgencyScore({ severity: weather.data.severity, silentMinutes: u.minutesAgo, vulnerable: u.vulnerabilityFlag });
  return {
    id: BigInt(i + 1),
    zoneId: zone.id,
    displayName: u.displayName,
    silentMinutes: u.minutesAgo,
    severity: weather.data.severity,
    vulnerabilityFlag: u.vulnerabilityFlag,
    hasPets: u.hasPets,
    scoreSeverity: s.severityPart,
    scoreSilence: s.silencePart,
    scoreVulnerability: s.vulnerabilityPart,
    urgencyScore: s.total,
    lastLat: u.lat,
    lastLng: u.lng,
    rationale: '',
    status: 'open',
    assignedCenter: 1,
    centerDistanceKm: 1.8,
    matchedOffer: undefined,
  };
});
const triage = await runTriage(cases, { name: zone.name, hazard: weather.data.hazard, summary: weather.data.summary });
console.log('TRIAGE', triage.map(t => ({ ...t, caseId: String(t.caseId) })), '\n');

// 3. Shelter for the first case
const offers: OfferRow[] = data.shelters.map((s, i) => ({ ...s, id: BigInt(i + 1), status: 'open' }));
const shortlist = buildShortlist(cases[0], offers);
console.log(
  `SHORTLIST for ${cases[0].displayName} (pets=${cases[0].hasPets}, needsAccessible=${cases[0].vulnerabilityFlag}):`,
  shortlist.map(s => `${s.offer.id}:${s.offer.hostName} ${s.km.toFixed(1)}km cap${s.offer.capacity}`)
);
const pick = await runShelter(cases[0], shortlist);
console.log('SHELTER', pick && { ...pick, caseId: String(pick.caseId), offerId: String(pick.offerId) });
console.log('\nstats', client.stats);
