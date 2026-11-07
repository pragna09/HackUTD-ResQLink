import { useEffect, useMemo, useState } from 'react';
import { URGENCY_WEIGHTS, SILENCE_CAP_MIN, SILENCE_THRESHOLD_MIN, MIN_SEVERITY_FOR_SCAN } from '../../../module/src/logic';
import { useApi, useLive } from '../stdb/store';
import type { Alert, Case, Center, Offer, Zone } from '../stdb/types';
import { SourceBadge, Toast, TopBar } from '../ui/Chrome';
import { MapView } from '../ui/MapView';
import { ago, minutesLabel, severityColor, urgencyColor } from '../ui/format';
import { errText, useToast } from '../ui/useToast';

export function Dashboard() {
  const live = useLive();
  const api = useApi();
  const toast = useToast();
  const { data } = live;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  const zone: Zone | undefined = data.zones[0];
  const active = useMemo(
    () => data.cases.filter(c => c.status !== 'resolved').sort((a, b) => b.urgencyScore - a.urgencyScore),
    [data.cases]
  );
  const resolved = useMemo(() => data.cases.filter(c => c.status === 'resolved'), [data.cases]);
  const listed = showResolved ? resolved : active;
  const pings = useMemo(() => [...data.pings.values()], [data.pings]);
  const alertsByCase = useMemo(() => new Map(data.alerts.map(a => [a.caseId, a])), [data.alerts]);
  const selected = data.cases.find(c => c.id === selectedId) ?? null;

  // Keep a sensible selection as the queue changes.
  useEffect(() => {
    if (!selectedId && active[0]) setSelectedId(active[0].id);
  }, [active, selectedId]);

  const counters = {
    flagged: active.length,
    alerted: data.alerts.length,
    acknowledged: data.alerts.filter(a => a.status === 'acknowledged').length,
    sheltered: active.filter(c => c.matchedOffer !== undefined).length,
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
      toast.show(label);
    } catch (e) {
      toast.show(errText(e), true);
    }
  };

  const loading = live.mode === 'spacetimedb' && live.status === 'connecting';
  const offline = live.mode === 'spacetimedb' && live.status === 'error';

  return (
    <div className="dash">
      <TopBar live={live} />

      <div className="dash-strip">
        <Counter cls="flag" n={offline ? null : counters.flagged} label="Flagged" loading={loading} />
        <Counter cls="alert" n={offline ? null : counters.alerted} label={`Alerted · ${counters.acknowledged} ack`} loading={loading} />
        <Counter cls="shelter" n={offline ? null : counters.sheltered} label="Shelter held" loading={loading} />
        <DemoControls zone={zone} run={run} disabled={!zone} />
      </div>

      <main className="dash-main">
        <section className="panel queue" aria-label="Welfare check queue">
          <div className="panel-h">
            <h2>{showResolved ? 'Resolved' : 'Welfare check queue'}</h2>
            <span className="muted small">ranked by urgency</span>
            <div style={{ flex: 1 }} />
            <button className="btn ghost small" onClick={() => setShowResolved(s => !s)} style={{ height: 26, whiteSpace: 'nowrap' }}>
              {showResolved ? `Open ${active.length}` : `Resolved ${resolved.length}`}
            </button>
          </div>
          <Queue
            cases={listed}
            loading={loading}
            offline={offline}
            zone={zone}
            alertsByCase={alertsByCase}
            selectedId={selectedId}
            onSelect={setSelectedId}
            resolvedView={showResolved}
          />
        </section>

        <section className="map-wrap" aria-label="Map">
          <MapView
            zones={data.zones}
            cases={listed}
            pings={pings}
            centers={data.centers}
            offers={data.offers}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
          <div className="legend">
            <div className="row">
              <span className="ramp">
                {[30, 40, 55, 70, 85].map(s => (
                  <i key={s} style={{ background: urgencyColor(s) }} />
                ))}
              </span>
              urgency low → high
            </div>
            <div className="row">
              <i style={{ background: '#2f7d6d', opacity: 0.6, width: 6, height: 6 }} /> heartbeat OK
              <i style={{ background: '#7c818c', width: 6, height: 6, marginLeft: 6 }} /> silent
            </div>
            <div className="row">
              <span className="mk-center" style={{ width: 14, height: 14, lineHeight: '14px', fontSize: 8, borderWidth: 1 }}>F</span> emergency center
              <span className="mk-shelter" style={{ width: 14, height: 14, lineHeight: '14px', fontSize: 8, borderWidth: 1, marginLeft: 6 }}>3</span> shelter spots
            </div>
          </div>
          <div className="map-label">
            <span className="chip">Last known locations · synthetic</span>
          </div>
        </section>

        <div className="col scroll">
          <ZonePanel zone={zone} newsCount={data.news.filter(n => n.area === zone?.id).length} loading={loading} />
          <CaseDetail
            c={selected}
            alert={selected ? alertsByCase.get(selected.id) : undefined}
            center={data.centers.find(x => x.id === selected?.assignedCenter)}
            offer={data.offers.find(o => o.id === selected?.matchedOffer)}
            onAck={id => run('Alert acknowledged', () => api.acknowledgeAlert(id))}
          />
        </div>
      </main>

      <footer className="foot">
        <span>
          <b>Urgency model is tunable, not validated:</b> {URGENCY_WEIGHTS.severity}×(severity/5) + {URGENCY_WEIGHTS.silence}×(min(silent,
          {SILENCE_CAP_MIN})/{SILENCE_CAP_MIN}) + {URGENCY_WEIGHTS.vulnerability}×vulnerable. Computed in a SpacetimeDB reducer.
        </span>
        <span>
          Scans zones of severity ≥ {MIN_SEVERITY_FOR_SCAN}; silent = no heartbeat for {SILENCE_THRESHOLD_MIN}+ min. A dead battery looks the same as
          lost signal.
        </span>
        <span>All people, centers, shelters and news are synthetic. Concept prototype — not affiliated with any insurer.</span>
      </footer>
      <Toast msg={toast.msg} />
    </div>
  );
}

