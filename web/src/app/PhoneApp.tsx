import { useEffect, useMemo, useState } from 'react';
import { HEARTBEAT_INTERVAL_SEC } from '../../../module/src/logic';
import { DEMO_ZONE } from '../../../module/src/seed_data';
import { useApi, useLive } from '../stdb/store';
import type { Profile, ProfileInput } from '../stdb/types';
import { Toast, TopBar } from '../ui/Chrome';
import { ago } from '../ui/format';
import { errText, useToast } from '../ui/useToast';
import { useHeartbeat, type Fix } from './heartbeat';

const AGE_GROUPS = ['0-17', '18-64', '65+'] as const;
const PHONE_RE = /^\+?[0-9 ()-]{7,20}$/;
// A fixed point inside the synthetic zone so the flow can be demoed from anywhere.
const DEMO_FIX: Fix = { lat: DEMO_ZONE.centerLat + 0.004, lng: DEMO_ZONE.centerLng - 0.006, accuracy: 25 };

const blank: ProfileInput = {
  displayName: '',
  phone: '',
  ageGroup: '18-64',
  dependentsChildren: 0,
  dependentsElderly: 0,
  needsAccessible: false,
  hasPets: false,
  optIn: false,
};

const fromProfile = (p: Profile): ProfileInput => ({
  displayName: p.displayName,
  phone: p.phone,
  ageGroup: p.ageGroup,
  dependentsChildren: p.dependentsChildren,
  dependentsElderly: p.dependentsElderly,
  needsAccessible: p.needsAccessible,
  hasPets: p.hasPets,
  optIn: p.optIn,
});

