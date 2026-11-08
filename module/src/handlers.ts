// Reducer bodies as plain functions so tests can run them in the SpacetimeDB test harness.
// index.ts wires them to exported reducers.
import { Identity, ScheduleAt, Timestamp } from 'spacetimedb';
import { SenderError } from 'spacetimedb/server';
import type { Ctx } from './schema';
import {
  MIN_SEVERITY_FOR_SCAN,
  SCAN_INTERVAL_SEC,
  SILENCE_THRESHOLD_MIN,
  isInsideZone,
  minutesBetweenMicros,
  nearest,
  urgencyScore,
  welfareCheckMessage,
} from './logic';
import { buildSeedDataset, prng, syntheticIdentityValue } from './seed_data';

const AGE_GROUPS = new Set(['0-17', '18-64', '65+']);
const SOURCES = new Set(['llm', 'fallback']);

const isLat = (v: number) => Number.isFinite(v) && v >= -90 && v <= 90;
const isLng = (v: number) => Number.isFinite(v) && v >= -180 && v <= 180;
const minutesAgo = (ctx: Ctx, minutes: number) =>
  new Timestamp(ctx.timestamp.microsSinceUnixEpoch - BigInt(Math.round(minutes * 60_000_000)));

// ---------------------------------------------------------------------------------------------
// Phone page
// ---------------------------------------------------------------------------------------------

export function updateProfile(
  ctx: Ctx,
  a: { displayName: string; ageGroup: string; vulnerabilityFlag: boolean; hasPets: boolean; optIn: boolean }
) {
  const displayName = a.displayName.trim().slice(0, 60);
  if (!displayName) throw new SenderError('Display name is required');
  if (!AGE_GROUPS.has(a.ageGroup)) throw new SenderError('Age group must be 0-17, 18-64 or 65+');

  const row = {
    identity: ctx.sender,
    displayName,
    ageGroup: a.ageGroup,
    vulnerabilityFlag: a.vulnerabilityFlag,
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
  const centers = [...ctx.db.emergencyCenter.iter()];

  for (const lp of [...ctx.db.locationPing.iter()]) {
    const profile = ctx.db.userProfile.identity.find(lp.user);
    if (!profile || !profile.optIn) continue;

    let active: ReturnType<typeof ctx.db.missingCase.id.find> = null;
    for (const c of ctx.db.missingCase.user.filter(lp.user)) {
      if (c.status !== 'resolved') active = c;
    }

    const silentMinutes = minutesBetweenMicros(now, lp.timestamp.microsSinceUnixEpoch);

    // Heartbeat is back: close the case.
    if (silentMinutes < SILENCE_THRESHOLD_MIN) {
      if (active) {
        ctx.db.missingCase.id.update({
          ...active,
          status: 'resolved',
          silentMinutes,
          updatedAt: ctx.timestamp,
        });
        result.resolved++;
      }
      continue;
    }

    // Highest-severity zone containing the last known position.
    let zoneHit: (typeof zones)[number] | undefined;
    for (const z of zones) {
      if (isInsideZone(lp, z) && (!zoneHit || z.severity > zoneHit.severity)) zoneHit = z;
    }
    const caseZone = zoneHit ?? (active ? zones.find(z => z.id === active.zoneId) : undefined);
    if (!caseZone) continue;
    if (!active && caseZone.severity < MIN_SEVERITY_FOR_SCAN) continue;

    const score = urgencyScore({
      severity: caseZone.severity,
      silentMinutes,
      vulnerable: profile.vulnerabilityFlag,
    });
    const scoreFields = {
      silentMinutes: Math.round(silentMinutes * 10) / 10,
      severity: caseZone.severity,
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

    if (active) {
      ctx.db.missingCase.id.update({ ...active, ...scoreFields, zoneId: caseZone.id, updatedAt: ctx.timestamp });
      result.refreshed++;
      continue;
    }

    const near = nearest(lp, centers);
    const inserted = ctx.db.missingCase.insert({
      id: 0n,
      user: lp.user,
      zoneId: caseZone.id,
      displayName: profile.displayName,
      ...scoreFields,
      rationale: '',
      rationaleSource: '',
      status: 'open',
      assignedCenter: near?.item.id,
      centerDistanceKm: near ? Math.round(near.km * 100) / 100 : -1,
      openedAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
    if (near) {
      ctx.db.alert.insert({
        id: 0n,
        caseId: inserted.id,
        centerId: near.item.id,
        message: welfareCheckMessage({
          displayName: profile.displayName,
          silentMinutes,
          zoneName: caseZone.name,
          centerName: near.item.name,
          centerKm: near.km,
        }),
        status: 'sent',
        timestamp: ctx.timestamp,
      });
    }
    result.opened++;
  }
  return result;
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
