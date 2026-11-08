// OFFLINE PREVIEW backend (?mock=1). Lets the team work on the UI before the SpacetimeDB CLI is installed.
// It reuses the same pure logic and synthetic seed as the module, but it is NOT SpacetimeDB: no persistence,
// no other clients, no agents. Agent outputs here are the same templated fallbacks, tagged source=fallback.
// The UI shows a "Preview mode" banner whenever this backend is active.
import {
  MIN_SEVERITY_FOR_SCAN,
  SILENCE_THRESHOLD_MIN,
  isInsideZone,
  isVulnerable,
  nearest,
  urgencyScore,
  welfareCheckMessage,
  meshSosMessage,
} from '../../../module/src/logic';
import { decodeUpload, encodeUpload } from '../../../module/src/mesh';
import { buildSeedDataset, prng } from '../../../module/src/seed_data';
import type { Api, Backend, Case, LiveState, Snapshot } from './types';
import { emptySnapshot } from './types';

const ME = 'mock-browser-identity';
const minAgo = (m: number) => new Date(Date.now() - m * 60_000);

function seed(): Snapshot {
  const d = buildSeedDataset();
  const s = emptySnapshot();
  for (const { city: _city, ...z } of d.zones) s.zones.push({
    ...z,
    severity: 1,
    safetyWarning: '',
    safetyAdvice: [],
    adviceSource: '',
    confidence: 0,
    summary: 'Not assessed yet. Run weather research or simulate a disaster.',
    evidence: [],
    source: 'seed',
    updatedAt: new Date(),
    researchStatus: 'idle',
  });
  d.news.forEach((n, i) => s.news.push({ id: String(i + 1), area: n.area, text: n.text, at: minAgo(n.minutesAgo), isSynthetic: true }));
  d.centers.forEach(c => s.centers.push({ ...c, isSynthetic: true }));
  d.users.forEach(u => {
    const id = `synthetic-${u.index}`;
    s.profiles.set(id, { identity: id, displayName: u.displayName, ageGroup: u.ageGroup, phone: '', dependentsChildren: 0, dependentsElderly: 0, needsAccessible: u.vulnerabilityFlag, vulnerabilityFlag: u.vulnerabilityFlag, hasPets: u.hasPets, hasWifi: u.hasWifi, checkInStatus: '', checkInAt: undefined, optIn: true, isSynthetic: true, simSilent: u.silent });
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
    state = { ...state, data: { ...data, cases: [...data.cases], alerts: [...data.alerts], meshMessages: [...data.meshMessages], zones: [...data.zones] }, version: state.version + 1 };
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
        if (active && !active.sos) Object.assign(active, { status: 'resolved' });
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
        centerDistanceKm: near ? Math.round(near.km * 100) / 100 : -1, openedAt: new Date(),
        sos: false, sosNote: '', viaMesh: false, meshHops: 0, relayedBy: '', needs: [], dispatched: false, dispatchMessage: '', dispatchSource: '',
      };
      data.cases.push(c);
      if (near) {
        data.alerts.push({
          id: c.id, caseId: c.id, centerId: near.item.id, role: 'nearest', status: 'sent', at: new Date(),
          message: welfareCheckMessage({ displayName: profile.displayName, silentMinutes: silent, zoneName: zone.name, centerName: near.item.name, centerKm: near.km }),
        });
      }
    }
    // Stand-in for the triage agent (fallback template, honestly tagged).
    setTimeout(() => {
      for (const c of data.cases) {
        if (c.status === 'resolved') continue;
        if (!c.rationale) {
          c.rationale = `Silent ${Math.round(c.silentMinutes)} min inside a severity ${c.severity} zone${c.vulnerabilityFlag ? ', self-reported as vulnerable' : ''}${c.hasPets ? ', has pets' : ''} — status unknown, the phone may simply be off or out of signal.`;
          c.rationaleSource = 'fallback';
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
    // Simplified version of the module's respond_check_in.
    async respondCheckIn(a) {
      const p = data.profiles.get(ME);
      if (!p) throw new Error('Sign in first');
      if (a.location) data.pings.set(ME, { user: ME, ...a.location, at: new Date() });
      Object.assign(p, { checkInStatus: a.status, checkInAt: new Date(), optIn: p.optIn || a.status === 'help' });
      const active = data.cases.find(c => c.user === ME && c.status !== 'resolved');
      if (a.status === 'safe') {
        if (active) active.status = 'resolved';
      } else if (active) {
        Object.assign(active, { sos: true, sosNote: a.note, rationale: '', status: 'open' });
      } else {
        const lp = data.pings.get(ME);
        if (!lp) throw new Error('Share your location so responders can find you');
        await this.relayMesh(encodeUpload([{ id: `app-${Date.now()}`, kind: 'sos', origin: 'f'.repeat(64), displayName: p.displayName, lat: lp.lat, lng: lp.lng, accuracy: lp.accuracy, createdAtMs: Date.now(), ttl: 12, path: [{ node: 'f'.repeat(64), lat: lp.lat, lng: lp.lng }], note: a.note }]));
      }
      emit();
    },
    signOut() {
      data.profiles.delete(ME);
      data.pings.delete(ME);
      emit();
    },
    async updateProfile(a) {
      data.profiles.set(ME, { identity: ME, ...a, vulnerabilityFlag: isVulnerable(a), hasWifi: data.profiles.get(ME)?.hasWifi ?? true, checkInStatus: data.profiles.get(ME)?.checkInStatus ?? '', checkInAt: data.profiles.get(ME)?.checkInAt, isSynthetic: false, simSilent: false });
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
        severity: 4, confidence: 0.6, source: 'fallback', researchStatus: 'idle', updatedAt: new Date(),
        summary: `Synthetic reports describe a serious ${z.hazard} with damage, outages and degraded cell service, so silent phones are expected and need welfare checks.`,
        evidence: data.news.filter(n => n.area === zoneId).map(n => n.text.replace(/^SYNTHETIC:\s*/, '')),
      });
      scan();
    },
    async simulateDisaster(zoneId, severity) {
      const z = zone(zoneId);
      Object.assign(z, {
        severity, confidence: 1, source: 'simulated', updatedAt: new Date(),
        summary: `DEMO OVERRIDE: an operator simulated a severity ${severity} ${z.hazard}. This is not an agent assessment.`,
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
      const provider = data.llmProvider; // like the real module, reset keeps the picked model
      data = seed();
      data.llmProvider = provider;
      if (mine.p) data.profiles.set(ME, mine.p);
      if (mine.l) data.pings.set(ME, mine.l);
      emit();
    },
    async setLlmProvider(provider) {
      data.llmProvider = provider;
      emit();
    },
    // Same rules as the module's relay_mesh_messages, simplified for the preview.
    async relayMesh(payload) {
      const messages = decodeUpload(payload);
      if (!messages) throw new Error('Invalid mesh payload');
      for (const m of [...messages].sort((a, b) => a.createdAtMs - b.createdAtMs)) {
        if (data.meshMessages.some(x => x.id === m.id)) continue;
        const hops = m.path.length - 1;
        const gw = m.path[m.path.length - 1].node;
        const relayedBy = hops > 0 ? (data.profiles.get(gw)?.displayName ?? `phone ${/^[0-9a-f]{64}$/.test(gw) ? gw.slice(-6) : gw.slice(0, 24)}`) : '';
        const profile = data.profiles.get(m.origin) ?? { identity: m.origin, displayName: m.displayName, ageGroup: 'unknown', phone: '', dependentsChildren: 0, dependentsElderly: 0, needsAccessible: false, vulnerabilityFlag: false, hasPets: false, hasWifi: false, checkInStatus: '', checkInAt: undefined, optIn: true, isSynthetic: false, simSilent: false };
        data.profiles.set(m.origin, profile);
        const old = data.pings.get(m.origin);
        if (!old || old.at.getTime() < m.createdAtMs) data.pings.set(m.origin, { user: m.origin, lat: m.lat, lng: m.lng, accuracy: m.accuracy, at: new Date(m.createdAtMs) });
        let caseId: string | undefined;
        if (m.kind === 'sos') {
          const mesh = { sos: true, sosNote: m.note, viaMesh: hops > 0, meshHops: hops, relayedBy };
          const active = data.cases.find(c => c.user === m.origin && c.status !== 'resolved');
          if (active) {
            Object.assign(active, mesh, { lastLat: m.lat, lastLng: m.lng, rationale: '', status: 'open' });
            caseId = active.id;
          } else {
            const zone = data.zones.find(z => isInsideZone(m, z)) ?? nearest(m, data.zones.map(z => ({ ...z, lat: z.centerLat, lng: z.centerLng })))?.item;
            if (zone) {
              const silent = (Date.now() - m.createdAtMs) / 60_000;
              const s = urgencyScore({ severity: zone.severity, silentMinutes: silent, vulnerable: profile.vulnerabilityFlag });
              const near = nearest(m, data.centers);
              const c: Case = {
                id: String(nextId++), user: m.origin, zoneId: zone.id, displayName: profile.displayName,
                silentMinutes: Math.round(silent * 10) / 10, severity: zone.severity, vulnerabilityFlag: profile.vulnerabilityFlag, hasPets: profile.hasPets,
                scoreSeverity: s.severityPart, scoreSilence: s.silencePart, scoreVulnerability: s.vulnerabilityPart, urgencyScore: s.total,
                lastLat: m.lat, lastLng: m.lng, lastSeen: new Date(m.createdAtMs), rationale: '', rationaleSource: '', status: 'open',
                assignedCenter: near?.item.id, centerDistanceKm: near ? Math.round(near.km * 100) / 100 : -1, openedAt: new Date(), needs: [], dispatched: false, dispatchMessage: '', dispatchSource: '', ...mesh,
              };
              data.cases.push(c);
              caseId = c.id;
              if (near) {
                data.alerts.push({
                  id: c.id, caseId: c.id, centerId: near.item.id, role: 'nearest', status: 'sent', at: new Date(),
                  message: meshSosMessage({ displayName: profile.displayName, minutesAgo: silent, hops, relayedBy, note: m.note, zoneName: zone.name, centerName: near.item.name, centerKm: near.km }),
                });
              }
            }
          }
        }
        data.meshMessages.push({
          id: m.id, kind: m.kind, origin: m.origin, displayName: profile.displayName, createdAt: new Date(m.createdAtMs), receivedAt: new Date(),
          hops, relayedBy, path: m.path.map(h => [h.lat, h.lng] as [number, number]), note: m.note, caseId,
        });
      }
      scan();
    },
    async acknowledgeAlert(alertId) {
      const a = data.alerts.find(x => x.id === alertId);
      if (!a) return;
      a.status = 'acknowledged';
      const c = data.cases.find(x => x.id === a.caseId);
      if (c?.status === 'open') c.status = 'acknowledged';
      emit();
    },
  };

  return { mode: 'mock', api, subscribe: cb => (listeners.add(cb), () => listeners.delete(cb)), getState: () => state };
}
