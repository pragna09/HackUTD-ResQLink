// Reducer bodies as plain functions so tests can run them in the SpacetimeDB test harness.
// index.ts wires them to exported reducers.
import { Identity, ScheduleAt, Timestamp } from 'spacetimedb';
import { SenderError } from 'spacetimedb/server';
import type { Ctx } from './schema';
import {
  MIN_SEVERITY_FOR_SCAN,
  SCAN_INTERVAL_SEC,
  SILENCE_THRESHOLD_MIN,
  RESPONDER_TYPES,
  isInsideZone,
  isVulnerable,
  meshSosMessage,
  minutesBetweenMicros,
  nearest,
  urgencyScore,
  welfareCheckMessage,
} from './logic';
import { decodeUpload, type MeshMessage } from './mesh';
import { buildSeedDataset, prng, syntheticIdentityValue } from './seed_data';

const AGE_GROUPS = new Set(['0-17', '18-64', '65+']);
const SOURCES = new Set(['llm', 'fallback']);

/** Mesh fields for a location that arrived directly from the phone. */
const DIRECT = { viaMesh: false, meshHops: 0, relayedBy: '' };

const isLat = (v: number) => Number.isFinite(v) && v >= -90 && v <= 90;
const isLng = (v: number) => Number.isFinite(v) && v >= -180 && v <= 180;
const minutesAgo = (ctx: Ctx, minutes: number) =>
  new Timestamp(ctx.timestamp.microsSinceUnixEpoch - BigInt(Math.round(minutes * 60_000_000)));

// ---------------------------------------------------------------------------------------------
// Phone page
// ---------------------------------------------------------------------------------------------

export interface ProfileArgs {
  displayName: string;
  phone: string;
  ageGroup: string;
  dependentsChildren: number;
  dependentsElderly: number;
  needsAccessible: boolean;
  hasPets: boolean;
  optIn: boolean;
}

const PHONE_RE = /^\+?[0-9 ()-]{7,20}$/;
const isCount = (n: number) => Number.isInteger(n) && n >= 0 && n <= 20;

/** Demo sign-in + household profile from the phone screen. The vulnerability flag is derived, never sent. */
export function updateProfile(ctx: Ctx, a: ProfileArgs) {
  const displayName = a.displayName.trim().slice(0, 60);
  if (!displayName) throw new SenderError('Name is required');
  const phone = a.phone.trim();
  if (!PHONE_RE.test(phone)) throw new SenderError('Enter a valid phone number');
  if (!AGE_GROUPS.has(a.ageGroup)) throw new SenderError('Age group must be 0-17, 18-64 or 65+');
  if (!isCount(a.dependentsChildren) || !isCount(a.dependentsElderly)) throw new SenderError('Number of dependents must be 0-20');

  const row = {
    identity: ctx.sender,
    displayName,
    phone,
    ageGroup: a.ageGroup,
    dependentsChildren: a.dependentsChildren,
    dependentsElderly: a.dependentsElderly,
    needsAccessible: a.needsAccessible,
    vulnerabilityFlag: isVulnerable(a),
    hasPets: a.hasPets,
    // The /app form does not ask about Wi-Fi yet; keep any existing value, default to true.
    hasWifi: ctx.db.userProfile.identity.find(ctx.sender)?.hasWifi ?? true,
    optIn: a.optIn,
    isSynthetic: false,
    simSilent: false,
    updatedAt: ctx.timestamp,
  };
  if (ctx.db.userProfile.identity.find(ctx.sender)) ctx.db.userProfile.identity.update(row);
  else ctx.db.userProfile.insert(row);

  // Opting out removes the last known location immediately.
  if (!a.optIn) ctx.db.locationPing.user.delete(ctx.sender);
}

export function ping(ctx: Ctx, a: { lat: number; lng: number; accuracy: number }) {
  const profile = ctx.db.userProfile.identity.find(ctx.sender);
  if (!profile || !profile.optIn) throw new SenderError('Opt in to location sharing before sending a heartbeat');
  if (!isLat(a.lat) || !isLng(a.lng)) throw new SenderError('Invalid coordinates');
  const row = {
    user: ctx.sender,
    lat: a.lat,
    lng: a.lng,
    accuracy: Number.isFinite(a.accuracy) && a.accuracy >= 0 ? a.accuracy : 0,
    timestamp: ctx.timestamp,
    ...DIRECT,
  };
  if (ctx.db.locationPing.user.find(ctx.sender)) ctx.db.locationPing.user.update(row);
  else ctx.db.locationPing.insert(row);
}

