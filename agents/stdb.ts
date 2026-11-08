// The ONLY agents file that touches generated SpacetimeDB bindings.
// Generate them with:  spacetime generate --lang typescript --out-dir agents/module_bindings --module-path module
// Until then this file (and only this file) fails typecheck with "Cannot find module './module_bindings'".
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DbConnection } from './module_bindings';
import { AGENTS_DIR, env } from './config';
import type { CaseRow, CenterRow, NewsRow, PersonRow, ZoneRow } from './types';

const TOKEN_FILE = resolve(AGENTS_DIR, '.token');

export interface Stdb {
  zones(): ZoneRow[];
  /** Model picked on the dashboard ('gemini' | 'nvidia'), or undefined before the row exists. */
  llmProvider(): string | undefined;
  news(area: string): NewsRow[];
  cases(): CaseRow[];
  centers(): CenterRow[];
  person(identityHex: string): PersonRow | undefined;
  /** Fires on any insert/update/delete in the named table. */
  onChange(table: 'zone' | 'missing_case' | 'news_item' | 'agent_config' | 'alert', cb: () => void): void;
  upsertZone(a: {
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
  }): Promise<void>;
  setRationale(a: { caseId: bigint; rationale: string; source: string; needs: string[] }): Promise<void>;
  setZoneAdvice(a: { zoneId: string; warning: string; instructions: string[]; source: string }): Promise<void>;
  dispatchCase(a: { caseId: bigint; centerIds: number[]; message: string; source: string }): Promise<void>;
  identityHex: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- generated row types are mapped structurally */
const toZone = (r: any): ZoneRow => ({
  id: r.id,
  name: r.name,
  centerLat: r.centerLat,
  centerLng: r.centerLng,
  radiusKm: r.radiusKm,
  hazard: r.hazard,
  severity: r.severity,
  confidence: r.confidence,
  summary: r.summary,
  evidence: [...r.evidence],
  source: r.source,
  researchStatus: r.researchStatus,
  safetyWarning: r.safetyWarning,
  safetyAdvice: [...r.safetyAdvice],
});
const toNews = (r: any): NewsRow => ({ id: r.id, area: r.area, text: r.text, timestampMs: r.timestamp.toDate().getTime() });
const toCase = (r: any): CaseRow => ({
  id: r.id,
  user: r.user.toHexString(),
  rationaleSource: r.rationaleSource,
  needs: [...r.needs],
  dispatched: r.dispatched,
  zoneId: r.zoneId,
  displayName: r.displayName,
  silentMinutes: r.silentMinutes,
  severity: r.severity,
  vulnerabilityFlag: r.vulnerabilityFlag,
  hasPets: r.hasPets,
  scoreSeverity: r.scoreSeverity,
  scoreSilence: r.scoreSilence,
  scoreVulnerability: r.scoreVulnerability,
  urgencyScore: r.urgencyScore,
  lastLat: r.lastLat,
  lastLng: r.lastLng,
  rationale: r.rationale,
  status: r.status,
  assignedCenter: r.assignedCenter ?? undefined,
  centerDistanceKm: r.centerDistanceKm,
  sos: r.sos,
  sosNote: r.sosNote,
  viaMesh: r.viaMesh,
  meshHops: r.meshHops,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

export function connectStdb(): Promise<Stdb> {
  const savedToken = existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8').trim() : undefined;

  return new Promise((resolvePromise, reject) => {
    let settled = false;
    DbConnection.builder()
      .withUri(env.STDB_URI)
      .withDatabaseName(env.STDB_DB)
      .withToken(savedToken || undefined)
      .withAutomaticReconnect()
      .onConnect((conn, identity, token) => {
        writeFileSync(TOKEN_FILE, token);
        console.log(`[stdb] connected to ${env.STDB_URI}/${env.STDB_DB} as ${identity.toHexString().slice(0, 12)}…`);
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            if (settled) return;
            settled = true;
            resolvePromise(wrap(conn, identity.toHexString()));
          })
          .onError(ctx => console.error('[stdb] subscription error', ctx))
          .subscribe([
            'SELECT * FROM zone',
            'SELECT * FROM news_item',
            'SELECT * FROM missing_case',
            'SELECT * FROM agent_config',
            'SELECT * FROM emergency_center',
            'SELECT * FROM user_profile',
            'SELECT * FROM alert',
          ]);
      })
      .onConnectError((_ctx, err) => {
        if (!settled) {
          settled = true;
          reject(err);
        } else console.error('[stdb] connect error', err);
      })
      .onDisconnect((_ctx, err) => console.warn('[stdb] disconnected', err ?? ''))
      .build();
  });
}

function wrap(conn: DbConnection, identityHex: string): Stdb {
  const listeners: Record<string, Array<() => void>> = {};
  const fire = (t: string) => () => (listeners[t] ?? []).forEach(cb => cb());
  type Hook = (cb: () => void) => void;
  const watch = (t: string, table: { onInsert: Hook; onUpdate?: Hook; onDelete: Hook }) => {
    table.onInsert(fire(t));
    table.onUpdate?.(fire(t));
    table.onDelete(fire(t));
  };
  watch('zone', conn.db.zone);
  watch('news_item', conn.db.newsItem);
  watch('missing_case', conn.db.missingCase);
  watch('agent_config', conn.db.agentConfig);
  watch('alert', conn.db.alert);

  return {
    identityHex,
    zones: () => [...conn.db.zone.iter()].map(toZone),
    llmProvider: () => conn.db.agentConfig.id.find(0)?.llmProvider,
    news: area => [...conn.db.newsItem.iter()].filter(n => n.area === area).map(toNews),
    cases: () => [...conn.db.missingCase.iter()].map(toCase),
    centers: () => [...conn.db.emergencyCenter.iter()].map(c => ({ id: c.id, type: c.type, name: c.name, lat: c.lat, lng: c.lng })),
    person: hex => {
      const p = [...conn.db.userProfile.iter()].find(x => x.identity.toHexString() === hex);
      return p
        ? { ageGroup: p.ageGroup, dependentsChildren: p.dependentsChildren, dependentsElderly: p.dependentsElderly, needsAccessible: p.needsAccessible, hasPets: p.hasPets, hasWifi: p.hasWifi, checkInStatus: p.checkInStatus }
        : undefined;
    },
    onChange: (t, cb) => void (listeners[t] ??= []).push(cb),
    upsertZone: a => conn.reducers.upsertZone(a),
    setRationale: a => conn.reducers.setRationale(a),
    setZoneAdvice: a => conn.reducers.setZoneAdvice(a),
    dispatchCase: a => conn.reducers.dispatchCase(a),
  };
}
