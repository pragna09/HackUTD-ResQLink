import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router';
import './styles.css';
import { Dashboard } from './dashboard/Dashboard';
import { PhoneApp } from './app/PhoneApp';
import { Volunteer } from './volunteer/Volunteer';

function Home() {
  return (
    <div className="home">
      <span className="pill" style={{ color: '#8a5a00' }}>
        Concept prototype · synthetic data
      </span>
      <h1>Welfare Check</h1>
      <p className="lede">
        Finds people whose phones went quiet inside a disaster zone, ranks them by urgency, tells the nearest emergency center, and holds a volunteer
        shelter spot. Built on SpacetimeDB with Gemini agents. HackUTD 2026.
      </p>
      <div className="tiles">
        <Link className="panel tile" to="/dashboard">
          <b>Responder dashboard →</b>
          <span>Live ranked queue, map, case detail and demo controls.</span>
        </Link>
        <Link className="panel tile" to="/app">
          <b>Phone app →</b>
          <span>Opt in, small profile, 60-second heartbeat.</span>
        </Link>
        <Link className="panel tile" to="/volunteer">
          <b>Volunteer →</b>
          <span>Offer spare space for people who need shelter.</span>
        </Link>
      </div>
      <p className="small muted" style={{ marginTop: 28 }}>
        Not affiliated with or endorsed by any insurer. Add <code>?mock=1</code> to any page for the offline preview backend.
      </p>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/app" element={<PhoneApp />} />
        <Route path="/volunteer" element={<Volunteer />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>
);