// ---------------------------------------------------------------------------------------------
// Zones, news and agents
// ---------------------------------------------------------------------------------------------

export function createNewsItem(ctx: Ctx, a: { area: string; text: string }) {
  const text = a.text.trim().slice(0, 500);
  if (!text) throw new SenderError('News text is required');
  ctx.db.newsItem.insert({ id: 0n, area: a.area, text, timestamp: ctx.timestamp, isSynthetic: false });
}

export function upsertZone(
  ctx: Ctx,
  a: {
    id: string;
    name: string;
    centerLat: number;
    centerLng: number;
    radiusKm: number;
    hazard: string;
    severity: number;
    confidence: number;
    summary: string;
    evidence: string[];
    source: string;
  }
) {
  if (!a.id) throw new SenderError('Zone id is required');
  if (!isLat(a.centerLat) || !isLng(a.centerLng)) throw new SenderError('Invalid zone center');
  if (!(a.radiusKm > 0 && a.radiusKm <= 200)) throw new SenderError('Radius must be between 0 and 200 km');
  if (!Number.isInteger(a.severity) || a.severity < 1 || a.severity > 5) throw new SenderError('Severity must be 1-5');
  if (!(a.confidence >= 0 && a.confidence <= 1)) throw new SenderError('Confidence must be 0-1');
  if (!['llm', 'fallback', 'seed', 'simulated'].includes(a.source)) throw new SenderError('Unknown source');

  const row = {
    id: a.id,
    name: a.name.slice(0, 120),
    centerLat: a.centerLat,
    centerLng: a.centerLng,
    radiusKm: a.radiusKm,
    hazard: a.hazard.slice(0, 60),
    severity: a.severity,
    confidence: a.confidence,
    summary: a.summary.slice(0, 600),
    evidence: a.evidence.slice(0, 8).map(e => e.slice(0, 300)),
    source: a.source,
    updatedAt: ctx.timestamp,
    researchStatus: 'idle',
  };
  if (ctx.db.zone.id.find(a.id)) ctx.db.zone.id.update(row);
  else ctx.db.zone.insert(row);
  // Re-scan right away so a new rating shows up on the dashboard without waiting for the 30 s schedule.
  return runScan(ctx);
}

export function requestResearch(ctx: Ctx, a: { zoneId: string }) {
  const z = ctx.db.zone.id.find(a.zoneId);
  if (!z) throw new SenderError('Unknown zone');
  ctx.db.zone.id.update({ ...z, researchStatus: 'requested' });
}

export function setRationale(ctx: Ctx, a: { caseId: bigint; rationale: string; source: string }) {
  if (!SOURCES.has(a.source)) throw new SenderError('source must be llm or fallback');
  const c = ctx.db.missingCase.id.find(a.caseId);
  if (!c) throw new SenderError('Unknown case');
  // The agent writes text only. Score fields are untouched.
  ctx.db.missingCase.id.update({
    ...c,
    rationale: a.rationale.trim().slice(0, 400),
    rationaleSource: a.source,
    updatedAt: ctx.timestamp,
  });
}

export function acknowledgeAlert(ctx: Ctx, a: { alertId: bigint }) {
  const al = ctx.db.alert.id.find(a.alertId);
  if (!al) throw new SenderError('Unknown alert');
  ctx.db.alert.id.update({ ...al, status: 'acknowledged' });
  const c = ctx.db.missingCase.id.find(al.caseId);
  if (c && c.status === 'open') ctx.db.missingCase.id.update({ ...c, status: 'acknowledged', updatedAt: ctx.timestamp });
}

// ---------------------------------------------------------------------------------------------
// Agent settings (dashboard -> agents worker)
// ---------------------------------------------------------------------------------------------

export const LLM_PROVIDERS = ['gemini', 'nvidia'] as const;
export const DEFAULT_LLM_PROVIDER = 'gemini';
const CONFIG_ID = 0;

/** Dashboard model picker. The agents worker watches agent_config and switches every agent to this provider. */
export function setLlmProvider(ctx: Ctx, a: { provider: string }) {
  if (!(LLM_PROVIDERS as readonly string[]).includes(a.provider)) throw new SenderError('provider must be gemini or nvidia');
  const row = { id: CONFIG_ID, llmProvider: a.provider, updatedAt: ctx.timestamp };
  if (ctx.db.agentConfig.id.find(CONFIG_ID)) ctx.db.agentConfig.id.update(row);
  else ctx.db.agentConfig.insert(row);
}

