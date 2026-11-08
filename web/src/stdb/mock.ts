// OFFLINE PREVIEW backend (?mock=1). Lets the team work on the UI before the SpacetimeDB CLI is installed.
// It reuses the same pure logic and synthetic seed as the module, but it is NOT SpacetimeDB: no persistence,
// no other clients, no agents. Agent outputs here are the same templated fallbacks, tagged source=fallback.
// The UI shows a "Preview mode" banner whenever this backend is active.
import {
  MIN_SEVERITY_FOR_SCAN,
  SILENCE_THRESHOLD_MIN,
  isInsideZone,
  nearest,
  shelterShortlist,
  urgencyScore,
  welfareCheckMessage,
} from '../../../module/src/logic';
import { buildSeedDataset, prng } from '../../../module/src/seed_data';
import type { Api, Backend, Case, LiveState, Snapshot } from './types';
import { emptySnapshot } from './types';

const ME = 'mock-browser-identity';
const minAgo = (m: number) => new Date(Date.now() - m * 60_000);

function seed(): Snapshot {
  const d = buildSeedDataset();
  const s = emptySnapshot();
  s.zones.push({
    ...d.zone,
    hazard: 'none',
    severity: 1,
    confidence: 0,
    summary: 'Not assessed yet. Run weather research or simulate a disaster.',
    evidence: [],
    source: 'seed',
    updatedAt: new Date(),
    researchStatus: 'idle',
  });
  d.news.forEach((n, i) => s.news.push({ id: String(i + 1), area: n.area, text: n.text, at: minAgo(n.minutesAgo), isSynthetic: true }));
  d.centers.forEach(c => s.centers.push({ ...c, isSynthetic: true }));
  d.shelters.forEach((o, i) => s.offers.push({ ...o, id: String(i + 1), owner: 'seed', status: 'open', isSynthetic: true }));
  d.users.forEach(u => {
    const id = `synthetic-${u.index}`;
    s.profiles.set(id, { identity: id, displayName: u.displayName, ageGroup: u.ageGroup, vulnerabilityFlag: u.vulnerabilityFlag, hasPets: u.hasPets, optIn: true, isSynthetic: true, simSilent: u.silent });
    s.pings.set(id, { user: id, lat: u.lat, lng: u.lng, accuracy: u.accuracy, at: minAgo(u.minutesAgo) });
  });
  return s;
}