function Counter({ n, label, cls, loading }: { n: number | null; label: string; cls: string; loading: boolean }) {
  return (
    <div className={`panel counter ${cls}`}>
      {loading ? <span className="skeleton" style={{ height: 28, width: 50 }} /> : <span className="n">{n ?? '—'}</span>}
      <span className="l">{label}</span>
    </div>
  );
}

function DemoControls({ zone, run, disabled }: { zone?: Zone; run: (l: string, f: () => Promise<void>) => void; disabled: boolean }) {
  const api = useApi();
  const [sev, setSev] = useState(4);
  const [count, setCount] = useState(15);
  const researching = zone?.researchStatus === 'requested';
  return (
    <div className="panel controls" aria-label="Demo controls">
      <span className="lbl">Demo</span>
      <button
        className="btn primary"
        disabled={disabled || researching}
        onClick={() => zone && run('Weather research requested — the agent worker will pick it up', () => api.requestResearch(zone.id))}
      >
        {researching ? 'Researching…' : 'Run weather research'}
      </button>
      <span style={{ display: 'inline-flex', gap: 4 }}>
        <select aria-label="Simulated severity" value={sev} onChange={e => setSev(Number(e.target.value))}>
          {[3, 4, 5].map(s => (
            <option key={s} value={s}>
              sev {s}
            </option>
          ))}
        </select>
        <button className="btn" disabled={disabled} onClick={() => zone && run(`Simulated severity ${sev} flood`, () => api.simulateDisaster(zone.id, sev))}>
          Simulate disaster
        </button>
      </span>
      <span style={{ display: 'inline-flex', gap: 4 }}>
        <select aria-label="Users to silence" value={count} onChange={e => setCount(Number(e.target.value))}>
          {[5, 15, 30].map(s => (
            <option key={s} value={s}>
              {s} users
            </option>
          ))}
        </select>
        <button className="btn" disabled={disabled} onClick={() => zone && run(`Silenced ${count} synthetic users`, () => api.silenceUsers(zone.id, count))}>
          Silence users
        </button>
      </span>
      <button
        className="btn danger"
        onClick={() => {
          if (confirm('Reset the demo? This clears all cases and alerts and reloads the synthetic dataset.')) run('Demo reset', () => api.resetDemo());
        }}
      >
        Reset
      </button>
    </div>
  );
}

