import { useEffect, useMemo, useState } from 'react';
import { HEARTBEAT_INTERVAL_SEC } from '../../../module/src/logic';
import { DEMO_ZONE } from '../../../module/src/seed_data';
import { useApi, useLive } from '../stdb/store';
import { StatusBanner, Toast } from '../ui/Chrome';
import { ago } from '../ui/format';
import { errText, useToast } from '../ui/useToast';
import { useHeartbeat, type Fix } from './heartbeat';

const AGE_GROUPS = ['0-17', '18-64', '65+'] as const;
// A fixed point inside the synthetic zone so the flow can be demoed from anywhere.
const DEMO_FIX: Fix = { lat: DEMO_ZONE.centerLat + 0.004, lng: DEMO_ZONE.centerLng - 0.006, accuracy: 25 };

export function PhoneApp() {
  const live = useLive();
  const api = useApi();
  const toast = useToast();
  const me = live.identity ? live.data.profiles.get(live.identity) : undefined;

  const [displayName, setDisplayName] = useState('');
  const [ageGroup, setAgeGroup] = useState<string>('18-64');
  const [vulnerable, setVulnerable] = useState(false);
  const [hasPets, setHasPets] = useState(false);
  const [optIn, setOptIn] = useState(false);
  const [useDemo, setUseDemo] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Prefill once from the stored profile.
  useEffect(() => {
    if (me && !loaded) {
      setDisplayName(me.displayName);
      setAgeGroup(me.ageGroup);
      setVulnerable(me.vulnerabilityFlag);
      setHasPets(me.hasPets);
      setOptIn(me.optIn);
      setLoaded(true);
    }
  }, [me, loaded]);

  const sharing = !!me?.optIn;
  const hb = useHeartbeat(api, sharing && live.status === 'live', useDemo ? DEMO_FIX : null);
  const myCase = useMemo(
    () => live.data.cases.find(c => c.user === live.identity && c.status !== 'resolved'),
    [live.data.cases, live.identity]
  );

  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick(t => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const nextIn = hb.state.nextAt ? Math.max(0, Math.round((hb.state.nextAt.getTime() - Date.now()) / 1000)) : null;

  const save = async (nextOptIn = optIn) => {
    if (!displayName.trim()) {
      toast.show('Add a display name first.', true);
      return;
    }
    setSaving(true);
    try {
      await api.updateProfile({ displayName: displayName.trim(), ageGroup, vulnerabilityFlag: vulnerable, hasPets, optIn: nextOptIn });
      setOptIn(nextOptIn);
      toast.show(nextOptIn ? 'Saved. Location sharing is on.' : 'Saved. Location sharing is off and your last location was deleted.');
    } catch (e) {
      toast.show(errText(e), true);
    } finally {
      setSaving(false);
    }
  };

  const connecting = live.mode === 'spacetimedb' && live.status === 'connecting';

  return (
    <div style={{ minHeight: '100%' }}>
      <StatusBanner live={live} />
      <div className="phone-bg">
        <div className="phone">
          <header>
            <a className="brand" href="/" style={{ color: 'var(--ink)' }}>
              <span className="brand-mark" style={{ borderColor: 'var(--ink)' }} aria-hidden /> Welfare Check
            </a>
            <span className="pill" style={{ color: '#8a5a00' }}>
              Concept prototype
            </span>
          </header>
          <h1>Let responders know where you were last.</h1>
          <p className="lede">
            A concept module for an insurer’s mobile app. When a disaster hits your area and your phone goes quiet, responders get a{' '}
            <b>welfare check</b> request with your last known location. Silence is not treated as an emergency — a dead battery looks the same as lost
            signal.
          </p>

          {myCase && (
            <div className="panel card" style={{ borderColor: 'var(--u2)', background: 'var(--warn-bg)' }}>
              <b>A welfare check is open for you.</b>
              <div className="small">Your heartbeat went quiet inside an active zone. If you are OK, the next heartbeat closes it automatically.</div>
            </div>
          )}

          <section className="panel card" aria-label="Heartbeat">
            {connecting ? (
              <div className="skeleton" style={{ height: 44 }} />
            ) : (
              <div className="hb">
                <span className={`pulse${!sharing ? ' off' : hb.state.error ? ' bad' : ''}`} aria-hidden />
                <div>
                  <div style={{ fontWeight: 700 }}>
                    {!sharing ? 'Location sharing is off' : hb.state.sending ? 'Sending heartbeat…' : hb.state.error ? 'Heartbeat problem' : 'Sharing last known location'}
                  </div>
                  <div className="small muted">
                    {!sharing
                      ? 'Nothing is sent until you opt in below.'
                      : hb.state.error
                        ? hb.state.error
                        : hb.state.lastSent
                          ? `Last sent ${ago(hb.state.lastSent)}${hb.state.accuracy ? ` · ±${Math.round(hb.state.accuracy)} m` : ''}${nextIn !== null ? ` · next in ${nextIn}s` : ''}`
                          : `Every ${HEARTBEAT_INTERVAL_SEC}s while this page is open.`}
                  </div>
                </div>
              </div>
            )}
            {sharing && (
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                <button className="btn" onClick={() => void hb.sendNow()} disabled={hb.state.sending}>
                  Send now
                </button>
                <label className="check" style={{ padding: '6px 10px', flex: 1 }}>
                  <input type="checkbox" checked={useDemo} onChange={e => setUseDemo(e.target.checked)} />
                  <span className="small">
                    Use demo location <small>inside the synthetic flood zone</small>
                  </span>
                </label>
              </div>
            )}
          </section>

          <section className="panel card" aria-label="Profile">
            <div className="switch-row" style={{ marginBottom: 14 }}>
              <div>
                <div style={{ fontWeight: 700 }}>Share my last known location</div>
                <div className="small muted">Opt in. Each ping overwrites the previous one. Turning this off deletes it.</div>
              </div>
              <label className="switch">
                <span className="sr-only">Share my last known location</span>
                <input type="checkbox" checked={optIn} disabled={saving || connecting} onChange={e => void save(e.target.checked)} />
                <span />
              </label>
            </div>

            <div className="field">
              <label htmlFor="dn">Display name</label>
              <input id="dn" className="input" value={displayName} maxLength={60} onChange={e => setDisplayName(e.target.value)} placeholder="e.g. Maria G." />
            </div>
            <div className="field">
              <span className="label" id="age-l">
                Age group
              </span>
              <div className="seg" role="group" aria-labelledby="age-l">
                {AGE_GROUPS.map(g => (
                  <button key={g} type="button" aria-pressed={ageGroup === g} onClick={() => setAgeGroup(g)}>
                    {g}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label className="check">
                <input type="checkbox" checked={vulnerable} onChange={e => setVulnerable(e.target.checked)} />
                <span>
                  I may need extra help
                  <small>Mobility, medical equipment, or caring for someone. Raises your priority if you go quiet.</small>
                </span>
              </label>
            </div>
            <div className="field">
              <label className="check">
                <input type="checkbox" checked={hasPets} onChange={e => setHasPets(e.target.checked)} />
                <span>
                  I have pets <small>So responders know to expect animals.</small>
                </span>
              </label>
            </div>
            <button className="btn primary" style={{ width: '100%', height: 42 }} disabled={saving || connecting} onClick={() => void save()}>
              {saving ? 'Saving…' : me ? 'Save profile' : 'Save profile'}
            </button>
            <p className="small muted" style={{ marginBottom: 0 }}>
              Prototype only. Profile and location live in a demo database visible to the demo dashboard.
            </p>
          </section>
        </div>
      </div>
      <Toast msg={toast.msg} />
    </div>
  );
}
