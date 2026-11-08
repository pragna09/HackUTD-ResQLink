// Tables for the Welfare Check module (SpacetimeDB 2.x TypeScript syntax, checked against spacetimedb@2.14.1).
// Accessor keys and columns are camelCase. With the default SnakeCase policy the SQL names become
// snake_case (missing_case, silent_minutes, ...), which matches the data model in the brief.
import { schema, table, t, type InferSchema, type ReducerCtx } from 'spacetimedb/server';

/** One row per person. Real users key on their connection identity; synthetic users on a fixed fake identity. */
export const userProfile = table(
  { name: 'user_profile', public: true },
  {
    identity: t.identity().primaryKey(),
    displayName: t.string(),
    /** '0-17' | '18-64' | '65+' */
    ageGroup: t.string(),
    vulnerabilityFlag: t.bool(),
    /** Added to the brief's model: the shelter filter needs to know about pets. */
    hasPets: t.bool(),
    optIn: t.bool(),
    isSynthetic: t.bool(),
    /** Synthetic users only: true = simulated phone has gone quiet, so the scan stops refreshing its ping. */
    simSilent: t.bool(),
    updatedAt: t.timestamp(),
  }
);

/** Last known location. Exactly one row per user; every ping overwrites it. */
export const locationPing = table(
  { name: 'location_ping', public: true },
  {
    user: t.identity().primaryKey(),
    lat: t.f64(),
    lng: t.f64(),
    accuracy: t.f64(),
    timestamp: t.timestamp(),
  }
);

export const newsItem = table(
  { name: 'news_item', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    /** Zone id this item is about. */
    area: t.string().index('btree'),
    text: t.string(),
    timestamp: t.timestamp(),
    isSynthetic: t.bool(),
  }
);

export const zone = table(
  { name: 'zone', public: true },
  {
    id: t.string().primaryKey(),
    name: t.string(),
    centerLat: t.f64(),
    centerLng: t.f64(),
    radiusKm: t.f64(),
    hazard: t.string(),
    /** 1–5 */
    severity: t.u8(),
    /** 0–1 */
    confidence: t.f64(),
    summary: t.string(),
    evidence: t.array(t.string()),
    /** 'seed' | 'llm' | 'fallback' | 'simulated' */
    source: t.string(),
    updatedAt: t.timestamp(),
    /** 'idle' | 'requested'. The dashboard button sets 'requested'; the Weather agent clears it. */
    researchStatus: t.string(),
  }
);

export const emergencyCenter = table(
  { name: 'emergency_center', public: true },
  {
    id: t.u32().primaryKey(),
    /** 'police' | 'fire' | 'hospital' */
    type: t.string(),
    name: t.string(),
    lat: t.f64(),
    lng: t.f64(),
    isSynthetic: t.bool(),
  }
);

export const missingCase = table(
  { name: 'missing_case', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    user: t.identity().index('btree'),
    zoneId: t.string(),
    displayName: t.string(),
    silentMinutes: t.f64(),
    // Score inputs + breakdown, all written by the scan reducer.
    severity: t.u8(),
    vulnerabilityFlag: t.bool(),
    hasPets: t.bool(),
    scoreSeverity: t.f64(),
    scoreSilence: t.f64(),
    scoreVulnerability: t.f64(),
    urgencyScore: t.f64(),
    lastLat: t.f64(),
    lastLng: t.f64(),
    lastSeen: t.timestamp(),
    // Triage agent output.
    rationale: t.string(),
    /** '' until written, then 'llm' | 'fallback' */
    rationaleSource: t.string(),
    /** 'open' | 'acknowledged' | 'resolved' */
    status: t.string(),
    assignedCenter: t.option(t.u32()),
    centerDistanceKm: t.f64(),
    // Shelter step output.
    matchedOffer: t.option(t.u64()),
    handoffNote: t.string(),
    /** '' until matched, then 'llm' | 'fallback' */
    matchSource: t.string(),
    openedAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

export const alert = table(
  { name: 'alert', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    caseId: t.u64().index('btree'),
    centerId: t.u32(),
    message: t.string(),
    /** 'sent' | 'acknowledged' */
    status: t.string(),
    timestamp: t.timestamp(),
  }
);

export const shelterOffer = table(
  { name: 'shelter_offer', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    owner: t.identity(),
    hostName: t.string(),
    lat: t.f64(),
    lng: t.f64(),
    /** Remaining spots. Decremented by set_match. */
    capacity: t.u32(),
    acceptsPets: t.bool(),
    accessible: t.bool(),
    /** 'open' | 'full' */
    status: t.string(),
    isSynthetic: t.bool(),
  }
);

/** Private schedule table driving scan_for_missing. */
export const scanSchedule = table(
  { name: 'scan_schedule' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  }
);

const spacetimedb = schema({
  userProfile,
  locationPing,
  newsItem,
  zone,
  emergencyCenter,
  missingCase,
  alert,
  shelterOffer,
  scanSchedule,
});

export default spacetimedb;
export type WelfareSchema = InferSchema<typeof spacetimedb>;
export type Ctx = ReducerCtx<WelfareSchema>;
