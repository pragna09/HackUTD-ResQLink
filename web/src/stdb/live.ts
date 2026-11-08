// Live SpacetimeDB backend. The ONLY web file that uses generated bindings (imported as '@bindings').
// Generate: spacetime generate --lang typescript --out-dir web/src/module_bindings --module-path module
import { DbConnection } from '@bindings';
import type { Api, Backend, LiveState, Snapshot } from './types';
import { emptySnapshot } from './types';

/**
 * SpacetimeDB address. If it points at localhost but the page was opened from another device (a phone on the
 * laptop's hotspot via http://192.168.137.1:5173), use the page's host instead: on a phone, localhost is the phone.
 */
const URI = (() => {
  const configured = import.meta.env.VITE_STDB_URI ?? 'ws://localhost:3000';
  try {
    const u = new URL(configured);
    const pageHost = window.location.hostname;
    const local = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
    if (local(u.hostname) && !local(pageHost)) u.hostname = pageHost;
    return u.toString().replace(/\/$/, '');
  } catch {
    return configured;
  }
})();
const DB = import.meta.env.VITE_STDB_DB ?? 'welfare-check';
const TOKEN_KEY = 'welfare-check.token';

const readToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};
const saveToken = (t: string) => {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* private mode: identity will not persist across reloads */
  }
};

/* eslint-disable @typescript-eslint/no-explicit-any -- generated rows are mapped structurally */
const hex = (id: any): string => id.toHexString();
const date = (ts: any): Date => ts.toDate();

