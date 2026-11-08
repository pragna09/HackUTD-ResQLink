import { describe, expect, it } from 'vitest';
import {
  MESH_DEFAULT_TTL,
  MeshNode,
  NO_ROUTE,
  decodeFrame,
  decodeUpload,
  encodeFrame,
  encodeUpload,
  parseMessage,
  simulateMesh,
  type SimNode,
} from '../src/mesh';

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const hex = (n: number) => n.toString(16).padStart(64, '0');
const node = (n: number, hasSignal = false, lat = 32.77, lng = -96.79) => new MeshNode({ id: hex(n), lat, lng, hasSignal, now: () => NOW });

describe('MeshNode routing', () => {
  it('computes hops to the nearest signal from neighbour beacons', () => {
    const a = node(1);
    expect(a.hopsToSignal()).toBe(NO_ROUTE);
    a.hearBeacon({ node: hex(2), hasSignal: false, hopsToSignal: 3 });
    a.hearBeacon({ node: hex(3), hasSignal: true, hopsToSignal: 0 });
    expect(a.hopsToSignal()).toBe(1);
    expect(node(9, true).hopsToSignal()).toBe(0);
  });

  it('forwards to the neighbour closest to signal, once', () => {
    const a = node(1);
    a.hearBeacon({ node: hex(2), hasSignal: false, hopsToSignal: 2 });
    a.hearBeacon({ node: hex(3), hasSignal: false, hopsToSignal: 1 });
    a.hearBeacon({ node: hex(4), hasSignal: false, hopsToSignal: NO_ROUTE });
    const m = a.originate({ kind: 'sos', displayName: 'Ana' });
    const first = a.tick().sends;
    expect(first).toEqual([{ to: hex(3), message: m }]);
    // Never the same neighbour twice, and never sideways to a neighbour that is no closer to signal.
    expect(a.tick().sends).toEqual([]);
  });

  it('floods to every neighbour when no route to signal is known yet', () => {
    const a = node(1);
    a.hearBeacon({ node: hex(2), hasSignal: false, hopsToSignal: NO_ROUTE });
    a.hearBeacon({ node: hex(3), hasSignal: false, hopsToSignal: NO_ROUTE });
    a.originate({ kind: 'heartbeat', displayName: 'Ana' });
    expect(a.tick().sends.map(s => s.to).sort()).toEqual([hex(2), hex(3)]);
  });

  it('drops duplicates, appends itself to the path and never sends back along the path', () => {
    const a = node(1);
    const b = node(2);
    const m = a.originate({ kind: 'sos', displayName: 'Ana' });
    expect(b.receive(m)).toBe(true);
    expect(b.receive(m)).toBe(false);
    expect(b.carried()[0].path.map(h => h.node)).toEqual([hex(1), hex(2)]);
    b.hearBeacon({ node: hex(1), hasSignal: false, hopsToSignal: NO_ROUTE });
    expect(b.tick().sends).toEqual([]);
  });

  it('stops relaying after the hop limit and drops stale messages', () => {
    const b = node(2);
    // MESH_DEFAULT_TTL hops already taken (path = origin + TTL relays): one more would exceed the limit.
    const path = Array.from({ length: MESH_DEFAULT_TTL + 1 }, (_, i) => ({ node: hex(100 + i), lat: 0, lng: 0 }));
    const exhausted = { id: 'x1', kind: 'sos' as const, origin: hex(100), displayName: 'A', lat: 0, lng: 0, accuracy: 0, createdAtMs: NOW, ttl: MESH_DEFAULT_TTL, path, note: '' };
    expect(b.receive(exhausted)).toBe(false);
    const stale = { ...exhausted, id: 'x2', path: [path[0]], createdAtMs: NOW - 7 * 3600_000 };
    expect(b.receive(stale)).toBe(false);
  });

  it('a node with signal uploads what it carries and relays nothing', () => {
    const g = node(5, true);
    g.hearBeacon({ node: hex(6), hasSignal: false, hopsToSignal: NO_ROUTE });
    const m = node(1).originate({ kind: 'sos', displayName: 'Ana' });
    g.receive(m);
    const r = g.tick();
    expect(r.sends).toEqual([]);
    expect(r.uploads.map(u => u.id)).toEqual([m.id]);
  });

  it('gives distinct message ids to nodes whose ids share a long prefix', () => {
    const a = new MeshNode({ id: '5e5e' + '0'.repeat(58) + '01', lat: 0, lng: 0, hasSignal: false, now: () => NOW });
    const b = new MeshNode({ id: '5e5e' + '0'.repeat(58) + '02', lat: 0, lng: 0, hasSignal: false, now: () => NOW });
    expect(a.originate({ kind: 'sos', displayName: 'A' }).id).not.toBe(b.originate({ kind: 'sos', displayName: 'B' }).id);
  });

  it('sends SOS messages before heartbeats', () => {
    const a = node(1);
    a.hearBeacon({ node: hex(2), hasSignal: false, hopsToSignal: NO_ROUTE });
    a.originate({ kind: 'heartbeat', displayName: 'Ana' });
    a.originate({ kind: 'sos', displayName: 'Ana' });
    expect(a.tick().sends.map(s => s.message.kind)).toEqual(['sos', 'heartbeat']);
  });
});

