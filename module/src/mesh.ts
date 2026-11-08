// Phone-to-phone mesh relay (store-and-forward), shared by the module, the dashboard simulator, the mobile
// app and tests. Pure TypeScript, no dependencies, no I/O: a transport (Bluetooth/Wi-Fi via Nearby
// Connections on phones, or the in-browser simulator) moves beacons and messages between nodes.
//
// How a message reaches "the nearest signal":
//   - Every node advertises a beacon {hasSignal, hopsToSignal}. A node with internet has hopsToSignal 0;
//     every other node takes 1 + the smallest value it hears from a neighbour (distance-vector routing).
//   - A node carrying messages forwards each one to the neighbour that is closest to signal (fewest hops).
//     If no neighbour knows a route yet, it floods to every neighbour (epidemic relay), so a message still
//     spreads while routes form.
//   - The first node with signal uploads the message to SpacetimeDB (relay_mesh_messages). The module then
//     opens/updates the case, picks the nearest emergency center and sends the alert, as for any case.
//   - Message ids are de-duplicated at every hop and again in the module, so loops and multiple gateways are safe.
// Limits: unsigned messages (anyone in radio range could forge one), no delivery acknowledgement flooding back
// into the mesh, and real radio range/throughput depend on the hardware. See docs/MESH.md.

export const MESH_PROTOCOL = 'rq1';
/** Maximum relay hops before a message is dropped. */
export const MESH_DEFAULT_TTL = 12;
/** Messages older than this are dropped (they no longer describe the person's situation). */
export const MESH_MAX_AGE_MS = 6 * 60 * 60_000;
/** Messages a node carries at once. Oldest heartbeats are evicted first; SOS messages are kept longest. */
export const MESH_MAX_STORE = 200;
/** hopsToSignal when no route is known. Kept finite so beacons serialise as plain JSON. */
export const NO_ROUTE = 255;
/** A neighbour that has not been heard from for this long is forgotten. */
export const NEIGHBOR_TIMEOUT_MS = 30_000;
const MAX_NAME = 60;
const MAX_NOTE = 160;
const MAX_PATH = MESH_DEFAULT_TTL + 1;

export type MeshKind = 'sos' | 'heartbeat';

export interface MeshHop {
  node: string;
  lat: number;
  lng: number;
}

export interface MeshMessage {
  /** Globally unique: origin + sequence + creation time. */
  id: string;
  kind: MeshKind;
  /** Origin's SpacetimeDB identity as 64 hex chars (phones keep this across offline periods). */
  origin: string;
  displayName: string;
  lat: number;
  lng: number;
  accuracy: number;
  /** When the person's phone created the message (ms since epoch). The module uses this, not the upload time. */
  createdAtMs: number;
  ttl: number;
  /** Nodes the message passed through, origin first. Each receiver appends itself. */
  path: MeshHop[];
  /** Optional short SOS text typed by the person. */
  note: string;
}

export interface MeshBeacon {
  node: string;
  hasSignal: boolean;
  hopsToSignal: number;
}

export interface MeshSend {
  to: string;
  message: MeshMessage;
}

export interface MeshTickResult {
  sends: MeshSend[];
  /** Messages this node should upload now (only when it has signal). */
  uploads: MeshMessage[];
}

export interface MeshNodeOptions {
  id: string;
  lat: number;
  lng: number;
  hasSignal: boolean;
  now?: () => number;
  maxStore?: number;
  maxAgeMs?: number;
}

interface Neighbor {
  beacon: MeshBeacon;
  lastSeenMs: number;
}

/** One phone's mesh state. Call hearBeacon/receive when the transport delivers data, then tick() to decide what to send. */
export class MeshNode {
  readonly id: string;
  lat: number;
  lng: number;
  hasSignal: boolean;
  private readonly now: () => number;
  private readonly maxStore: number;
  private readonly maxAgeMs: number;
  private readonly neighbors = new Map<string, Neighbor>();
  private readonly seen = new Set<string>();
  private readonly store = new Map<string, MeshMessage>();
  private readonly sentTo = new Map<string, Set<string>>();
  private seq = 0;

  constructor(o: MeshNodeOptions) {
    this.id = o.id;
    this.lat = o.lat;
    this.lng = o.lng;
    this.hasSignal = o.hasSignal;
    this.now = o.now ?? Date.now;
    this.maxStore = o.maxStore ?? MESH_MAX_STORE;
    this.maxAgeMs = o.maxAgeMs ?? MESH_MAX_AGE_MS;
  }