function readSnapshot(conn: any): Snapshot {
  const s = emptySnapshot();
  for (const r of conn.db.userProfile.iter())
    s.profiles.set(hex(r.identity), {
      identity: hex(r.identity),
      displayName: r.displayName,
      ageGroup: r.ageGroup,
      phone: r.phone,
      dependentsChildren: r.dependentsChildren,
      dependentsElderly: r.dependentsElderly,
      needsAccessible: r.needsAccessible,
      vulnerabilityFlag: r.vulnerabilityFlag,
      hasPets: r.hasPets,
      hasWifi: r.hasWifi,
      checkInStatus: r.checkInStatus,
      checkInAt: r.checkInAt ? date(r.checkInAt) : undefined,
      optIn: r.optIn,
      isSynthetic: r.isSynthetic,
      simSilent: r.simSilent,
    });
  for (const r of conn.db.locationPing.iter())
    s.pings.set(hex(r.user), { user: hex(r.user), lat: r.lat, lng: r.lng, accuracy: r.accuracy, at: date(r.timestamp) });
  for (const r of conn.db.zone.iter()) s.zones.push({ ...r, evidence: [...r.evidence], updatedAt: date(r.updatedAt) });
  for (const r of conn.db.newsItem.iter())
    s.news.push({ id: String(r.id), area: r.area, text: r.text, at: date(r.timestamp), isSynthetic: r.isSynthetic });
  for (const r of conn.db.emergencyCenter.iter()) s.centers.push({ ...r });
  for (const r of conn.db.missingCase.iter())
    s.cases.push({
      ...r,
      id: String(r.id),
      user: hex(r.user),
      lastSeen: date(r.lastSeen),
      openedAt: date(r.openedAt),
      assignedCenter: r.assignedCenter ?? undefined,
    });
  for (const r of conn.db.alert.iter())
    s.alerts.push({ id: String(r.id), caseId: String(r.caseId), centerId: r.centerId, message: r.message, status: r.status, at: date(r.timestamp) });
  for (const r of conn.db.meshMessage.iter())
    s.meshMessages.push({
      id: r.id,
      kind: r.kind,
      origin: hex(r.origin),
      displayName: r.displayName,
      createdAt: date(r.createdAt),
      receivedAt: date(r.receivedAt),
      hops: r.hops,
      relayedBy: r.relayedBy,
      path: r.pathLat.map((lat: number, i: number) => [lat, r.pathLng[i]] as [number, number]),
      note: r.note,
      caseId: r.caseId === undefined || r.caseId === null ? undefined : String(r.caseId),
    });
  const cfg = conn.db.agentConfig.id.find(0);
  if (cfg) s.llmProvider = cfg.llmProvider;
  return s;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function createLiveBackend(): Backend {
  const listeners = new Set<() => void>();
  let state: LiveState = { mode: 'spacetimedb', status: 'connecting', data: emptySnapshot(), version: 0 };
  const set = (patch: Partial<LiveState>) => {
    state = { ...state, ...patch, version: state.version + 1 };
    listeners.forEach(l => l());
  };

  if (!DbConnection) {
    set({
      status: 'error',
      error:
        'SpacetimeDB bindings are not generated yet. Run: spacetime generate --lang typescript --out-dir web/src/module_bindings --module-path module — or open this page with ?mock=1 for the offline preview.',
    });
    const reject = () => Promise.reject(new Error('Not connected'));
    const api = new Proxy({}, { get: () => reject }) as Api;
    return { mode: 'spacetimedb', api, subscribe: cb => (listeners.add(cb), () => listeners.delete(cb)), getState: () => state };
  }

  let conn: DbConnection | null = null;
  // Coalesce bursts (the scan touches 200 pings every 30 s) into one render per frame.
  let scheduled = false;
  const refresh = () => {
    if (scheduled || !conn) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (conn) set({ data: readSnapshot(conn) });
    });
  };

  DbConnection.builder()
    .withUri(URI)
    .withDatabaseName(DB)
    .withToken(readToken())
    .withAutomaticReconnect()
    .onConnect((c, identity, token) => {
      conn = c;
      saveToken(token);
      set({ identity: identity.toHexString() });
      const tables = [c.db.userProfile, c.db.locationPing, c.db.zone, c.db.newsItem, c.db.emergencyCenter, c.db.missingCase, c.db.alert, c.db.agentConfig, c.db.meshMessage];
      for (const t of tables as Array<{ onInsert: (cb: () => void) => void; onDelete: (cb: () => void) => void; onUpdate?: (cb: () => void) => void }>) {
        t.onInsert(refresh);
        t.onDelete(refresh);
        t.onUpdate?.(refresh);
      }
      c.subscriptionBuilder()
        .onApplied(() => {
          set({ status: 'live', error: undefined, data: readSnapshot(c) });
        })
        .onError(() => set({ status: 'error', error: 'Subscription failed. Check the module is published and the table names match.' }))
        .subscribe([
          'SELECT * FROM user_profile',
          'SELECT * FROM location_ping',
          'SELECT * FROM zone',
          'SELECT * FROM news_item',
          'SELECT * FROM emergency_center',
          'SELECT * FROM missing_case',
          'SELECT * FROM alert',
          'SELECT * FROM agent_config',
          'SELECT * FROM mesh_message',
        ]);
    })
    .onAutomaticReconnect((_c, identity) => set({ status: 'live', identity: identity.toHexString() }))
    .onConnectError((_c, err) => set({ status: 'error', error: `Cannot reach SpacetimeDB at ${URI} (${DB}): ${err?.message ?? err}` }))
    .onDisconnect(() => set({ status: 'disconnected' }))
    .build();

  const need = () => {
    if (!conn) throw new Error('Not connected to SpacetimeDB yet');
    return conn;
  };

  const api: Api = {
    updateProfile: async a => need().reducers.updateProfile(a),
    respondCheckIn: async a =>
      need().reducers.respondCheckIn({
        status: a.status,
        note: a.note,
        hasLocation: !!a.location,
        lat: a.location?.lat ?? 0,
        lng: a.location?.lng ?? 0,
        accuracy: a.location?.accuracy ?? 0,
      }),
    signOut: () => {
      try {
        localStorage.removeItem(TOKEN_KEY);
      } catch {
        /* storage blocked: nothing to forget */
      }
      window.location.reload();
    },
    ping: async a => need().reducers.ping(a),
    requestResearch: async zoneId => need().reducers.requestResearch({ zoneId }),
    simulateDisaster: async (zoneId, severity) => need().reducers.simulateDisaster({ zoneId, severity }),
    silenceUsers: async (zoneId, count) => need().reducers.silenceUsers({ zoneId, count }),
    resetDemo: async () => need().reducers.resetDemo({}),
    acknowledgeAlert: async alertId => need().reducers.acknowledgeAlert({ alertId: BigInt(alertId) }),
    setLlmProvider: async provider => need().reducers.setLlmProvider({ provider }),
    relayMesh: async payload => need().reducers.relayMeshMessages({ payload }),
  };

  return { mode: 'spacetimedb', api, subscribe: cb => (listeners.add(cb), () => listeners.delete(cb)), getState: () => state };
}
