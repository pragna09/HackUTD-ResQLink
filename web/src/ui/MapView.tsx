import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Case, Center, Ping, Zone } from '../stdb/types';
import { severityColor, urgencyColor } from './format';
import type { SimNode } from '../../../module/src/mesh';

/** Simulated phone network drawn during a mesh demo. */
export interface MeshOverlay {
  nodes: SimNode[];
  links: Array<[string, string]>;
  /** Hops that have happened so far. */
  hops: Array<{ from: string; to: string }>;
  /** Phones with signal that uploaded so far. */
  gateways: string[];
}

interface Props {
  zones: Zone[];
  /** Zone the map frames. Re-fits whenever this changes. */
  focusZone?: Zone;
  meshOverlay?: MeshOverlay;
  /** Route the selected case's SOS took over the mesh, origin first. */
  meshPath?: Array<[number, number]>;
  cases: Case[];
  pings: Ping[];
  centers: Center[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** Plain Leaflet inside React: the map is created once; each layer group is redrawn when its data changes. */
export function MapView({ zones, focusZone, meshOverlay, meshPath, cases, pings, centers, selectedId, onSelect }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layers = useRef<Record<string, L.LayerGroup>>({});
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { zoomControl: true, preferCanvas: true }).setView([32.7705, -96.8265], 12);
    L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(m);
    for (const k of ['zones', 'mesh', 'pings', 'centers', 'links', 'meshPath', 'cases']) layers.current[k] = L.layerGroup().addTo(m);
    map.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
    };
  }, []);

  // Frame the focused zone, with room for the no-risk people just outside it, whenever it changes.
  const focusId = focusZone?.id;
  useEffect(() => {
    const z = focusZone;
    if (!map.current || !z) return;
    map.current.fitBounds(L.latLng(z.centerLat, z.centerLng).toBounds(z.radiusKm * 2000 * 2.6));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only refit when the focused zone changes
  }, [focusId]);

  useEffect(() => {
    const g = layers.current.zones;
    if (!g) return;
    g.clearLayers();
    for (const z of zones) {
      const c = severityColor(z.severity);
      L.circle([z.centerLat, z.centerLng], {
        radius: z.radiusKm * 1000,
        color: c,
        weight: 2,
        dashArray: z.severity >= 3 ? undefined : '6 6',
        fillColor: c,
        fillOpacity: z.severity >= 3 ? 0.12 : 0.05,
      })
        .bindTooltip(`${z.name} · severity ${z.severity}/5`)
        .addTo(g);
    }
  }, [zones]);

  useEffect(() => {
    const g = layers.current.pings;
    if (!g) return;
    g.clearLayers();
    const now = Date.now();
    for (const p of pings) {
      const fresh = now - p.at.getTime() < 10 * 60_000;
      L.circleMarker([p.lat, p.lng], {
        radius: 2.5,
        stroke: false,
        fillColor: fresh ? '#2f7d6d' : '#7c818c',
        fillOpacity: fresh ? 0.55 : 0.5,
        interactive: false,
      }).addTo(g);
    }
  }, [pings]);

  useEffect(() => {
    const g = layers.current.centers;
    if (!g) return;
    g.clearLayers();
    for (const c of centers) {
      const letter = c.type === 'hospital' ? 'H' : c.type === 'fire' ? 'F' : c.type === 'insurer' ? 'I' : 'P';
      L.marker([c.lat, c.lng], { icon: L.divIcon({ className: '', html: `<div class="mk-center">${letter}</div>`, iconSize: [20, 20] }) })
        .bindTooltip(`${c.name} (${c.type})`)
        .addTo(g);
    }
  }, [centers]);

  useEffect(() => {
    const g = layers.current.cases;
    const links = layers.current.links;
    if (!g || !links) return;
    g.clearLayers();
    links.clearLayers();
    // Draw low scores first so urgent pins sit on top.
    for (const c of [...cases].sort((a, b) => a.urgencyScore - b.urgencyScore)) {
      const sel = c.id === selectedId;
      const color = urgencyColor(c.urgencyScore);
      const mk = L.circleMarker([c.lastLat, c.lastLng], {
        radius: 5 + c.urgencyScore / 14 + (sel ? 3 : 0),
        color: sel ? '#15171c' : '#fff',
        weight: sel ? 3 : 1.5,
        fillColor: color,
        fillOpacity: 0.95,
      })
        .bindTooltip(`${c.displayName} · ${c.urgencyScore.toFixed(1)}`)
        .on('click', () => onSelectRef.current(c.id))
        .addTo(g);
      if (sel) {
        mk.bringToFront();
        const center = centers.find(x => x.id === c.assignedCenter);
        if (center)
          L.polyline([[c.lastLat, c.lastLng], [center.lat, center.lng]], { color: '#2c5ba8', weight: 2, dashArray: '4 6' }).addTo(links);
      }
    }
  }, [cases, centers, selectedId]);

  useEffect(() => {
    const g = layers.current.mesh;
    if (!g) return;
    g.clearLayers();
    if (!meshOverlay) return;
    const at = new Map(meshOverlay.nodes.map(n => [n.id, n]));
    for (const [a, b] of meshOverlay.links) {
      const p = at.get(a)!;
      const q = at.get(b)!;
      L.polyline([[p.lat, p.lng], [q.lat, q.lng]], { color: '#7c818c', weight: 0.6, opacity: 0.18, interactive: false }).addTo(g);
    }
    for (const n of meshOverlay.nodes) {
      L.circleMarker([n.lat, n.lng], {
        radius: 2.2,
        stroke: false,
        fillColor: n.hasSignal ? '#2c5ba8' : '#7c818c',
        fillOpacity: n.hasSignal ? 0.75 : 0.5,
        interactive: false,
      }).addTo(g);
    }
    for (const h of meshOverlay.hops) {
      const p = at.get(h.from);
      const q = at.get(h.to);
      if (p && q) L.polyline([[p.lat, p.lng], [q.lat, q.lng]], { color: '#c0392b', weight: 2.5, opacity: 0.9, interactive: false }).addTo(g);
    }
    for (const id of new Set(meshOverlay.gateways)) {
      const n = at.get(id);
      if (n) L.circleMarker([n.lat, n.lng], { radius: 7, color: '#2c5ba8', weight: 2.5, fill: false }).bindTooltip('Phone with signal: uploaded the SOS').addTo(g);
    }
  }, [meshOverlay]);

  useEffect(() => {
    const g = layers.current.meshPath;
    if (!g) return;
    g.clearLayers();
    if (!meshPath || meshPath.length < 2) return;
    L.polyline(meshPath, { color: '#c0392b', weight: 3, dashArray: '6 5' }).bindTooltip('SOS route over the mesh').addTo(g);
    meshPath.slice(1).forEach((p, i) =>
      L.circleMarker(p, { radius: i === meshPath.length - 2 ? 5 : 3, color: '#c0392b', weight: 2, fillColor: i === meshPath.length - 2 ? '#2c5ba8' : '#fff', fillOpacity: 1 })
        .bindTooltip(i === meshPath.length - 2 ? 'Phone with signal (uploaded)' : 'Relay phone')
        .addTo(g)
    );
  }, [meshPath]);

  // Focus the selected pin.
  useEffect(() => {
    const c = cases.find(x => x.id === selectedId);
    if (c && map.current) map.current.flyTo([c.lastLat, c.lastLng], Math.max(map.current.getZoom(), 14), { duration: 0.6 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only refocus when the selection changes
  }, [selectedId]);

  return <div ref={el} className="map" role="application" aria-label="Map of last known locations" />;
}
