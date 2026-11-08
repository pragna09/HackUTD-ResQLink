// "Are you safe?" check-in. When the person's last known location is inside a zone at severity >= 3 and their
// phone has signal (connected), ask once per zone update: a browser notification plus an in-app prompt.
// "I'm safe" closes their case; "I need help" opens an SOS case that alerts the nearest responder.
import { useEffect, useMemo, useState } from 'react';
import { MIN_SEVERITY_FOR_SCAN, isInsideZone } from '../../../module/src/logic';
import { useApi, useLive } from '../stdb/store';
import type { Profile } from '../stdb/types';
import { ago } from '../ui/format';
import { errText } from '../ui/useToast';

type Loc = { lat: number; lng: number; accuracy: number };

const notifySupported = () => typeof window !== 'undefined' && 'Notification' in window;

/** Show a system notification. Phones need the service worker; desktop browsers can also use the constructor. */
async function notify(title: string, body: string, tag: string) {
  const options: NotificationOptions = { body, tag, requireInteraction: true, data: { url: '/app' } };
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (reg) return await reg.showNotification(title, options);
  } catch {
    /* fall through to the constructor */
  }
  const n = new Notification(title, options);
  n.onclick = () => {
    window.focus();
    n.close();
  };
}

/** Best current position: the browser's, else the demo fix, else the last heartbeat. */
function currentLocation(fallback: Loc | undefined): Promise<Loc | undefined> {
  if (!('geolocation' in navigator)) return Promise.resolve(fallback);
  return new Promise(resolve =>
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => resolve(fallback),
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 60_000 }
    )
  );
}

