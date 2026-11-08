// Dashboard mesh demo: builds a phone network around one zone and runs the real mesh routing
// (module/src/mesh.ts) over it. Cell towers inside the zone are assumed down; phones outside still have signal.
// The phones that reach signal are what the gateway uploads to relay_mesh_messages.
import { isInsideZone } from '../../../module/src/logic';
import { simulateMesh, type SimNode, type SimResult } from '../../../module/src/mesh';
import { prng } from '../../../module/src/seed_data';
import type { Ping, Profile, Zone } from '../stdb/types';

/**
 * Assumed phone-to-phone range. Bluetooth LE long range / Wi-Fi Direct can reach ~1 km line of sight; in
 * buildings it is far less. This is a demo assumption, shown on the dashboard, not a measured value.
 */
export const MESH_SIM_RANGE_KM = 1;
/** Bystander phones per km² (people sheltering, in cars, neighbours). Gives ~6 neighbours each at 1 km range. */
const BYSTANDERS_PER_KM2 = 2;

export interface MeshScenario {
  zoneId: string;
  nodes: SimNode[];
  /** Synthetic people inside the zone who send an SOS. */
  senders: Array<{ id: string; name: string }>;
  result: SimResult;
}

const hash = (s: string) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);

export function buildMeshScenario(zone: Zone, profiles: Map<string, Profile>, pings: Map<string, Ping>, nowMs: number): MeshScenario {
  const rand = prng(hash(zone.id));
  const nodes: SimNode[] = [];
  const senders: MeshScenario['senders'] = [];
  const near = (p: { lat: number; lng: number }) => isInsideZone(p, { ...zone, radiusKm: zone.radiusKm * 2.5 });

  // The seeded people of this scenario: inside the zone no signal (they send an SOS), outside signal.
  for (const p of profiles.values()) {
    const lp = pings.get(p.identity);
    if (!p.isSynthetic || !lp || !near(lp)) continue;
    const inside = isInsideZone(lp, zone);
    nodes.push({ id: p.identity, lat: lp.lat, lng: lp.lng, hasSignal: !inside });
    if (inside) senders.push({ id: p.identity, name: p.displayName });
  }

  // Bystander phones spread over the zone and a ring around it. Deterministic per zone.
  const outer = zone.radiusKm * 1.4;
  const count = Math.round(BYSTANDERS_PER_KM2 * Math.PI * outer * outer);
  const kmLat = 110.574;
  const kmLng = 111.32 * Math.cos((zone.centerLat * Math.PI) / 180);
  for (let i = 0; i < count; i++) {
    const r = outer * Math.sqrt(rand());
    const a = rand() * 2 * Math.PI;
    let dLng = (r * Math.sin(a)) / kmLng;
    // Miami's zone sits on Biscayne Bay: keep bystanders on the land side.
    if (zone.id === 'miami-flood' && dLng > 0.01) dLng = -dLng;
    const p = { lat: zone.centerLat + (r * Math.cos(a)) / kmLat, lng: zone.centerLng + dLng };
    nodes.push({ id: `bystander-${i}`, ...p, hasSignal: !isInsideZone(p, zone) });
  }

  const result = simulateMesh(
    nodes,
    senders.map(s => ({ node: s.id, kind: 'sos' as const, displayName: s.name, note: '', createdAtMs: nowMs })),
    { rangeKm: MESH_SIM_RANGE_KM, nowMs, maxRounds: 60 }
  );
  return { zoneId: zone.id, nodes, senders, result };
}