describe('wire format', () => {
  const m = node(1).originate({ kind: 'sos', displayName: 'Ana', note: 'leg injured' });

  it('round-trips frames and upload batches', () => {
    expect(decodeFrame(encodeFrame({ t: 'msg', message: m }))).toEqual({ p: 'rq1', t: 'msg', message: m });
    expect(decodeFrame(encodeFrame({ t: 'beacon', beacon: { node: 'n', hasSignal: true, hopsToSignal: 0 } }))?.t).toBe('beacon');
    expect(decodeUpload(encodeUpload([m]))).toEqual([m]);
  });

  it('rejects malformed or forged-looking input', () => {
    expect(decodeFrame('not json')).toBeNull();
    expect(decodeFrame(JSON.stringify({ p: 'other', t: 'msg', message: m }))).toBeNull();
    expect(parseMessage({ ...m, origin: 'not-hex' })).toBeNull();
    expect(parseMessage({ ...m, lat: 999 })).toBeNull();
    expect(parseMessage({ ...m, path: [{ node: hex(7), lat: 0, lng: 0 }] })).toBeNull(); // path must start at the origin
    expect(decodeUpload(JSON.stringify([m, { junk: true }]))).toBeNull();
  });
});

describe('simulateMesh', () => {
  // A line of phones 0.8 km apart heading west out of a dead zone; only the last one has signal.
  const chain: SimNode[] = Array.from({ length: 6 }, (_, i) => ({ id: hex(i + 1), lat: 32.77, lng: -96.79 - i * 0.0086, hasSignal: i === 5 }));

  it('carries an SOS hop by hop to the nearest phone with signal', () => {
    const r = simulateMesh(chain, [{ node: hex(1), kind: 'sos', displayName: 'Ana', createdAtMs: NOW }], { rangeKm: 1, nowMs: NOW });
    expect(r.undelivered).toEqual([]);
    expect(r.delivered).toHaveLength(1);
    const path = r.delivered[0].path.map(h => h.node);
    expect(path[0]).toBe(hex(1));
    expect(path.at(-1)).toBe(hex(6));
    expect(path).toHaveLength(6);
  });

  it('reports messages that cannot reach any signal', () => {
    const isolated = [...chain, { id: hex(99), lat: 33.5, lng: -97.5, hasSignal: false }];
    const r = simulateMesh(isolated, [{ node: hex(99), kind: 'sos', displayName: 'Cut off', createdAtMs: NOW }], { rangeKm: 1, nowMs: NOW });
    expect(r.delivered).toHaveLength(0);
    expect(r.undelivered.map(m => m.origin)).toEqual([hex(99)]);
  });
});