export function CheckIn({ me, demoFix, show }: { me: Profile; demoFix: Loc | null; show: (text: string, bad?: boolean) => void }) {
  const live = useLive();
  const api = useApi();
  const [permission, setPermission] = useState(() => (notifySupported() ? Notification.permission : 'denied'));
  const [answering, setAnswering] = useState<'help' | null>(null);
  /** The full prompt is open (after tapping the notification banner). */
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);

  const ping = live.identity ? live.data.pings.get(live.identity) : undefined;
  const zone = useMemo(
    () =>
      ping
        ? live.data.zones.filter(z => z.severity >= MIN_SEVERITY_FOR_SCAN && isInsideZone(ping, z)).sort((a, b) => b.severity - a.severity)[0]
        : undefined,
    [ping, live.data.zones]
  );
  const hasSignal = live.status === 'live' && (typeof navigator === 'undefined' || navigator.onLine);
  // One question per zone update: answering after the zone last changed counts as answered.
  const key = zone ? `${zone.id}@${zone.updatedAt.getTime()}` : null;
  const answered = !!(zone && me.checkInAt && me.checkInAt.getTime() >= zone.updatedAt.getTime());
  const ask = !!zone && hasSignal && !answered && dismissed !== key;

  // System notification, once per zone update, when the person may not be looking at the page.
  useEffect(() => {
    if (!ask || !zone || !key || permission !== 'granted') return;
    const shownKey = `checkin.notified.${key}`;
    try {
      if (sessionStorage.getItem(shownKey)) return;
      sessionStorage.setItem(shownKey, '1');
    } catch {
      /* storage blocked: may notify twice */
    }
    void notify(`Disaster alert: ${zone.name.replace(' (synthetic)', '')}`, 'Are you safe, or do you need help? Tap to answer.', key);
  }, [ask, zone, key, permission]);

  const enableAlerts = async () => {
    if (!notifySupported()) return show('This browser cannot show notifications. The prompt still appears on this screen.', true);
    setPermission(await Notification.requestPermission());
  };

  const answer = async (status: 'safe' | 'help') => {
    setBusy(true);
    try {
      const fallback = demoFix ?? (ping ? { lat: ping.lat, lng: ping.lng, accuracy: ping.accuracy } : undefined);
      const location = demoFix ?? (await currentLocation(fallback));
      await api.respondCheckIn({ status, note: status === 'help' ? note.trim() : '', location });
      show(status === 'safe' ? 'Thanks. You are marked safe.' : 'Help requested. The nearest emergency center has been alerted.');
      setAnswering(null);
      setOpen(false);
      setNote('');
    } catch (e) {
      show(errText(e), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {permission !== 'granted' && notifySupported() && (
        <div className="panel card alert-optin">
          <div>
            <b>Get disaster alerts</b>
            <div className="small muted">We will ask if you are safe when your area becomes a disaster zone.</div>
          </div>
          <button className="btn" onClick={() => void enableAlerts()} disabled={permission === 'denied'}>
            {permission === 'denied' ? 'Blocked in browser' : 'Turn on'}
          </button>
        </div>
      )}

      {permission === 'granted' && (
        <div className="panel card alert-optin">
          <div>
            <b>Disaster alerts are on</b>
            <div className="small muted">Check that this phone shows them before a demo.</div>
          </div>
          <button className="btn" onClick={() => void notify('Test alert', 'Disaster alerts are working on this phone.', 'test')}>
            Test alert
          </button>
        </div>
      )}

      {me.checkInStatus && !ask && (
        <div className={`panel card checkin-status ${me.checkInStatus}`}>
          {me.checkInStatus === 'safe' ? <b>You told responders you are safe</b> : <b>Help requested — responders were alerted</b>}
          <div className="small muted">{me.checkInAt ? ago(me.checkInAt) : ''}</div>
          <div className="row-btns" style={{ marginTop: 8 }}>
            {me.checkInStatus === 'safe' ? (
              <button className="btn danger" onClick={() => setAnswering('help')} disabled={busy}>
                I need help now
              </button>
            ) : (
              <button className="btn" onClick={() => void answer('safe')} disabled={busy}>
                I am safe now
              </button>
            )}
          </div>
        </div>
      )}

      {ask && !open && !answering && zone && (
        <button className="push-banner" onClick={() => setOpen(true)} aria-label="Disaster alert notification: tap to answer">
          <span className="push-icon" aria-hidden>!</span>
          <span className="push-text">
            <span className="push-app">ResQLink · now</span>
            <b>Disaster alert: {zone.name.replace(' (synthetic)', '')}</b>
            <span>Are you safe, or do you need help? Tap to answer.</span>
          </span>
        </button>
      )}

      {((ask && open) || answering) && (
        <div className="checkin-backdrop" role="dialog" aria-modal="true" aria-labelledby="checkin-title">
          <div className="checkin-sheet">
            <span className="chip sos">Disaster alert</span>
            <h2 id="checkin-title">Are you safe?</h2>
            <p className="lede">
              {zone ? `${zone.name.replace(' (synthetic)', '')} is now severity ${zone.severity} of 5. ` : ''}Let responders know how you are.
            </p>
            {answering === 'help' ? (
              <>
                <label className="label" htmlFor="help-note">
                  What do you need? (optional)
                </label>
                <input id="help-note" className="input" autoFocus maxLength={160} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. trapped upstairs, 2 people" />
                <div className="row-btns" style={{ marginTop: 12 }}>
                  <button className="btn" onClick={() => setAnswering(null)} disabled={busy}>
                    Back
                  </button>
                  <button className="btn danger big" style={{ flex: 1 }} onClick={() => void answer('help')} disabled={busy}>
                    {busy ? 'Sending…' : 'Send help request'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <button className="btn safe big" onClick={() => void answer('safe')} disabled={busy}>
                  I'm safe
                </button>
                <button className="btn danger big" onClick={() => setAnswering('help')} disabled={busy}>
                  I need help
                </button>
                {ask && (
                  <button className="btn ghost small" onClick={() => { setDismissed(key); setOpen(false); }} disabled={busy}>
                    Ask me later
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