/** Create the settings row once. reset_demo keeps whatever model the operator picked. */
function ensureAgentConfig(ctx: Ctx) {
  if (!ctx.db.agentConfig.id.find(CONFIG_ID)) {
    ctx.db.agentConfig.insert({ id: CONFIG_ID, llmProvider: DEFAULT_LLM_PROVIDER, updatedAt: ctx.timestamp });
  }
}

// ---------------------------------------------------------------------------------------------
// Scan: silent users in severe zones -> missing cases, urgency score, nearest center, alert
// ---------------------------------------------------------------------------------------------

export interface ScanResult {
  opened: number;
  refreshed: number;
  resolved: number;
}

type Zone = NonNullable<ReturnType<Ctx['db']['zone']['id']['find']>>;
type Profile = NonNullable<ReturnType<Ctx['db']['userProfile']['identity']['find']>>;
type Ping = NonNullable<ReturnType<Ctx['db']['locationPing']['user']['find']>>;
type Case = NonNullable<ReturnType<Ctx['db']['missingCase']['id']['find']>>;

function activeCaseFor(ctx: Ctx, user: Identity): Case | undefined {
  let active: Case | undefined;
  for (const c of ctx.db.missingCase.user.filter(user)) if (c.status !== 'resolved') active = c;
  return active;
}

/** Highest-severity zone containing the point. */
function zoneAt(zones: Zone[], p: { lat: number; lng: number }): Zone | undefined {
  let hit: Zone | undefined;
  for (const z of zones) if (isInsideZone(p, z) && (!hit || z.severity > hit.severity)) hit = z;
  return hit;
}

/** Police, fire and hospital only. */
const responders = (ctx: Ctx) => [...ctx.db.emergencyCenter.iter()].filter(c => (RESPONDER_TYPES as readonly string[]).includes(c.type));

function scoreFields(profile: Profile, lp: Ping, zone: Zone, silentMinutes: number) {
  const score = urgencyScore({ severity: zone.severity, silentMinutes, vulnerable: profile.vulnerabilityFlag });
  return {
    silentMinutes: Math.round(silentMinutes * 10) / 10,
    severity: zone.severity,
    vulnerabilityFlag: profile.vulnerabilityFlag,
    hasPets: profile.hasPets,
    scoreSeverity: score.severityPart,
    scoreSilence: score.silencePart,
    scoreVulnerability: score.vulnerabilityPart,
    urgencyScore: score.total,
    lastLat: lp.lat,
    lastLng: lp.lng,
    lastSeen: lp.timestamp,
  };
}