export function createMockBackend(): Backend {
  const listeners = new Set<() => void>();
  let data = seed();
  let nextId = 1;
  let state: LiveState = { mode: 'mock', status: 'live', identity: ME, data, version: 0 };
  const emit = () => {
    state = { ...state, data: { ...data, cases: [...data.cases], alerts: [...data.alerts], offers: [...data.offers], zones: [...data.zones] }, version: state.version + 1 };
    listeners.forEach(l => l());
  };

  const scan = () => {
    const now = Date.now();
    for (const p of data.profiles.values()) {
      const lp = data.pings.get(p.identity);
      if (p.isSynthetic && !p.simSilent && lp) lp.at = new Date(now);
    }
    for (const lp of data.pings.values()) {
      const profile = data.profiles.get(lp.user);
      if (!profile?.optIn) continue;
      const silent = (now - lp.at.getTime()) / 60_000;
      const active = data.cases.find(c => c.user === lp.user && c.status !== 'resolved');
      if (silent < SILENCE_THRESHOLD_MIN) {
        if (active) Object.assign(active, { status: 'resolved', matchedOffer: undefined });
        continue;
      }
      const zone = data.zones.filter(z => isInsideZone(lp, z)).sort((a, b) => b.severity - a.severity)[0];
      if (!zone || (!active && zone.severity < MIN_SEVERITY_FOR_SCAN)) continue;
      const s = urgencyScore({ severity: zone.severity, silentMinutes: silent, vulnerable: profile.vulnerabilityFlag });
      const fields = {
        silentMinutes: Math.round(silent * 10) / 10, severity: zone.severity, vulnerabilityFlag: profile.vulnerabilityFlag, hasPets: profile.hasPets,
        scoreSeverity: s.severityPart, scoreSilence: s.silencePart, scoreVulnerability: s.vulnerabilityPart, urgencyScore: s.total,
        lastLat: lp.lat, lastLng: lp.lng, lastSeen: lp.at,
      };
      if (active) {
        Object.assign(active, fields);
        continue;
      }
      const near = nearest(lp, data.centers);
      const c: Case = {
        id: String(nextId++), user: lp.user, zoneId: zone.id, displayName: profile.displayName, ...fields,
        rationale: '', rationaleSource: '', status: 'open', assignedCenter: near?.item.id,
        centerDistanceKm: near ? Math.round(near.km * 100) / 100 : -1, matchedOffer: undefined, handoffNote: '', matchSource: '', openedAt: new Date(),
      };
      data.cases.push(c);
      if (near) {
        data.alerts.push({
          id: c.id, caseId: c.id, centerId: near.item.id, status: 'sent', at: new Date(),
          message: welfareCheckMessage({ displayName: profile.displayName, silentMinutes: silent, zoneName: zone.name, centerName: near.item.name, centerKm: near.km }),
        });
      }
    }
    // Stand-ins for the triage + shelter agents (fallback templates, honestly tagged).
    setTimeout(() => {
      for (const c of data.cases) {
        if (c.status === 'resolved') continue;
        if (!c.rationale) {
          c.rationale = `Silent ${Math.round(c.silentMinutes)} min inside a severity ${c.severity} zone${c.vulnerabilityFlag ? ', self-reported as vulnerable' : ''}${c.hasPets ? ', has pets' : ''} — status unknown, the phone may simply be off or out of signal.`;
          c.rationaleSource = 'fallback';
        }
        if (!c.matchedOffer) {
          const sl = shelterShortlist({ lat: c.lastLat, lng: c.lastLng, hasPets: c.hasPets, needsAccessible: c.vulnerabilityFlag }, data.offers.map(o => ({ ...o, id: BigInt(o.id) })));
          if (sl[0]) {
            const offer = data.offers.find(o => o.id === String(sl[0].offer.id))!;
            offer.capacity -= 1;
            if (offer.capacity === 0) offer.status = 'full';
            c.matchedOffer = offer.id;
            c.handoffNote = `Holding 1 spot at ${offer.hostName} (${sl[0].km.toFixed(1)} km) for ${c.displayName}. Use it only if responders reach them and they need shelter.`;
            c.matchSource = 'fallback';
          }
        }
      }
      emit();
    }, 900);
    emit();
  };

  const timer = setInterval(scan, 30_000);
  void timer;
  const zone = (id: string) => {
    const z = data.zones.find(x => x.id === id);
    if (!z) throw new Error('Unknown zone');
    return z;
  };

  const api: Api = {
    async updateProfile(a) {
      data.profiles.set(ME, { identity: ME, ...a, isSynthetic: false, simSilent: false });
      if (!a.optIn) data.pings.delete(ME);
      emit();
    },
    async ping(a) {
      if (!data.profiles.get(ME)?.optIn) throw new Error('Opt in to location sharing before sending a heartbeat');
      data.pings.set(ME, { user: ME, ...a, at: new Date() });
      emit();
    },
    async requestResearch(zoneId) {
      const z = zone(zoneId);
      z.researchStatus = 'requested';
      emit();
      await new Promise(r => setTimeout(r, 1200));
      Object.assign(z, {
        hazard: 'flood', severity: 4, confidence: 0.6, source: 'fallback', researchStatus: 'idle', updatedAt: new Date(),
        summary: 'Synthetic reports describe street flooding, closed low-water crossings and a river gauge forecast above flood stage. Power and cell service are degraded, so silent phones are expected and need welfare checks.',
        evidence: data.news.filter(n => n.area === zoneId).map(n => n.text.replace(/^SYNTHETIC:\s*/, '')),
      });
      scan();
    },
    async simulateDisaster(zoneId, severity) {
      Object.assign(zone(zoneId), {
        hazard: 'flood', severity, confidence: 1, source: 'simulated', updatedAt: new Date(),
        summary: `DEMO OVERRIDE: an operator simulated a severity ${severity} flood. This is not an agent assessment.`,
        evidence: ['Manual demo override from the dashboard (simulate_disaster).'],
      });
      scan();
    },
    async silenceUsers(zoneId, count) {
      const z = zone(zoneId);
      const rand = prng(Date.now() % 2147483647);
      const cands = [...data.profiles.values()].filter(p => p.isSynthetic && !p.simSilent && isInsideZone(data.pings.get(p.identity)!, z));
      cands.sort(() => rand() - 0.5).slice(0, count).forEach(p => {
        p.simSilent = true;
        data.pings.get(p.identity)!.at = minAgo(15 + rand() * 75);
      });
      scan();
    },
    async resetDemo() {
      const mine = { p: data.profiles.get(ME), l: data.pings.get(ME) };
      data = seed();
      if (mine.p) data.profiles.set(ME, mine.p);
      if (mine.l) data.pings.set(ME, mine.l);
      emit();
    },
    async acknowledgeAlert(alertId) {
      const a = data.alerts.find(x => x.id === alertId);
      if (!a) return;
      a.status = 'acknowledged';
      const c = data.cases.find(x => x.id === a.caseId);
      if (c?.status === 'open') c.status = 'acknowledged';
      emit();
    },
    async registerShelter(a) {
      data.offers.push({ ...a, id: String(1000 + data.offers.length), owner: ME, status: 'open', isSynthetic: false });
      emit();
    },
  };

  return { mode: 'mock', api, subscribe: cb => (listeners.add(cb), () => listeners.delete(cb)), getState: () => state };
}
