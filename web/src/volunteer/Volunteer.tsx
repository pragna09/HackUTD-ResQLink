import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { DEMO_ZONE } from '../../../module/src/seed_data';
import { useApi, useLive } from '../stdb/store';
import { Toast, TopBar } from '../ui/Chrome';
import { errText, useToast } from '../ui/useToast';

export function Volunteer() {
  const live = useLive();
  const api = useApi();
  const toast = useToast();
  const [hostName, setHostName] = useState('');
  const [capacity, setCapacity] = useState(2);
  const [acceptsPets, setAcceptsPets] = useState(false);
  const [accessible, setAccessible] = useState(false);
  const [pos, setPos] = useState<{ lat: number; lng: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  const mine = live.data.offers.filter(o => o.owner === live.identity);
  const openCount = live.data.offers.filter(o => o.status === 'open').length;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormErr(null);
    if (!hostName.trim()) return setFormErr('Add a host name.');
    if (!pos) return setFormErr('Pick a location on the map or use your current location.');
    setSaving(true);
    try {
      await api.registerShelter({ hostName: hostName.trim(), lat: pos.lat, lng: pos.lng, capacity, acceptsPets, accessible });
      toast.show('Thank you. Your offer is live for matching.');
      setHostName('');
    } catch (err) {
      setFormErr(errText(err));
    } finally {
      setSaving(false);
    }
  };

  const locate = () => {
    if (!('geolocation' in navigator)) return setFormErr('This browser has no geolocation.');
    navigator.geolocation.getCurrentPosition(
      p => setPos({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => setFormErr('Could not read your location. Click the map instead.'),
      { timeout: 15_000 }
    );
  };

  return (
    <div>
      <TopBar live={live} />
      <div className="vol">
        <h1>Offer a safe place to stay</h1>
        <p className="lede">
          Volunteers list spare space. Code shortlists offers by distance, free spots, pets and accessibility; an agent writes the handoff note. A spot is
          only held — never promised — until responders reach the person.
        </p>

        <form className="panel panel-b" style={{ paddingTop: 16 }} onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="hn">Host name</label>
            <input id="hn" className="input" value={hostName} maxLength={80} onChange={e => setHostName(e.target.value)} placeholder="e.g. Hilltop Church hall" />
          </div>
          <div className="field">
            <label htmlFor="cap">Spots available</label>
            <input id="cap" className="input" type="number" min={1} max={50} value={capacity} onChange={e => setCapacity(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} />
          </div>
          <div className="field">
            <label className="check">
              <input type="checkbox" checked={acceptsPets} onChange={e => setAcceptsPets(e.target.checked)} />
              <span>Pets welcome</span>
            </label>
          </div>
          <div className="field">
            <label className="check">
              <input type="checkbox" checked={accessible} onChange={e => setAccessible(e.target.checked)} />
              <span>
                Step-free / accessible <small>Wheelchair access, ground-floor sleeping, accessible bathroom.</small>
              </span>
            </label>
          </div>
          <div className="field">
            <span className="label">Location</span>
            <div className="pick-map">
              <PickMap pos={pos} onPick={setPos} />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button type="button" className="btn" onClick={locate}>
                Use my location
              </button>
              <span className="small muted mono">{pos ? `${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)}` : 'Click the map to set'}</span>
            </div>
          </div>
          {formErr && <p className="err">{formErr}</p>}
          <button className="btn primary" style={{ width: '100%', height: 42 }} disabled={saving || live.status !== 'live'}>
            {saving ? 'Submitting…' : 'Register offer'}
          </button>
        </form>

        <section className="panel">
          <div className="panel-h">
            <h2>Your offers</h2>
            <span className="muted small">{openCount} open offers in the network</span>
          </div>
          <div className="panel-b">
            {live.mode === 'spacetimedb' && live.status === 'connecting' ? (
              <div className="skeleton" style={{ height: 60 }} />
            ) : mine.length === 0 ? (
              <div className="empty">
                <strong>No offers yet</strong>Offers you register from this browser show up here.
              </div>
            ) : (
              <ul className="offer-list">
                {mine.map(o => (
                  <li key={o.id}>
                    <span>
                      <b>{o.hostName}</b>
                      <br />
                      <span className="small muted">
                        {o.acceptsPets ? 'pets ok · ' : ''}
                        {o.accessible ? 'accessible · ' : ''}
                        {o.lat.toFixed(3)}, {o.lng.toFixed(3)}
                      </span>
                    </span>
                    <span className={`chip ${o.status === 'open' ? 'ok' : ''}`}>
                      {o.capacity} left · {o.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
      <Toast msg={toast.msg} />
    </div>
  );
}

function PickMap({ pos, onPick }: { pos: { lat: number; lng: number } | null; onPick: (p: { lat: number; lng: number }) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.CircleMarker | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current).setView([DEMO_ZONE.centerLat, DEMO_ZONE.centerLng], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(m);
    L.circle([DEMO_ZONE.centerLat, DEMO_ZONE.centerLng], { radius: DEMO_ZONE.radiusKm * 1000, color: '#d4471c', weight: 1, fillOpacity: 0.05, interactive: false }).addTo(m);
    m.on('click', e => pick.current({ lat: e.latlng.lat, lng: e.latlng.lng }));
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    if (!map.current) return;
    marker.current?.remove();
    marker.current = pos ? L.circleMarker([pos.lat, pos.lng], { radius: 8, color: '#fff', weight: 2, fillColor: '#2f7d6d', fillOpacity: 1 }).addTo(map.current) : null;
  }, [pos]);

  return <div ref={el} className="map" />;
}
