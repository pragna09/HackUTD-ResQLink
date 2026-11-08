import { NavLink } from 'react-router';
import type { LiveState } from '../stdb/types';

export function SourceBadge({ source, title }: { source: string; title?: string }) {
  if (!source) return <span className="badge pending" title="No agent result yet">pending</span>;
  const tip =
    title ??
    ({
      llm: 'Written by the language model (validated JSON).',
      fallback: 'Stored/templated fallback — NOT live model output.',
      simulated: 'Manual demo override from the dashboard.',
      seed: 'Initial seed value; not assessed yet.',
    }[source] ?? source);
  return (
    <span className={`badge ${source}`} title={tip}>
      {source}
    </span>
  );
}

export function TopBar({ live }: { live: LiveState }) {
  const statusText = live.mode === 'mock' ? 'preview (mock)' : live.status;
  return (
    <>
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-mark" aria-hidden />
          Welfare Check
        </a>
        <span className="pill">Concept prototype</span>
        <span className="pill alt">Synthetic data</span>
        <nav aria-label="Main">
          <NavLink to="/dashboard">Dashboard</NavLink>
          <NavLink to="/app">Phone app</NavLink>
        </nav>
        <div className="spacer" />
        <div className="conn" role="status">
          <span className={`dot ${live.mode === 'mock' ? 'connecting' : live.status}`} />
          {statusText}
        </div>
      </header>
      <StatusBanner live={live} />
    </>
  );
}

export function StatusBanner({ live }: { live: LiveState }) {
  if (live.mode === 'mock')
    return (
      <div className="banner mock">
        <b>Preview mode.</b> Local mock backend built from the same seed and scoring code. Not SpacetimeDB: no persistence, no agents, results are
        templated fallbacks. Remove <code>?mock=1</code> to use the live module.
      </div>
    );
  if (live.status === 'error' && live.error)
    return (
      <div className="banner error">
        <b>Not connected.</b> {live.error}
      </div>
    );
  if (live.status === 'disconnected')
    return (
      <div className="banner error">
        <b>Connection lost.</b> Reconnecting… data shown may be stale.
      </div>
    );
  return null;
}

export function Toast({ msg }: { msg: { text: string; bad?: boolean } | null }) {
  if (!msg) return null;
  return (
    <div className={`toast${msg.bad ? ' bad' : ''}`} role="status">
      {msg.text}
    </div>
  );
}