export function PhoneApp() {
  const live = useLive();
  const me = live.identity ? live.data.profiles.get(live.identity) : undefined;
  const connecting = live.mode === 'spacetimedb' && live.status === 'connecting';

  return (
    <div style={{ minHeight: '100%' }}>
      <TopBar live={live} />
      <div className="phone-bg">
        <div className="phone">
          {connecting ? (
            <div className="panel card">
              <div className="skeleton" style={{ height: 160 }} />
            </div>
          ) : me ? (
            <Home me={me} />
          ) : (
            <Onboarding />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// First visit: demo sign-in, then household
// ---------------------------------------------------------------------------------------------

function Onboarding() {
  const api = useApi();
  const toast = useToast();
  const [step, setStep] = useState<1 | 2>(1);
  const [form, setForm] = useState<ProfileInput>(blank);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<ProfileInput>) => setForm(f => ({ ...f, ...patch }));

  const nameOk = form.displayName.trim().length > 0;
  const phoneOk = PHONE_RE.test(form.phone.trim());

  const finish = async () => {
    setSaving(true);
    try {
      await api.updateProfile({ ...form, displayName: form.displayName.trim(), phone: form.phone.trim() });
      toast.show(form.optIn ? 'You are signed in. Location sharing is on.' : 'You are signed in.');
    } catch (e) {
      toast.show(errText(e), true);
      setSaving(false);
    }
  };

  return (
    <>
      <div className="steps" aria-label={`Step ${step} of 2`}>
        <span className={step === 1 ? 'on' : 'done'}>1 · Sign in</span>
        <span className={step === 2 ? 'on' : ''}>2 · Your household</span>
      </div>

      {step === 1 ? (
        <section className="panel card" aria-label="Sign in">
          <h1>Sign in</h1>
          <p className="lede">So responders know who to check on if your phone goes quiet during a disaster.</p>
          <div className="field">
            <label htmlFor="dn">Your name</label>
            <input id="dn" className="input" autoFocus value={form.displayName} maxLength={60} onChange={e => set({ displayName: e.target.value })} placeholder="e.g. Maria G." />
          </div>
          <div className="field">
            <label htmlFor="ph">Phone number</label>
            <input id="ph" className="input" type="tel" inputMode="tel" value={form.phone} maxLength={20} onChange={e => set({ phone: e.target.value })} placeholder="e.g. +1 214 555 0100" />
            {form.phone && !phoneOk && <small className="hint bad">Use digits, spaces, + ( ) - (7–20 characters).</small>}
          </div>
          <AgeGroup value={form.ageGroup} onChange={ageGroup => set({ ageGroup })} />
          <button className="btn primary block" disabled={!nameOk || !phoneOk} onClick={() => setStep(2)}>
            Continue
          </button>
          <p className="small muted note">Demo sign-in: the number is not verified. This browser remembers you.</p>
        </section>
      ) : (
        <section className="panel card" aria-label="Your household">
          <h1>Who lives with you?</h1>
          <p className="lede">This helps responders reach the people who need help most first.</p>
          <HouseholdFields form={form} set={set} />
          <div className="field">
            <label className="check">
              <input type="checkbox" checked={form.optIn} onChange={e => set({ optIn: e.target.checked })} />
              <span>
                Share my last known location during a disaster
                <small>Sent every {HEARTBEAT_INTERVAL_SEC}s while this page is open. You can turn it off any time.</small>
              </span>
            </label>
          </div>
          <div className="row-btns">
            <button className="btn" onClick={() => setStep(1)} disabled={saving}>
              Back
            </button>
            <button className="btn primary" style={{ flex: 1 }} onClick={() => void finish()} disabled={saving}>
              {saving ? 'Saving…' : 'Finish'}
            </button>
          </div>
        </section>
      )}
      <Toast msg={toast.msg} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Returning user: heartbeat + editable household
// ---------------------------------------------------------------------------------------------

function Home({ me }: { me: Profile }) {
  const live = useLive();
  const api = useApi();
  const toast = useToast();
  const [form, setForm] = useState<ProfileInput>(() => fromProfile(me));
  const [useDemo, setUseDemo] = useState(false);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<ProfileInput>) => setForm(f => ({ ...f, ...patch }));

  const sharing = me.optIn;
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

  const save = async (patch: Partial<ProfileInput> = {}) => {
    const next = { ...form, ...patch };
    setSaving(true);
    try {
      await api.updateProfile(next);
      setForm(next);
      toast.show(
        'optIn' in patch ? (next.optIn ? 'Location sharing is on.' : 'Location sharing is off and your last location was deleted.') : 'Saved.'
      );
    } catch (e) {
      toast.show(errText(e), true);
    } finally {
      setSaving(false);
    }
  };

  const household = [
    me.dependentsChildren && `${me.dependentsChildren} child${me.dependentsChildren === 1 ? '' : 'ren'}`,
    me.dependentsElderly && `${me.dependentsElderly} elderly`,
    me.hasPets && 'pets',
    me.needsAccessible && 'accessibility needs',
  ].filter(Boolean);

  return (
    <>
      <header className="who">
        <div>
          <div className="small muted">Signed in as</div>
          <div style={{ fontWeight: 700 }}>
            {me.displayName} <span className="muted small">· {me.phone}</span>
          </div>
        </div>
        <button className="btn ghost small" onClick={() => api.signOut()}>
          Sign out
        </button>
      </header>

      {myCase && (
        <div className="panel card" style={{ borderColor: 'var(--u2)', background: 'var(--warn-bg)' }}>
          <b>A welfare check is open for you.</b>
          <div className="small">Your phone went quiet inside an active zone. If you are OK, the next heartbeat closes it automatically.</div>
        </div>
      )}

      <section className="panel card" aria-label="Heartbeat">
        <div className="switch-row">
          <div className="hb">
            <span className={`pulse${!sharing ? ' off' : hb.state.error ? ' bad' : ''}`} aria-hidden />
            <div>
              <div style={{ fontWeight: 700 }}>
                {!sharing ? 'Location sharing is off' : hb.state.sending ? 'Sending heartbeat…' : hb.state.error ? 'Heartbeat problem' : 'Sharing last known location'}
              </div>
              <div className="small muted">
                {!sharing
                  ? 'Nothing is sent until you turn this on.'
                  : hb.state.error
                    ? hb.state.error
                    : hb.state.lastSent
                      ? `Last sent ${ago(hb.state.lastSent)}${hb.state.accuracy ? ` · ±${Math.round(hb.state.accuracy)} m` : ''}${nextIn !== null ? ` · next in ${nextIn}s` : ''}`
                      : `Every ${HEARTBEAT_INTERVAL_SEC}s while this page is open.`}
              </div>
            </div>
          </div>
          <label className="switch">
            <span className="sr-only">Share my last known location</span>
            <input type="checkbox" checked={sharing} disabled={saving} onChange={e => void save({ optIn: e.target.checked })} />
            <span />
          </label>
        </div>
        {sharing && (
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => void hb.sendNow()} disabled={hb.state.sending}>
              Send now
            </button>
            <label className="check" style={{ padding: '6px 10px', flex: 1 }}>
              <input type="checkbox" checked={useDemo} onChange={e => setUseDemo(e.target.checked)} />
              <span className="small">
                Use demo location <small>inside the Dallas demo zone</small>
              </span>
            </label>
          </div>
        )}
      </section>

      <section className="panel card" aria-label="Your household">
        <div style={{ fontWeight: 700, marginBottom: 2 }}>Your household</div>
        <div className="small muted" style={{ marginBottom: 12 }}>
          {household.length ? household.join(' · ') : 'Just you, no pets, no accessibility needs.'}
          {me.vulnerabilityFlag && ' Responders will prioritise you.'}
        </div>
        <HouseholdFields form={form} set={set} />
        <AgeGroup value={form.ageGroup} onChange={ageGroup => set({ ageGroup })} />
        <button className="btn primary block" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <p className="small muted note">Prototype only. Your profile and location live in a demo database visible to the demo dashboard.</p>
      </section>
      <Toast msg={toast.msg} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Shared fields
// ---------------------------------------------------------------------------------------------

function HouseholdFields({ form, set }: { form: ProfileInput; set: (p: Partial<ProfileInput>) => void }) {
  return (
    <>
      <Counter
        label="Children"
        hint="Under 18, living with you"
        value={form.dependentsChildren}
        onChange={dependentsChildren => set({ dependentsChildren })}
      />
      <Counter
        label="Elderly people"
        hint="65+, or anyone who relies on you"
        value={form.dependentsElderly}
        onChange={dependentsElderly => set({ dependentsElderly })}
      />
      <YesNo label="Do you have pets?" value={form.hasPets} onChange={hasPets => set({ hasPets })} />
      <YesNo
        label="Do you have accessibility needs?"
        hint="Wheelchair, mobility, hearing or vision, medical equipment"
        value={form.needsAccessible}
        onChange={needsAccessible => set({ needsAccessible })}
      />
    </>
  );
}

function Counter({ label, hint, value, onChange }: { label: string; hint: string; value: number; onChange: (n: number) => void }) {
  return (
    <div className="field counter-row">
      <div>
        <div className="label">{label}</div>
        <small className="muted">{hint}</small>
      </div>
      <div className="stepper" role="group" aria-label={label}>
        <button type="button" aria-label={`Fewer ${label.toLowerCase()}`} disabled={value <= 0} onClick={() => onChange(value - 1)}>
          −
        </button>
        <output aria-live="polite">{value}</output>
        <button type="button" aria-label={`More ${label.toLowerCase()}`} disabled={value >= 20} onClick={() => onChange(value + 1)}>
          +
        </button>
      </div>
    </div>
  );
}

function YesNo({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="field counter-row">
      <div>
        <div className="label">{label}</div>
        {hint && <small className="muted">{hint}</small>}
      </div>
      <div className="seg small-seg" role="group" aria-label={label}>
        <button type="button" aria-pressed={!value} onClick={() => onChange(false)}>
          No
        </button>
        <button type="button" aria-pressed={value} onClick={() => onChange(true)}>
          Yes
        </button>
      </div>
    </div>
  );
}

function AgeGroup({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <span className="label" id="age-l">
        Your age group
      </span>
      <div className="seg" role="group" aria-labelledby="age-l">
        {AGE_GROUPS.map(g => (
          <button key={g} type="button" aria-pressed={value === g} onClick={() => onChange(g)}>
            {g}
          </button>
        ))}
      </div>
    </div>
  );
}
