import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Case, Center, Offer, Ping, Zone } from '../stdb/types';
import { severityColor, urgencyColor } from './format';

interface Props {
  zones: Zone[];
  /** Zone the map frames. Re-fits whenever this changes. */
  focusZone?: Zone;
  cases: Case[];
  pings: Ping[];
  centers: Center[];
  offers: Offer[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** Plain Leaflet inside React: the map is created once; each layer group is redrawn when its data changes. */
export function MapView({ zones, focusZone, cases, pings, centers, offers, selectedId, onSelect }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layers = useRef<Record<string, L.LayerGroup>>({});
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { zoomControl: true, preferCanvas: true }).setView([32.7705, -96.8265], 12);
    L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(m);
    for (const k of ['zones', 'pings', 'centers', 'offers', 'links', 'cases']) layers.current[k] = L.layerGroup().addTo(m);
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
      const letter = c.type === 'hospital' ? 'H' : c.type === 'fire' ? 'F' : 'P';
      L.marker([c.lat, c.lng], { icon: L.divIcon({ className: '', html: `<div class="mk-center">${letter}</div>`, iconSize: [20, 20] }) })
        .bindTooltip(`${c.name} (${c.type})`)
        .addTo(g);
    }
  }, [centers]);

  useEffect(() => {
    const g = layers.current.offers;
    if (!g) return;
    g.clearLayers();
    for (const o of offers) {
      L.marker([o.lat, o.lng], {
        icon: L.divIcon({ className: '', html: `<div class="mk-shelter${o.status === 'full' ? ' full' : ''}">${o.capacity}</div>`, iconSize: [18, 18] }),
      })
        .bindTooltip(`${o.hostName} · ${o.capacity} spots${o.acceptsPets ? ' · pets ok' : ''}${o.accessible ? ' · accessible' : ''}`)
        .addTo(g);
    }
  }, [offers]);

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
        const offer = offers.find(o => o.id === c.matchedOffer);
        if (offer) L.polyline([[c.lastLat, c.lastLng], [offer.lat, offer.lng]], { color: '#2f7d6d', weight: 2, dashArray: '2 5' }).addTo(links);
      }
    }
  }, [cases, centers, offers, selectedId]);

  // Focus the selected pin.
  useEffect(() => {
    const c = cases.find(x => x.id === selectedId);
    if (c && map.current) map.current.flyTo([c.lastLat, c.lastLng], Math.max(map.current.getZoom(), 14), { duration: 0.6 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only refocus when the selection changes
  }, [selectedId]);

  return <div ref={el} className="map" role="application" aria-label="Map of last known locations" />;
}
