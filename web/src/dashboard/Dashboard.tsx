import { useEffect, useMemo, useState } from 'react';
import { URGENCY_WEIGHTS, SILENCE_CAP_MIN, SILENCE_THRESHOLD_MIN, MIN_SEVERITY_FOR_SCAN } from '../../../module/src/logic';
import { DEMO_ZONE, ZONES } from '../../../module/src/seed_data';
import { encodeUpload } from '../../../module/src/mesh';
import { MESH_SIM_RANGE_KM, buildMeshScenario, type MeshScenario } from './meshSim';
import { useApi, useLive } from '../stdb/store';
import type { Alert, Case, Center, Profile, Zone } from '../stdb/types';
import { SourceBadge, Toast, TopBar } from '../ui/Chrome';
import { MapView, type MeshOverlay } from '../ui/MapView';
import { ago, minutesLabel, severityColor, urgencyColor } from '../ui/format';
import { errText, useToast } from '../ui/useToast';

export function Dashboard() {
  const live = useLive();
  const api = useApi();
  const toast = useToast();
  const { data } = live;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  // The dashboard shows one scenario at a time; "Simulate disaster" switches to the chosen zone.
  const [zoneId, setZoneId] = useState<string>(DEMO_ZONE.id);
  const zone: Zone | undefined = data.zones.find(z => z.id === zoneId) ?? data.zones[0];
  const zoneCases = useMemo(() => data.cases.filter(c => c.zoneId === zone?.id), [data.cases, zone?.id]);
  const active = useMemo(
    () => zoneCases.filter(c => c.status !== 'resolved').sort((a, b) => Number(b.sos) - Number(a.sos) || b.urgencyScore - a.urgencyScore),
    [zoneCases]
  );
  const resolved = useMemo(() => zoneCases.filter(c => c.status === 'resolved'), [zoneCases]);
  const zoneAlerts = useMemo(() => {
    const ids = new Set(zoneCases.map(c => c.id));
    return data.alerts.filter(a => ids.has(a.caseId));
  }, [data.alerts, zoneCases]);
  const showZone = (id: string) => {
    setZoneId(id);
    setSelectedId(null);
    setMesh(null);
  };
  const listed = showResolved ? resolved : active;
  const pings = useMemo(() => [...data.pings.values()], [data.pings]);
  const alertsByCase = useMemo(() => new Map(data.alerts.map(a => [a.caseId, a])), [data.alerts]);
  const selected = zoneCases.find(c => c.id === selectedId) ?? null;

  // Keep a sensible selection as the queue changes.
  useEffect(() => {
    if (!selectedId && active[0]) setSelectedId(active[0].id);
  }, [active, selectedId]);

  const counters = {
    sos: active.filter(c => c.sos).length,
    flagged: active.length,
    alerted: zoneAlerts.length,
    acknowledged: zoneAlerts.filter(a => a.status === 'acknowledged').length,
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
      toast.show(label);
    } catch (e) {
      toast.show(errText(e), true);
    }
  };

  // ---- Mesh demo: run the real routing over a simulated phone network, animate it, then upload as the gateway would.
  const [mesh, setMesh] = useState<{ scenario: MeshScenario; step: number; uploaded: boolean } | null>(null);
  const startMesh = () => {
    if (!zone) return;
    setMesh({ scenario: buildMeshScenario(zone, data.profiles, data.pings, Date.now()), step: 0, uploaded: false });
  };
  useEffect(() => {
    if (!mesh) return;
    const { rounds, delivered } = mesh.scenario.result;
    if (mesh.step < rounds.length) {
      const t = setTimeout(() => setMesh(m => (m && m.scenario === mesh.scenario ? { ...m, step: m.step + 1 } : m)), 450);
      return () => clearTimeout(t);
    }
    if (mesh.uploaded) return;
    setMesh(m => (m ? { ...m, uploaded: true } : m));
    const total = mesh.scenario.senders.length;
    if (delivered.length === 0) toast.show(`Mesh: none of ${total} SOS messages reached a phone with signal`, true);
    else void run(`Mesh delivered ${delivered.length} of ${total} SOS messages to phones with signal`, () => api.relayMesh(encodeUpload(delivered)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- advance only when the step changes
  }, [mesh?.step, mesh?.uploaded, mesh?.scenario]);
  const meshOverlay: MeshOverlay | undefined = useMemo(() => {
    if (!mesh || mesh.scenario.zoneId !== zone?.id) return undefined;
    const shown = mesh.scenario.result.rounds.slice(0, mesh.step);
    return {
      nodes: mesh.scenario.nodes,
      links: mesh.scenario.result.links,
      hops: shown.flatMap(r => r.hops),
      gateways: shown.flatMap(r => r.uploads.map(u => u.gateway)),
    };
  }, [mesh, zone?.id]);
  const meshPath = useMemo(() => {
    const rows = data.meshMessages.filter(m => m.caseId !== undefined && m.caseId === selectedId);
    return rows.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())[0]?.path;
  }, [data.meshMessages, selectedId]);

  const loading = live.mode === 'spacetimedb' && live.status === 'connecting';
  const offline = live.mode === 'spacetimedb' && live.status === 'error';

  return (
    <div className="dash">
      <TopBar live={live} />

      <div className="dash-strip">
        <Counter cls="sos" n={offline ? null : counters.sos} label="SOS" loading={loading} />
        <Counter cls="flag" n={offline ? null : counters.flagged} label="Flagged" loading={loading} />
        <Counter cls="alert" n={offline ? null : counters.alerted} label={`Alerted · ${counters.acknowledged} ack`} loading={loading} />
        <DemoControls zone={zone} zones={data.zones} llmProvider={data.llmProvider} onShowZone={showZone} onMesh={startMesh} meshBusy={!!mesh && !mesh.uploaded} run={run} disabled={!zone} />
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
            profiles={data.profiles}
            alertsByCase={alertsByCase}
            selectedId={selectedId}
            onSelect={setSelectedId}
            resolvedView={showResolved}
          />
        </section>

        <section className="map-wrap" aria-label="Map">
          <MapView
            zones={data.zones}
            focusZone={zone}
            meshOverlay={meshOverlay}
            meshPath={meshPath}
            cases={listed}
            pings={pings}
            centers={data.centers}
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
            </div>
            {(meshOverlay || meshPath) && (
              <div className="row">
                <i style={{ background: '#c0392b', width: 14, height: 3, borderRadius: 0 }} /> mesh hop
                <i style={{ background: '#7c818c', width: 6, height: 6, marginLeft: 6 }} /> no signal
                <i style={{ background: '#2c5ba8', width: 6, height: 6, marginLeft: 6 }} /> has signal
              </div>
            )}
          </div>
          <div className="map-label">
            {mesh && meshOverlay ? (
              <span className="chip mesh-status" role="status">
                Mesh demo · round {Math.min(mesh.step, mesh.scenario.result.rounds.length)}/{mesh.scenario.result.rounds.length} ·{' '}
                {mesh.scenario.nodes.length} phones, {MESH_SIM_RANGE_KM} km range (assumed) · reached signal{' '}
                {meshOverlay.gateways.length}/{mesh.scenario.senders.length}
                <button className="btn ghost small" onClick={() => setMesh(null)} disabled={!mesh.uploaded} style={{ height: 22, marginLeft: 6 }}>
                  Clear
                </button>
              </span>
            ) : (
              <span className="chip">Last known locations · synthetic</span>
            )}
          </div>
        </section>

        <div className="col scroll">
          <ZonePanel zone={zone} newsCount={data.news.filter(n => n.area === zone?.id).length} loading={loading} />
          <CaseDetail
            c={selected}
            hasWifi={selected ? data.profiles.get(selected.user)?.hasWifi : undefined}
            alert={selected ? alertsByCase.get(selected.id) : undefined}
            center={data.centers.find(x => x.id === selected?.assignedCenter)}
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
        <span>
          Mesh demo assumes {MESH_SIM_RANGE_KM} km phone-to-phone range and synthetic bystander phones; real range indoors is much shorter.
        </span>
        <span>All people, centers and news are synthetic. Concept prototype — not affiliated with any insurer.</span>
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

/** Severity the scenario dropdown sets. Scanning starts at MIN_SEVERITY_FOR_SCAN (3). */
const SIMULATED_SEVERITY = 4;

/** Models the agents worker can use. Code still computes every score, distance and nearest center. */
const AI_MODELS = [
  { id: 'gemini', label: 'Gemini' },
  { id: 'nvidia', label: 'NVIDIA Nemotron' },
];

function DemoControls(props: {
  zone?: Zone;
  zones: Zone[];
  llmProvider: string;
  onShowZone: (id: string) => void;
  onMesh: () => void;
  meshBusy: boolean;
  run: (l: string, f: () => Promise<void>) => void;
  disabled: boolean;
}) {
  const { zone, zones, llmProvider, onShowZone, onMesh, meshBusy, run, disabled } = props;
  const api = useApi();
  // One entry per seeded scenario present in the database, in seed order (Dallas, LA, Miami).
  const scenarios = ZONES.filter(s => zones.some(z => z.id === s.id)).map(s => ({
    id: s.id,
    label: `Simulate ${s.hazard} in ${s.city}`,
  }));
  const [count, setCount] = useState(15);
  const researching = zone?.researchStatus === 'requested';
  return (
    <div className="panel controls" aria-label="Demo controls">
      <span className="lbl">AI model</span>
      <select
        aria-label="AI model used by every agent"
        title="Model used by the Weather Research and Triage agents"
        value={llmProvider}
        disabled={disabled}
        onChange={e => {
          const m = AI_MODELS.find(x => x.id === e.target.value);
          if (m) run(`All agents now use ${m.label}`, () => api.setLlmProvider(m.id));
        }}
      >
        {AI_MODELS.map(m => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      <span className="lbl">Demo</span>
      <button
        className="btn primary"
        disabled={disabled || researching}
        onClick={() => zone && run('Weather research requested — the agent worker will pick it up', () => api.requestResearch(zone.id))}
      >
        {researching ? 'Researching…' : 'Run weather research'}
      </button>
      <select
        className="simulate"
        aria-label="Simulate disaster"
        value=""
        disabled={disabled || scenarios.length === 0}
        onChange={e => {
          const s = scenarios.find(x => x.id === e.target.value);
          if (!s) return;
          onShowZone(s.id);
          run(s.label.replace('Simulate', 'Simulated'), () => api.simulateDisaster(s.id, SIMULATED_SEVERITY));
        }}
      >
        <option value="" disabled hidden>
          Simulate disaster ▾
        </option>
        {scenarios.map(s => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
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
        className="btn"
        disabled={disabled || meshBusy}
        title="Cell towers in this zone go down: SOS messages hop phone-to-phone to the nearest phone with signal"
        onClick={onMesh}
      >
        {meshBusy ? 'Mesh relaying…' : 'Simulate mesh (no signal)'}
      </button>
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
  profiles: Map<string, Profile>;
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
        const wifi = props.profiles.get(c.user)?.hasWifi;
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
              {c.sos && <span className="chip sos">SOS</span>}
              {c.viaMesh && <span className="chip info">via mesh</span>}
              {c.hasPets && <span className="chip">pets</span>}
              {wifi !== undefined && <span className={`chip${wifi ? '' : ' warn'}`}>{wifi ? 'Wi-Fi' : 'no Wi-Fi'}</span>}
              {a && <span className={`chip ${a.status === 'acknowledged' ? 'ok' : 'info'}`}>{a.status === 'acknowledged' ? 'ack’d' : 'alert sent'}</span>}
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

function CaseDetail(props: { c: Case | null; hasWifi?: boolean; alert?: Alert; center?: Center; onAck: (id: string) => void }) {
  const { c, hasWifi, alert, center, onAck } = props;
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
        {hasWifi !== undefined && (
          <div className="small" style={{ marginTop: 6 }}>
            <span className={`chip${hasWifi ? '' : ' warn'}`}>{hasWifi ? 'Has Wi-Fi at home' : 'No Wi-Fi at home'}</span>
          </div>
        )}

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

        {(c.sos || c.viaMesh) && (
          <div className="section">
            <h3>How this reached us</h3>
            <dl className="kv">
              {c.sos && (
                <>
                  <dt>SOS</dt>
                  <dd>
                    <span className="chip sos">asked for help</span>
                    {c.sosNote && <span className="quote" style={{ display: 'block', marginTop: 6 }}>“{c.sosNote}”</span>}
                  </dd>
                </>
              )}
              <dt>Route</dt>
              <dd>
                {c.viaMesh ? (
                  <>
                    No signal on their phone. Relayed phone-to-phone and uploaded by{' '}
                    <b>{c.relayedBy}</b>. The red dashed line on the map is the route.
                  </>
                ) : (
                  'Sent directly from their phone (queued while offline, or with signal).'
                )}
              </dd>
            </dl>
          </div>
        )}

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

      </div>
    </section>
  );
}