/** Insert a case, pick the nearest responder with haversine and send its alert. Shared by the scan and the mesh relay. */
function openCase(
  ctx: Ctx,
  a: { profile: Profile; lp: Ping; zone: Zone; silentMinutes: number; sos?: { note: string; minutesAgo: number } }
): Case {
  const near = nearest(a.lp, responders(ctx));
  const inserted = ctx.db.missingCase.insert({
    id: 0n,
    user: a.profile.identity,
    zoneId: a.zone.id,
    displayName: a.profile.displayName,
    ...scoreFields(a.profile, a.lp, a.zone, a.silentMinutes),
    rationale: '',
    rationaleSource: '',
    status: 'open',
    assignedCenter: near?.item.id,
    centerDistanceKm: near ? Math.round(near.km * 100) / 100 : -1,
    sos: !!a.sos,
    sosNote: a.sos?.note ?? '',
    viaMesh: a.lp.viaMesh,
    meshHops: a.lp.meshHops,
    relayedBy: a.lp.relayedBy,
    openedAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
  if (near) {
    ctx.db.alert.insert({
      id: 0n,
      caseId: inserted.id,
      centerId: near.item.id,
      message: a.sos
        ? meshSosMessage({
            displayName: a.profile.displayName,
            minutesAgo: a.sos.minutesAgo,
            hops: a.lp.meshHops,
            relayedBy: a.lp.relayedBy,
            note: a.sos.note,
            zoneName: a.zone.name,
            centerName: near.item.name,
            centerKm: near.km,
          })
        : welfareCheckMessage({
            displayName: a.profile.displayName,
            silentMinutes: a.silentMinutes,
            zoneName: a.zone.name,
            centerName: near.item.name,
            centerKm: near.km,
          }),
      status: 'sent',
      timestamp: ctx.timestamp,
    });
  }
  return inserted;
}

export function runScan(ctx: Ctx): ScanResult {
  const now = ctx.timestamp.microsSinceUnixEpoch;
  const result: ScanResult = { opened: 0, refreshed: 0, resolved: 0 };

  // 1. Simulated phones: synthetic users who are not "silent" keep heartbeating.
  for (const p of [...ctx.db.userProfile.iter()]) {
    if (!p.isSynthetic || p.simSilent) continue;
    const lp = ctx.db.locationPing.user.find(p.identity);
    if (lp) ctx.db.locationPing.user.update({ ...lp, timestamp: ctx.timestamp });
  }

  const zones = [...ctx.db.zone.iter()];

  for (const lp of [...ctx.db.locationPing.iter()]) {
    const profile = ctx.db.userProfile.identity.find(lp.user);
    if (!profile || !profile.optIn) continue;
    const active = activeCaseFor(ctx, lp.user);
    const silentMinutes = minutesBetweenMicros(now, lp.timestamp.microsSinceUnixEpoch);

    // Heartbeat is back: close the case. An SOS stays open until a responder handles it.
    if (silentMinutes < SILENCE_THRESHOLD_MIN) {
      if (active && !active.sos) {
        ctx.db.missingCase.id.update({ ...active, status: 'resolved', silentMinutes, updatedAt: ctx.timestamp });
        result.resolved++;
      }
      continue;
    }

    const caseZone = zoneAt(zones, lp) ?? (active ? zones.find(z => z.id === active.zoneId) : undefined);
    if (!caseZone) continue;
    if (!active && caseZone.severity < MIN_SEVERITY_FOR_SCAN) continue;

    if (active) {
      ctx.db.missingCase.id.update({
        ...active,
        ...scoreFields(profile, lp, caseZone, silentMinutes),
        zoneId: caseZone.id,
        updatedAt: ctx.timestamp,
      });
      result.refreshed++;
      continue;
    }
    openCase(ctx, { profile, lp, zone: caseZone, silentMinutes });
    result.opened++;
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Mesh relay: a phone with signal uploads what it carried for phones without signal
// ---------------------------------------------------------------------------------------------

export interface RelayResult {
  accepted: number;
  duplicates: number;
  sosCases: number;
}

/** Messages older than this are rejected; future timestamps are clamped to now (phone clocks drift). */
const MESH_MAX_AGE_MIN = 24 * 60;
const MESH_CLOCK_SKEW_MIN = 5;

function relayName(ctx: Ctx, node: string): string {
  if (/^[0-9a-f]{64}$/.test(node)) {
    const p = ctx.db.userProfile.identity.find(new Identity(node));
    if (p) return p.displayName;
    return `phone ${node.slice(-6)}`;
  }
  // Mesh node ids that are not account identities (e.g. a phone that never signed in) are shown as-is.
  return `phone ${node.slice(0, 24)}`;
}

/**
 * relay_mesh_messages. `payload` is a JSON array of mesh messages (module/src/mesh.ts, strictly validated).
 *  - Each message id is stored once, so several gateways uploading the same SOS is harmless.
 *  - The location only replaces the stored one if it is newer, and keeps the phone's own timestamp,
 *    so silence is still measured from when the person's phone last spoke.
 *  - An SOS opens a case right away (even below the severity-3 scan threshold), marks an existing case as
 *    SOS, alerts the nearest responder, and is never auto-resolved by later heartbeats.
 */
export function relayMeshMessages(ctx: Ctx, a: { payload: string }): RelayResult {
  const messages = decodeUpload(a.payload);
  if (!messages) throw new SenderError('Invalid mesh payload');
  const nowMicros = ctx.timestamp.microsSinceUnixEpoch;
  const result: RelayResult = { accepted: 0, duplicates: 0, sosCases: 0 };
  const zones = [...ctx.db.zone.iter()];

  // Oldest first, so a later heartbeat from the same person wins.
  for (const m of [...messages].sort((x, y) => x.createdAtMs - y.createdAtMs)) {
    if (ctx.db.meshMessage.id.find(m.id)) {
      result.duplicates++;
      continue;
    }
    let createdMicros = BigInt(Math.round(m.createdAtMs)) * 1000n;
    const ageMin = Number(nowMicros - createdMicros) / 60_000_000;
    if (ageMin > MESH_MAX_AGE_MIN) continue;
    if (ageMin < -MESH_CLOCK_SKEW_MIN || createdMicros > nowMicros) createdMicros = nowMicros;
    const createdAt = new Timestamp(createdMicros);
    const hops = m.path.length - 1;
    const gatewayNode = m.path[m.path.length - 1].node;
    const relayedBy = hops > 0 ? relayName(ctx, gatewayNode) : '';
    const origin = new Identity(m.origin);

    // The person: existing profile, or a minimal one (sending an SOS/heartbeat is consent to be located).
    let profile = ctx.db.userProfile.identity.find(origin);
    if (!profile) {
      profile = ctx.db.userProfile.insert({
        identity: origin,
        displayName: m.displayName.trim() || 'Unknown (mesh)',
        ageGroup: 'unknown',
        vulnerabilityFlag: false,
        phone: '', dependentsChildren: 0, dependentsElderly: 0, needsAccessible: false,
        hasPets: false,
        hasWifi: false,
        optIn: true,
        isSynthetic: false,
        simSilent: false,
        updatedAt: ctx.timestamp,
      });
    }

    const mesh = { viaMesh: hops > 0, meshHops: hops, relayedBy };
    const old = ctx.db.locationPing.user.find(origin);
    let lp: Ping;
    if (!old || old.timestamp.microsSinceUnixEpoch < createdMicros) {
      const row = { user: origin, lat: m.lat, lng: m.lng, accuracy: m.accuracy, timestamp: createdAt, ...mesh };
      lp = old ? ctx.db.locationPing.user.update(row) : ctx.db.locationPing.insert(row);
    } else {
      lp = old;
    }

    let caseId: bigint | undefined;
    if (m.kind === 'sos') {
      const sos = { note: m.note.trim(), minutesAgo: Math.max(0, ageMin) };
      const active = activeCaseFor(ctx, origin);
      if (active) {
        // Mark it SOS and let the Triage agent rewrite the reason with that in mind.
        ctx.db.missingCase.id.update({
          ...active,
          sos: true,
          sosNote: sos.note,
          ...mesh,
          lastLat: m.lat,
          lastLng: m.lng,
          rationale: active.sos ? active.rationale : '',
          rationaleSource: active.sos ? active.rationaleSource : '',
          status: 'open',
          updatedAt: ctx.timestamp,
        });
        caseId = active.id;
      } else {
        const zone = zoneAt(zones, m) ?? nearestZone(zones, m);
        if (zone) {
          const silentMinutes = minutesBetweenMicros(nowMicros, lp.timestamp.microsSinceUnixEpoch);
          caseId = openCase(ctx, { profile, lp: { ...lp, ...mesh }, zone, silentMinutes, sos }).id;
        }
      }
      result.sosCases++;
    }

    ctx.db.meshMessage.insert({
      id: m.id,
      kind: m.kind,
      origin,
      displayName: profile.displayName,
      lat: m.lat,
      lng: m.lng,
      createdAt,
      receivedAt: ctx.timestamp,
      hops,
      gateway: ctx.sender,
      gatewayNode,
      relayedBy,
      pathLat: m.path.map(h => h.lat),
      pathLng: m.path.map(h => h.lng),
      note: m.note,
      caseId,
    });
    result.accepted++;
  }
  return result;
}

/** For an SOS outside every zone: attach it to the nearest zone so it still shows on that zone's queue. */
function nearestZone(zones: Zone[], p: MeshMessage): Zone | undefined {
  return nearest(p, zones.map(z => ({ ...z, lat: z.centerLat, lng: z.centerLng })))?.item;
}

// ---------------------------------------------------------------------------------------------
// Demo controls
// ---------------------------------------------------------------------------------------------

export function simulateDisaster(ctx: Ctx, a: { zoneId: string; severity: number }) {
  const z = ctx.db.zone.id.find(a.zoneId);
  if (!z) throw new SenderError('Unknown zone');
  const severity = Math.min(5, Math.max(1, Math.round(a.severity)));
  ctx.db.zone.id.update({
    ...z,
    severity,
    confidence: 1,
    summary: `DEMO OVERRIDE: an operator simulated a severity ${severity} ${z.hazard}. This is not an agent assessment.`,
    evidence: ['Manual demo override from the dashboard (simulate_disaster).'],
    source: 'simulated',
    updatedAt: ctx.timestamp,
  });
  return runScan(ctx);
}

/** Make `count` currently-active synthetic users in the zone go quiet, with backdated last pings (15–90 min). */
export function silenceUsers(ctx: Ctx, a: { zoneId: string; count: number }) {
  const z = ctx.db.zone.id.find(a.zoneId);
  if (!z) throw new SenderError('Unknown zone');
  const count = Math.min(100, Math.max(1, Math.round(a.count)));

  const candidates = [];
  for (const p of ctx.db.userProfile.iter()) {
    if (!p.isSynthetic || p.simSilent) continue;
    const lp = ctx.db.locationPing.user.find(p.identity);
    if (lp && isInsideZone(lp, z)) candidates.push({ p, lp });
  }
  const rand = prng(Number(ctx.timestamp.microsSinceUnixEpoch % 2_147_483_647n));
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  for (const { p, lp } of candidates.slice(0, count)) {
    ctx.db.userProfile.identity.update({ ...p, simSilent: true, updatedAt: ctx.timestamp });
    ctx.db.locationPing.user.update({ ...lp, timestamp: minutesAgo(ctx, 15 + rand() * 75) });
  }
  return runScan(ctx);
}

/** Wipe demo state and reload the synthetic dataset. Real /app users keep their profile and last ping. */
export function resetDemo(ctx: Ctx) {
  for (const id of [...ctx.db.alert.iter()].map(r => r.id)) ctx.db.alert.id.delete(id);
  for (const id of [...ctx.db.missingCase.iter()].map(r => r.id)) ctx.db.missingCase.id.delete(id);
  for (const id of [...ctx.db.meshMessage.iter()].map(r => r.id)) ctx.db.meshMessage.id.delete(id);
  for (const id of [...ctx.db.newsItem.iter()].map(r => r.id)) ctx.db.newsItem.id.delete(id);
  for (const id of [...ctx.db.zone.iter()].map(r => r.id)) ctx.db.zone.id.delete(id);
  for (const id of [...ctx.db.emergencyCenter.iter()].map(r => r.id)) ctx.db.emergencyCenter.id.delete(id);
  for (const p of [...ctx.db.userProfile.iter()]) {
    if (!p.isSynthetic) continue;
    ctx.db.locationPing.user.delete(p.identity);
    ctx.db.userProfile.identity.delete(p.identity);
  }
  loadSeed(ctx);
}

export function loadSeed(ctx: Ctx) {
  const data = buildSeedDataset();
  for (const { city: _city, ...z } of data.zones) {
    ctx.db.zone.insert({
      ...z,
      severity: 1,
      confidence: 0,
      summary: 'Not assessed yet. Run weather research or simulate a disaster.',
      evidence: [],
      source: 'seed',
      updatedAt: ctx.timestamp,
      researchStatus: 'idle',
    });
  }
  for (const n of data.news) {
    ctx.db.newsItem.insert({ id: 0n, area: n.area, text: n.text, timestamp: minutesAgo(ctx, n.minutesAgo), isSynthetic: true });
  }
  for (const c of data.centers) ctx.db.emergencyCenter.insert({ ...c, isSynthetic: true });
  for (const u of data.users) {
    const identity = new Identity(syntheticIdentityValue(u.index));
    ctx.db.userProfile.insert({
      identity,
      displayName: u.displayName,
      ageGroup: u.ageGroup,
      vulnerabilityFlag: u.vulnerabilityFlag,
      // Synthetic high-risk people are marked as needing accessibility support so their flag matches the rule.
      phone: '', dependentsChildren: 0, dependentsElderly: 0, needsAccessible: u.vulnerabilityFlag,
      hasPets: u.hasPets,
      hasWifi: u.hasWifi,
      optIn: true,
      isSynthetic: true,
      simSilent: u.silent,
      updatedAt: ctx.timestamp,
    });
    ctx.db.locationPing.insert({
      user: identity,
      lat: u.lat,
      lng: u.lng,
      accuracy: u.accuracy,
      timestamp: minutesAgo(ctx, u.minutesAgo),
      ...DIRECT,
    });
  }
  ensureSchedule(ctx);
  ensureAgentConfig(ctx);
}

export function ensureSchedule(ctx: Ctx) {
  if (ctx.db.scanSchedule.count() > 0n) return;
  ctx.db.scanSchedule.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.interval(BigInt(SCAN_INTERVAL_SEC) * 1_000_000n),
  });
}