function Queue(props: {
  cases: Case[];
  loading: boolean;
  offline: boolean;
  zone?: Zone;
  alertsByCase: Map<string, Alert>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  resolvedView: boolean;
}) {
  const { cases, loading, zone } = props;
  if (loading)
    return (
      <div className="panel-b" style={{ display: 'grid', gap: 10 }}>
        {[0, 1, 2, 3, 4].map(i => (
          <div key={i} className="skeleton" style={{ height: 54 }} />
        ))}
      </div>
    );
  if (props.offline)
    return (
      <div className="empty">
        <strong>Not connected</strong>The queue fills in live once SpacetimeDB is reachable. See the banner above.
      </div>
    );
  if (cases.length === 0)
    return (
      <div className="empty">
        {props.resolvedView ? (
          <>
            <strong>No resolved cases yet</strong>A case resolves when that person's phone pings again.
          </>
        ) : zone && zone.severity < MIN_SEVERITY_FOR_SCAN ? (
          <>
            <strong>No one flagged</strong>
            {zone.name} is at severity {zone.severity}. Scanning starts at severity {MIN_SEVERITY_FOR_SCAN}. Run weather research or simulate a disaster.
          </>
        ) : (
          <>
            <strong>No silent users</strong>Everyone inside the zone has a recent heartbeat. Try “Silence users”.
          </>
        )}
      </div>
    );
  return (
    <ol className="queue-list">
      {cases.map((c, i) => {
        const a = props.alertsByCase.get(c.id);
        const color = urgencyColor(c.urgencyScore);
        return (
          <li
            key={c.id}
            className={`qrow${c.id === props.selectedId ? ' sel' : ''}`}
            onClick={() => props.onSelect(c.id)}
            onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && props.onSelect(c.id)}
            tabIndex={0}
            aria-selected={c.id === props.selectedId}
          >
            <span className="rank">{i + 1}</span>
            <span className="name">{c.displayName}</span>
            <span className="score" style={{ background: color }}>
              {c.urgencyScore.toFixed(1)}
            </span>
            <span className="bar">
              <span style={{ width: `${c.urgencyScore}%`, background: color }} />
            </span>
            <span className="meta">
              <span className="mono">silent {minutesLabel(c.silentMinutes)}</span>
              {c.vulnerabilityFlag && <span className="chip warn">vulnerable</span>}
              {c.hasPets && <span className="chip">pets</span>}
              {a && <span className={`chip ${a.status === 'acknowledged' ? 'ok' : 'info'}`}>{a.status === 'acknowledged' ? 'ack’d' : 'alert sent'}</span>}
              {c.matchedOffer !== undefined && <span className="chip ok">shelter held</span>}
            </span>
            <span className="why">
              {c.rationale ? (
                <>
                  <SourceBadge source={c.rationaleSource} /> {c.rationale}
                </>
              ) : (
                <span className="muted">Triage agent writing reason…</span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ZonePanel({ zone, newsCount, loading }: { zone?: Zone; newsCount: number; loading: boolean }) {
  return (
    <section className="panel" aria-label="Zone">
      <div className="panel-h">
        <h2>Zone</h2>
        {zone && <SourceBadge source={zone.source} />}
        {zone?.researchStatus === 'requested' && <span className="chip info">agent researching…</span>}
      </div>
      <div className="panel-b">
        {loading ? (
          <div className="skeleton" style={{ height: 90 }} />
        ) : !zone ? (
          <div className="empty">
            <strong>No zone loaded</strong>Press Reset to load the synthetic dataset.
          </div>
        ) : (
          <>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8 }}>{zone.name}</div>
            <dl className="kv">
              <dt>Hazard</dt>
              <dd style={{ textTransform: 'capitalize' }}>{zone.hazard}</dd>
              <dt>Severity</dt>
              <dd>
                <span className="sev" aria-label={`severity ${zone.severity} of 5`}>
                  {[1, 2, 3, 4, 5].map(i => (
                    <i key={i} style={{ background: i <= zone.severity ? severityColor(zone.severity) : undefined }} />
                  ))}
                </span>{' '}
                <span className="mono">{zone.severity}/5</span>
              </dd>
              <dt>Confidence</dt>
              <dd className="mono">{Math.round(zone.confidence * 100)}%</dd>
              <dt>Updated</dt>
              <dd className="muted">
                {ago(zone.updatedAt)} · {newsCount} news items · r {zone.radiusKm} km
              </dd>
            </dl>
            <p className="quote" style={{ marginTop: 10 }}>
              {zone.summary}
            </p>
            {zone.evidence.length > 0 && (
              <ul className="evidence">
                {zone.evidence.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function CaseDetail({ c, alert, center, offer, onAck }: { c: Case | null; alert?: Alert; center?: Center; offer?: Offer; onAck: (id: string) => void }) {
  if (!c)
    return (
      <section className="panel">
        <div className="panel-h">
          <h2>Case</h2>
        </div>
        <div className="empty">
          <strong>No case selected</strong>Pick someone from the queue or click a pin.
        </div>
      </section>
    );
  const parts = [
    { k: 'Severity', v: c.scoreSeverity, max: URGENCY_WEIGHTS.severity, note: `zone ${c.severity}/5` },
    { k: 'Silence', v: c.scoreSilence, max: URGENCY_WEIGHTS.silence, note: minutesLabel(c.silentMinutes) },
    { k: 'Vulnerability', v: c.scoreVulnerability, max: URGENCY_WEIGHTS.vulnerability, note: c.vulnerabilityFlag ? 'flagged' : 'no' },
  ];
  return (
    <section className="panel" aria-label="Case detail">
      <div className="panel-h">
        <h2>Case #{c.id}</h2>
        <span className={`chip ${c.status === 'resolved' ? 'ok' : c.status === 'acknowledged' ? 'info' : 'warn'}`}>{c.status}</span>
      </div>
      <div className="panel-b">
        <div style={{ fontWeight: 700, fontSize: 16 }}>{c.displayName}</div>
        <div className="muted small">
          Last heartbeat {ago(c.lastSeen)} · {c.lastLat.toFixed(4)}, {c.lastLng.toFixed(4)}
        </div>

        <div className="section">
          <h3>Score breakdown</h3>
          <div className="breakdown">
            {parts.map(p => (
              <div className="bd-row" key={p.k}>
                <span>
                  {p.k} <span className="muted">· {p.note}</span>
                </span>
                <span className="track">
                  <span style={{ width: `${(p.v / p.max) * 100}%`, background: urgencyColor(c.urgencyScore) }} />
                </span>
                <span className="v mono">
                  {p.v.toFixed(1)}/{p.max}
                </span>
              </div>
            ))}
            <div className="bd-total">
              <span className="muted small">Weights are a tunable model, not validated.</span>
              <span className="big" style={{ color: urgencyColor(c.urgencyScore) }}>
                {c.urgencyScore.toFixed(1)}
              </span>
            </div>
          </div>
        </div>

        <div className="section">
          <h3>
            Why <SourceBadge source={c.rationaleSource} />
          </h3>
          <p className="quote">{c.rationale || <span className="muted">Waiting for the Triage agent…</span>}</p>
        </div>

        <div className="section">
          <h3>Nearest center &amp; alert</h3>
          {center ? (
            <dl className="kv">
              <dt>Center</dt>
              <dd>
                {center.name} <span className="muted">({center.type})</span>
              </dd>
              <dt>Distance</dt>
              <dd className="mono">{c.centerDistanceKm.toFixed(2)} km (haversine)</dd>
            </dl>
          ) : (
            <p className="muted">No emergency center loaded.</p>
          )}
          {alert && (
            <>
              <p className="quote" style={{ marginTop: 8 }}>
                {alert.message}
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <span className={`chip ${alert.status === 'acknowledged' ? 'ok' : 'info'}`}>welfare check {alert.status}</span>
                <span className="muted small">{ago(alert.at)}</span>
                <div style={{ flex: 1 }} />
                {alert.status !== 'acknowledged' && (
                  <button className="btn" onClick={() => onAck(alert.id)}>
                    Acknowledge
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        <div className="section">
          <h3>
            Shelter {c.matchSource && <SourceBadge source={c.matchSource} />}
          </h3>
          {offer ? (
            <>
              <dl className="kv">
                <dt>Host</dt>
                <dd>{offer.hostName}</dd>
                <dt>Fits</dt>
                <dd>
                  {offer.acceptsPets && <span className="chip">pets ok</span>} {offer.accessible && <span className="chip">accessible</span>}{' '}
                  <span className="muted">{offer.capacity} spots left</span>
                </dd>
              </dl>
              <p className="quote" style={{ marginTop: 8 }}>
                {c.handoffNote}
              </p>
            </>
          ) : (
            <p className="muted">
              {c.status === 'resolved' ? 'Case resolved; any held spot was released.' : 'No shelter matched yet. Code shortlists by distance, capacity, pets and accessibility; the Shelter agent picks and writes the handoff.'}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