  /** 0 with signal; otherwise 1 + the best neighbour, or NO_ROUTE. */
  hopsToSignal(): number {
    if (this.hasSignal) return 0;
    let best = NO_ROUTE;
    for (const n of this.neighbors.values()) best = Math.min(best, n.beacon.hopsToSignal);
    return best >= NO_ROUTE - 1 ? NO_ROUTE : best + 1;
  }

  beacon(): MeshBeacon {
    return { node: this.id, hasSignal: this.hasSignal, hopsToSignal: this.hopsToSignal() };
  }

  hearBeacon(b: MeshBeacon) {
    if (b.node === this.id) return;
    this.neighbors.set(b.node, { beacon: { ...b }, lastSeenMs: this.now() });
  }

  loseNeighbor(node: string) {
    this.neighbors.delete(node);
  }

  neighborIds(): string[] {
    return [...this.neighbors.keys()];
  }

  carried(): MeshMessage[] {
    return [...this.store.values()];
  }

  /** Create a message from this phone (an SOS button press or a heartbeat while offline). */
  originate(input: { kind: MeshKind; displayName: string; accuracy?: number; note?: string; createdAtMs?: number; ttl?: number }): MeshMessage {
    const createdAtMs = input.createdAtMs ?? this.now();
    const msg: MeshMessage = {
      // Tail of the node id: identities that share a prefix (e.g. the synthetic demo range) still get distinct ids.
      id: `${this.id.slice(-20)}-${(this.seq++).toString(36)}-${createdAtMs.toString(36)}`,
      kind: input.kind,
      origin: this.id,
      displayName: input.displayName.slice(0, MAX_NAME),
      lat: this.lat,
      lng: this.lng,
      accuracy: input.accuracy ?? 0,
      createdAtMs,
      ttl: input.ttl ?? MESH_DEFAULT_TTL,
      path: [{ node: this.id, lat: this.lat, lng: this.lng }],
      note: (input.note ?? '').slice(0, MAX_NOTE),
    };
    this.seen.add(msg.id);
    this.keep(msg);
    return msg;
  }

  /** A neighbour handed us a message. Returns false for duplicates, expired or exhausted messages. */
  receive(msg: MeshMessage): boolean {
    if (this.seen.has(msg.id)) return false;
    this.seen.add(msg.id);
    if (this.now() - msg.createdAtMs > this.maxAgeMs) return false;
    if (msg.path.length > msg.ttl || msg.path.length >= MAX_PATH) return false;
    this.keep({ ...msg, path: [...msg.path, { node: this.id, lat: this.lat, lng: this.lng }] });
    return true;
  }

  /** The gateway confirmed these ids reached SpacetimeDB: stop carrying them. */
  delivered(ids: Iterable<string>) {
    for (const id of ids) {
      this.store.delete(id);
      this.sentTo.delete(id);
    }
  }

  /** Decide what to upload (with signal) or forward (without). Idempotent: never sends a message to the same neighbour twice. */
  tick(): MeshTickResult {
    const now = this.now();
    for (const [id, n] of this.neighbors) if (now - n.lastSeenMs > NEIGHBOR_TIMEOUT_MS) this.neighbors.delete(id);
    for (const [id, m] of this.store) if (now - m.createdAtMs > this.maxAgeMs) this.delivered([id]);

    if (this.hasSignal) return { sends: [], uploads: this.carried() };

    const mine = this.hopsToSignal();
    const neighbors = [...this.neighbors.values()].map(n => n.beacon);
    // Neighbours strictly closer to signal, best first. Ties broken by id so every run is deterministic.
    const closer = neighbors
      .filter(b => b.hopsToSignal < mine && b.hopsToSignal < NO_ROUTE)
      .sort((a, b) => a.hopsToSignal - b.hopsToSignal || a.node.localeCompare(b.node));

    const sends: MeshSend[] = [];
    for (const msg of this.prioritised()) {
      if (msg.path.length > msg.ttl) continue;
      const already = this.sentTo.get(msg.id) ?? new Set<string>();
      const onPath = new Set(msg.path.map(h => h.node));
      const fresh = (b: MeshBeacon) => !already.has(b.node) && !onPath.has(b.node);
      // Route toward the nearest signal when one is known; otherwise flood so the message keeps spreading.
      const targets = closer.length > 0 ? closer.filter(fresh).slice(0, 1) : neighbors.filter(fresh);
      for (const t of targets) {
        sends.push({ to: t.node, message: msg });
        already.add(t.node);
      }
      this.sentTo.set(msg.id, already);
    }
    return { sends, uploads: [] };
  }

