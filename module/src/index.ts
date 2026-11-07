// Welfare Check — SpacetimeDB module entry point.
// Every export here must be a SpacetimeDB export (reducer, lifecycle hook) plus the default schema.
// Reducer names: the export name in camelCase becomes the snake_case canonical name
// (updateProfile -> update_profile), which is what `spacetime call` uses.
import { t } from 'spacetimedb/server';
import spacetimedb, { scanSchedule } from './schema';
import * as h from './handlers';

export default spacetimedb;

// Lifecycle ---------------------------------------------------------------------------------------

/** First publish (and `publish -c`): load the synthetic dataset and start the 30 s scan schedule. */
export const init = spacetimedb.init(ctx => {
  h.loadSeed(ctx);
});

// Phone page --------------------------------------------------------------------------------------

export const updateProfile = spacetimedb.reducer(
  { displayName: t.string(), ageGroup: t.string(), vulnerabilityFlag: t.bool(), hasPets: t.bool(), optIn: t.bool() },
  (ctx, args) => h.updateProfile(ctx, args)
);

export const ping = spacetimedb.reducer(
  { lat: t.f64(), lng: t.f64(), accuracy: t.f64() },
  (ctx, args) => h.ping(ctx, args)
);

// News, zones, agents ---------------------------------------------------------------------------------

export const createNewsItem = spacetimedb.reducer({ area: t.string(), text: t.string() }, (ctx, args) =>
  h.createNewsItem(ctx, args)
);

export const upsertZone = spacetimedb.reducer(
  {
    id: t.string(),
    name: t.string(),
    centerLat: t.f64(),
    centerLng: t.f64(),
    radiusKm: t.f64(),
    hazard: t.string(),
    severity: t.u8(),
    confidence: t.f64(),
    summary: t.string(),
    evidence: t.array(t.string()),
    source: t.string(),
  },
  (ctx, args) => h.upsertZone(ctx, args)
);

/** Dashboard "Run weather research" button. The Weather agent watches for researchStatus = 'requested'. */
export const requestResearch = spacetimedb.reducer({ zoneId: t.string() }, (ctx, args) => h.requestResearch(ctx, args));

export const setRationale = spacetimedb.reducer(
  { caseId: t.u64(), rationale: t.string(), source: t.string() },
  (ctx, args) => h.setRationale(ctx, args)
);

export const acknowledgeAlert = spacetimedb.reducer({ alertId: t.u64() }, (ctx, args) => h.acknowledgeAlert(ctx, args));

// Shelters -----------------------------------------------------------------------------------------

export const registerShelter = spacetimedb.reducer(
  {
    hostName: t.string(),
    lat: t.f64(),
    lng: t.f64(),
    capacity: t.u32(),
    acceptsPets: t.bool(),
    accessible: t.bool(),
  },
  (ctx, args) => h.registerShelter(ctx, args)
);

export const setMatch = spacetimedb.reducer(
  { caseId: t.u64(), offerId: t.u64(), note: t.string(), source: t.string() },
  (ctx, args) => h.setMatch(ctx, args)
);

// Scheduled scan --------------------------------------------------------------------------------------

/** Runs every SCAN_INTERVAL_SEC via the scan_schedule table. Scheduled reducers are private in 2.x. */
export const scanForMissing = spacetimedb.reducer({ onSchedule: scanSchedule }, { arg: scanSchedule.rowType }, ctx => {
  const r = h.runScan(ctx);
  if (r.opened || r.resolved) console.info(`scan: opened=${r.opened} refreshed=${r.refreshed} resolved=${r.resolved}`);
});

// Demo controls -------------------------------------------------------------------------------------

export const simulateDisaster = spacetimedb.reducer({ zoneId: t.string(), severity: t.u8() }, (ctx, args) => {
  h.simulateDisaster(ctx, args);
});

export const silenceUsers = spacetimedb.reducer({ zoneId: t.string(), count: t.u32() }, (ctx, args) => {
  h.silenceUsers(ctx, args);
});

export const resetDemo = spacetimedb.reducer(ctx => h.resetDemo(ctx));