  private prioritised(): MeshMessage[] {
    return this.carried().sort((a, b) => (a.kind === b.kind ? b.createdAtMs - a.createdAtMs : a.kind === 'sos' ? -1 : 1));
  }

  private keep(msg: MeshMessage) {
    this.store.set(msg.id, msg);
    if (this.store.size <= this.maxStore) return;
    // Evict the oldest heartbeat; only if none is left, the oldest SOS.
    const all = this.carried().sort((a, b) => a.createdAtMs - b.createdAtMs);
    const victim = all.find(m => m.kind === 'heartbeat') ?? all[0];
    this.delivered([victim.id]);
  }
}

// ---------------------------------------------------------------------------------------------
// Wire format (phone <-> phone frames, and the gateway's upload to the module)
// ---------------------------------------------------------------------------------------------

export type MeshFrameBody = { t: 'beacon'; beacon: MeshBeacon } | { t: 'msg'; message: MeshMessage };
export type MeshFrame = MeshFrameBody & { p: typeof MESH_PROTOCOL };

export const encodeFrame = (f: MeshFrameBody): string => JSON.stringify({ p: MESH_PROTOCOL, ...f });

const isNum = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const HEX64 = /^[0-9a-f]{64}$/;

/** Strict validation for anything that came over the air or over the network. Returns null if invalid. */
export function parseMessage(v: unknown): MeshMessage | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, unknown>;
  if (!isStr(m.id, 80) || !m.id) return null;
  if (m.kind !== 'sos' && m.kind !== 'heartbeat') return null;
  if (!isStr(m.origin, 64) || !HEX64.test(m.origin)) return null;
  if (!isStr(m.displayName, MAX_NAME) || !isStr(m.note, MAX_NOTE)) return null;
  if (!isNum(m.lat, -90, 90) || !isNum(m.lng, -180, 180) || !isNum(m.accuracy, 0, 100_000)) return null;
  if (!isNum(m.createdAtMs, 0, 8.64e15) || !isNum(m.ttl, 1, MESH_DEFAULT_TTL)) return null;
  if (!Array.isArray(m.path) || m.path.length < 1 || m.path.length > MAX_PATH) return null;
  const path: MeshHop[] = [];
  for (const h of m.path) {
    const hop = h as Record<string, unknown>;
    if (!hop || !isStr(hop.node, 80) || !isNum(hop.lat, -90, 90) || !isNum(hop.lng, -180, 180)) return null;
    path.push({ node: hop.node, lat: hop.lat, lng: hop.lng });
  }
  if (path[0].node !== m.origin) return null;
  return {
    id: m.id,
    kind: m.kind,
    origin: m.origin,
    displayName: m.displayName,
    lat: m.lat,
    lng: m.lng,
    accuracy: m.accuracy,
    createdAtMs: m.createdAtMs,
    ttl: m.ttl,
    path,
    note: m.note,
  };
}

export function decodeFrame(text: string): MeshFrame | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const f = v as Record<string, unknown>;
  if (!f || f.p !== MESH_PROTOCOL) return null;
  if (f.t === 'msg') {
    const message = parseMessage(f.message);
    return message ? { p: MESH_PROTOCOL, t: 'msg', message } : null;
  }
  if (f.t === 'beacon') {
    const b = f.beacon as Record<string, unknown>;
    if (!b || !isStr(b.node, 80) || typeof b.hasSignal !== 'boolean' || !isNum(b.hopsToSignal, 0, NO_ROUTE)) return null;
    return { p: MESH_PROTOCOL, t: 'beacon', beacon: { node: b.node, hasSignal: b.hasSignal, hopsToSignal: b.hopsToSignal } };
  }
  return null;
}

/** Gateway upload batch (argument of the relay_mesh_messages reducer). */
export const MAX_UPLOAD_BATCH = 100;
export const encodeUpload = (messages: MeshMessage[]): string => JSON.stringify(messages.slice(0, MAX_UPLOAD_BATCH));

export function decodeUpload(text: string): MeshMessage[] | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(v) || v.length > MAX_UPLOAD_BATCH) return null;
  const out: MeshMessage[] = [];
  for (const item of v) {
    const m = parseMessage(item);
    if (!m) return null;
    out.push(m);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Synchronous simulation over a geometric radio graph (dashboard demo + tests)
// ---------------------------------------------------------------------------------------------

export interface SimNode {
  id: string;
  lat: number;
  lng: number;
  hasSignal: boolean;
}

export interface SimRound {
  hops: Array<{ from: string; to: string; messageId: string; kind: MeshKind }>;
  uploads: Array<{ gateway: string; messageId: string }>;
}

export interface SimResult {
  rounds: SimRound[];
  /** Messages that reached a node with signal, as that gateway would upload them (path ends at the gateway). */
  delivered: MeshMessage[];
  undelivered: MeshMessage[];
  /** Undirected radio links (for drawing). */
  links: Array<[string, string]>;
}

const R_KM = 6371.0088;
function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Pairs of nodes within radio range, using a grid so it stays fast for a few thousand nodes. */
export function radioLinks(nodes: SimNode[], rangeKm: number): Array<[string, string]> {
  const cellDeg = rangeKm / 111;
  const grid = new Map<string, SimNode[]>();
  const key = (n: SimNode, dx = 0, dy = 0) => `${Math.floor(n.lat / cellDeg) + dx},${Math.floor(n.lng / cellDeg) + dy}`;
  for (const n of nodes) (grid.get(key(n)) ?? grid.set(key(n), []).get(key(n))!).push(n);
  const links: Array<[string, string]> = [];
  for (const a of nodes) {
    for (let dx = -1; dx <= 1; dx++) {
      // Longitude degrees shrink with latitude; widen the search so no in-range pair is missed.
      const span = Math.ceil(1 / Math.max(0.2, Math.cos((a.lat * Math.PI) / 180)));
      for (let dy = -span; dy <= span; dy++) {
        for (const b of grid.get(key(a, dx, dy)) ?? []) {
          if (a.id < b.id && km(a, b) <= rangeKm) links.push([a.id, b.id]);
        }
      }
    }
  }
  return links;
}

/**
 * Run the real MeshNode logic in lock-step rounds: every round each node hears its neighbours' beacons,
 * then ticks; sends are delivered at the start of the next round. Stops when nothing moves.
 */
export function simulateMesh(
  nodes: SimNode[],
  origins: Array<{ node: string; kind: MeshKind; displayName: string; note?: string; createdAtMs: number }>,
  opts: { rangeKm: number; maxRounds?: number; nowMs: number }
): SimResult {
  const links = radioLinks(nodes, opts.rangeKm);
  const adj = new Map<string, string[]>();
  for (const [a, b] of links) {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  const mesh = new Map(nodes.map(n => [n.id, new MeshNode({ ...n, now: () => opts.nowMs })]));
  const created: MeshMessage[] = [];
  for (const o of origins) {
    const node = mesh.get(o.node);
    if (node) created.push(node.originate({ kind: o.kind, displayName: o.displayName, note: o.note, createdAtMs: o.createdAtMs }));
  }

  const delivered = new Map<string, MeshMessage>();
  const rounds: SimRound[] = [];
  let inFlight: Array<{ from: string; to: string; message: MeshMessage }> = [];
  const maxRounds = opts.maxRounds ?? 40;
  for (let r = 0; r < maxRounds; r++) {
    const round: SimRound = { hops: [], uploads: [] };
    for (const f of inFlight) {
      if (mesh.get(f.to)!.receive(f.message)) round.hops.push({ from: f.from, to: f.to, messageId: f.message.id, kind: f.message.kind });
    }
    inFlight = [];
    // Beacons: two passes per round so hop counts settle quickly on long chains.
    for (let pass = 0; pass < 2; pass++) {
      for (const [id, node] of mesh) for (const nb of adj.get(id) ?? []) mesh.get(nb)!.hearBeacon(node.beacon());
    }
    for (const [id, node] of mesh) {
      const { sends, uploads } = node.tick();
      for (const s of sends) inFlight.push({ from: id, to: s.to, message: s.message });
      for (const u of uploads) {
        if (!delivered.has(u.id)) {
          delivered.set(u.id, u);
          round.uploads.push({ gateway: id, messageId: u.id });
        }
      }
      if (uploads.length) node.delivered(uploads.map(u => u.id));
    }
    rounds.push(round);
    if (inFlight.length === 0 && round.hops.length === 0 && r > 0) break;
  }
  return {
    rounds,
    delivered: [...delivered.values()],
    undelivered: created.filter(m => !delivered.has(m.id)),
    links,
  };
}
