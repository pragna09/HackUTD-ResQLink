// Runs the real reducer bodies against SpacetimeDB's in-process test datastore (no CLI needed).
import { describe, expect, it } from 'vitest';
import { Identity, Timestamp } from 'spacetimedb';
import { TestAuth, TestClock, createModuleTestHarness } from 'spacetimedb/server/test-utils';
import spacetimedb from '../src/schema';
import * as moduleExports from '../src/index';
import * as h from '../src/handlers';
import { DEMO_ZONE, ZONES, buildSeedDataset, syntheticIdentityValue } from '../src/seed_data';
import { SILENCE_THRESHOLD_MIN, isInsideZone, mandatoryServices, planDispatch } from '../src/logic';
import { MeshNode, encodeUpload, simulateMesh } from '../src/mesh';

const DATA = buildSeedDataset();
const hexOf = (index: number) => new Identity(syntheticIdentityValue(index)).toHexString();

const T0 = Timestamp.fromDate(new Date('2026-11-07T20:00:00Z'));
const plusMin = (m: number) => new Timestamp(T0.microsSinceUnixEpoch + BigInt(m * 60_000_000));

function setup() {
  const clock = new TestClock(T0);
  const harness = createModuleTestHarness(spacetimedb, moduleExports, { clock });
  const tx = <T>(fn: (ctx: Parameters<typeof h.runScan>[0]) => T) => harness.withReducerTx(TestAuth.internal(), fn);
  tx(ctx => h.loadSeed(ctx));
  return { harness, clock, tx };
}

describe('welfare-check module', () => {
  it('seeds three zones with 10 people each, per-city centers and news', () => {
    const { harness } = setup();
    expect(harness.db.zone.count()).toBe(3n);
    for (const z of harness.db.zone.iter()) expect(z.severity).toBe(1);
    expect(harness.db.userProfile.count()).toBe(30n);
    expect(harness.db.locationPing.count()).toBe(30n);
    expect(harness.db.emergencyCenter.count()).toBe(12n);
    expect([...harness.db.emergencyCenter.iter()].filter(c => c.type === 'insurer')).toHaveLength(3);
    expect(harness.db.newsItem.count()).toBe(15n);
    expect(harness.db.scanSchedule.count()).toBe(1n);
  });

  it('seed: 4 none (outside) / 3 medium / 3 high (inside) per zone; one high-risk with Wi-Fi, one without', () => {
    for (const z of ZONES) {
      const people = DATA.users.filter(u => u.zoneId === z.id);
      const tier = (t: string) => people.filter(u => u.riskTier === t);
      expect(people).toHaveLength(10);
      expect(tier('none')).toHaveLength(4);
      expect(tier('medium')).toHaveLength(3);
      expect(tier('high')).toHaveLength(3);
      for (const u of tier('none')) expect(isInsideZone(u, z)).toBe(false);
      for (const u of tier('medium')) {
        expect(isInsideZone(u, z)).toBe(true);
        expect(u.minutesAgo).toBeGreaterThanOrEqual(30);
        expect(u.minutesAgo).toBeLessThanOrEqual(70);
        expect(u.vulnerabilityFlag).toBe(false);
      }
      for (const u of tier('high')) {
        expect(isInsideZone(u, z)).toBe(true);
        expect(u.minutesAgo).toBeGreaterThanOrEqual(90);
        expect(u.minutesAgo).toBeLessThanOrEqual(120);
        expect(u.vulnerabilityFlag).toBe(true);
      }
      expect(tier('high').map(u => u.hasWifi)).toEqual(expect.arrayContaining([true, false]));
    }
  });

  for (const zone of ZONES) {
    it(`${zone.id}: simulating it flags only the 6 at-risk people, high risk ranked above medium`, () => {
      const { harness, clock, tx } = setup();
      const people = DATA.users.filter(u => u.zoneId === zone.id);
      const ids = (t: string) => people.filter(u => u.riskTier === t).map(u => hexOf(u.index));

      expect(tx(ctx => h.simulateDisaster(ctx, { zoneId: zone.id, severity: 4 })).opened).toBe(6);
      const z = harness.db.zone.id.find(zone.id)!;
      expect(z.hazard).toBe(zone.hazard);
      for (const o of ZONES) if (o.id !== zone.id) expect(harness.db.zone.id.find(o.id)!.severity).toBe(1);

      // Time passes and the scan keeps running: the no-risk people never get a case.
      clock.set(plusMin(30));
      tx(ctx => h.runScan(ctx));
      const cases = [...harness.db.missingCase.iter()];
      expect(cases).toHaveLength(6);
      const users = cases.map(c => c.user.toHexString());
      for (const id of ids('none')) expect(users).not.toContain(id);
      for (const c of cases) {
        expect(c.zoneId).toBe(zone.id);
        // Nearest center is in the same city.
        expect(c.centerDistanceKm).toBeLessThan(20);
      }
      const ranked = [...cases].sort((a, b) => b.urgencyScore - a.urgencyScore).map(c => c.user.toHexString());
      expect(new Set(ranked.slice(0, 3))).toEqual(new Set(ids('high')));
      expect(new Set(ranked.slice(3))).toEqual(new Set(ids('medium')));
    });
  }

  it('opens no cases while the zone is below severity 3', () => {
    const { harness, tx } = setup();
    const r = tx(ctx => h.runScan(ctx));
    expect(r.opened).toBe(0);
    expect(harness.db.missingCase.count()).toBe(0n);
  });

  it('opens scored cases with a nearest center and an alert once severity >= 3', () => {
    const { harness, tx } = setup();
    const r = tx(ctx =>
      h.upsertZone(ctx, {
        ...DEMO_ZONE,
        hazard: 'flood',
        severity: 4,
        confidence: 0.7,
        summary: 'test',
        evidence: ['e1'],
        source: 'fallback',
      })
    );
    expect(r.opened).toBe(6);
    const cases = [...harness.db.missingCase.iter()];
    expect(cases.length).toBe(r.opened);
    for (const c of cases) {
      expect(c.silentMinutes).toBeGreaterThanOrEqual(SILENCE_THRESHOLD_MIN);
      const expected = 40 * (4 / 5) + 30 * (Math.min(c.silentMinutes, 120) / 120) + (c.vulnerabilityFlag ? 30 : 0);
      expect(c.urgencyScore).toBeCloseTo(expected, 0);
      expect(c.assignedCenter).toBeDefined();
      expect(c.status).toBe('open');
    }
    expect(harness.db.alert.count()).toBe(BigInt(r.opened));
    for (const a of harness.db.alert.iter()) {
      expect(a.message).toMatch(/welfare check/i);
      expect(a.message).not.toMatch(/confirmed emergency/i);
    }
    // A second scan refreshes, never duplicates.
    const r2 = tx(ctx => h.runScan(ctx));
    expect(r2.opened).toBe(0);
    expect(harness.db.missingCase.count()).toBe(BigInt(r.opened));
  });

  it('scores grow with time; a real ping resolves its case', () => {
    const { harness, clock, tx } = setup();
    tx(ctx => h.simulateDisaster(ctx, { zoneId: DEMO_ZONE.id, severity: 4 }));
    const first = [...harness.db.missingCase.iter()].find(c => !c.vulnerabilityFlag)!;
    clock.set(plusMin(20));
    tx(ctx => h.runScan(ctx));
    const later = harness.db.missingCase.id.find(first.id)!;
    expect(later.silentMinutes).toBeGreaterThan(first.silentMinutes);
    expect(later.urgencyScore).toBeGreaterThanOrEqual(first.urgencyScore);

    // Heartbeat comes back -> case resolves on the next scan.
    tx(ctx => {
      const lp = ctx.db.locationPing.user.find(first.user)!;
      ctx.db.locationPing.user.update({ ...lp, timestamp: ctx.timestamp });
    });
    const r = tx(ctx => h.runScan(ctx));
    expect(r.resolved).toBeGreaterThanOrEqual(1);
    expect(harness.db.missingCase.id.find(first.id)!.status).toBe('resolved');
  });

  it('agents write text without touching the score', () => {
    const { harness, tx } = setup();
    tx(ctx => h.simulateDisaster(ctx, { zoneId: DEMO_ZONE.id, severity: 5 }));
    const c = [...harness.db.missingCase.iter()][0];
    tx(ctx => h.setRationale(ctx, { caseId: c.id, rationale: 'Silent 40 min in a severity 5 flood.', source: 'fallback' }));
    const after = harness.db.missingCase.id.find(c.id)!;
    expect(after.rationaleSource).toBe('fallback');
    expect(after.urgencyScore).toBe(c.urgencyScore);

    expect(() => tx(ctx => h.setRationale(ctx, { caseId: c.id, rationale: 'x', source: 'made-up' }))).toThrow();
  });

  it('set_llm_provider switches the model the agents use and survives reset_demo', () => {
    const { harness, tx } = setup();
    expect(harness.db.agentConfig.id.find(0)!.llmProvider).toBe('gemini');
    tx(ctx => h.setLlmProvider(ctx, { provider: 'nvidia' }));
    expect(harness.db.agentConfig.id.find(0)!.llmProvider).toBe('nvidia');
    expect(() => tx(ctx => h.setLlmProvider(ctx, { provider: 'gpt' }))).toThrow();
    tx(ctx => h.resetDemo(ctx));
    expect(harness.db.agentConfig.count()).toBe(1n);
    expect(harness.db.agentConfig.id.find(0)!.llmProvider).toBe('nvidia');
  });

  describe('relay_mesh_messages', () => {
    const T0ms = Number(T0.microsSinceUnixEpoch / 1000n);
    const high = DATA.users.find(u => u.zoneId === 'la-fire' && u.riskTier === 'high')!;
    const highHex = hexOf(high.index);
    // An SOS from the high-risk person, relayed through a stranger's phone to one with signal.
    const relayed = () => {
      const origin = new MeshNode({ id: highHex, lat: high.lat, lng: high.lng, hasSignal: false, now: () => T0ms });
      const m = origin.originate({ kind: 'sos', displayName: high.displayName, note: 'Trapped, smoke', createdAtMs: T0ms - 5 * 60_000 });
      const a = new MeshNode({ id: 'b'.repeat(64), lat: high.lat, lng: high.lng + 0.005, hasSignal: false, now: () => T0ms });
      const g = new MeshNode({ id: 'c'.repeat(64), lat: high.lat, lng: high.lng + 0.01, hasSignal: true, now: () => T0ms });
      a.receive(m);
      g.receive(a.carried()[0]);
      return g.tick().uploads;
    };

    it('an SOS opens a case at once (even at severity 1), alerts the nearest responder and survives a fresh heartbeat', () => {
      const { harness, tx } = setup();
      const uploads = relayed();
      expect(uploads[0].path).toHaveLength(3);
      const r = tx(ctx => h.relayMeshMessages(ctx, { payload: encodeUpload(uploads) }));
      expect(r).toEqual({ accepted: 1, duplicates: 0, sosCases: 1 });

      const c = [...harness.db.missingCase.iter()].find(x => x.user.toHexString() === highHex)!;
      expect(c).toMatchObject({ sos: true, viaMesh: true, meshHops: 2, sosNote: 'Trapped, smoke', zoneId: 'la-fire', status: 'open' });
      expect(c.relayedBy).toBe('phone cccccc'); // unknown identity: last 6 hex chars
      const a = [...harness.db.alert.iter()].find(x => x.caseId === c.id)!;
      expect(a.message).toMatch(/SOS from .*relayed phone-to-phone/);
      expect(a.message).not.toMatch(/hop/); // hop counts stay in the backend
      expect(a.message).toMatch(/Trapped, smoke/);
      expect(a.message).not.toMatch(/confirmed emergency/i);
      const row = harness.db.meshMessage.id.find(uploads[0].id)!;
      expect(row.hops).toBe(2);
      expect(row.pathLat).toHaveLength(3);
      // The location keeps the phone's own time (5 min ago), not the upload time.
      expect(harness.db.locationPing.user.find(c.user)!.timestamp.microsSinceUnixEpoch).toBe(T0.microsSinceUnixEpoch - 300_000_000n);

      // A second gateway uploading the same SOS is ignored; a fresh heartbeat does not close an SOS case.
      expect(tx(ctx => h.relayMeshMessages(ctx, { payload: encodeUpload(uploads) }))).toEqual({ accepted: 0, duplicates: 1, sosCases: 0 });
      tx(ctx => {
        const lp = ctx.db.locationPing.user.find(c.user)!;
        ctx.db.locationPing.user.update({ ...lp, timestamp: ctx.timestamp });
      });
      tx(ctx => h.runScan(ctx));
      expect(harness.db.missingCase.id.find(c.id)!.status).toBe('open');
    });

    it('an SOS on an existing case marks it SOS and clears the reason so triage rewrites it', () => {
      const { harness, tx } = setup();
      tx(ctx => h.simulateDisaster(ctx, { zoneId: 'la-fire', severity: 4 }));
      const before = [...harness.db.missingCase.iter()].find(x => x.user.toHexString() === highHex)!;
      tx(ctx => h.setRationale(ctx, { caseId: before.id, rationale: 'old', source: 'llm' }));
      tx(ctx => h.relayMeshMessages(ctx, { payload: encodeUpload(relayed()) }));
      const after = harness.db.missingCase.id.find(before.id)!;
      expect(after).toMatchObject({ sos: true, viaMesh: true, meshHops: 2, rationale: '' });
      expect(harness.db.missingCase.count()).toBe(6n);
    });

    it('a mesh heartbeat older than the stored location is kept as history but does not move the person', () => {
      const { harness, tx } = setup();
      const none = DATA.users.find(u => u.riskTier === 'none')!;
      const id = hexOf(none.index);
      const n = new MeshNode({ id, lat: 0, lng: 0, hasSignal: true, now: () => T0ms });
      const old = n.originate({ kind: 'heartbeat', displayName: 'x', createdAtMs: T0ms - 60 * 60_000 });
      tx(ctx => h.relayMeshMessages(ctx, { payload: encodeUpload([old]) }));
      expect(harness.db.locationPing.user.find(new Identity(id))!.lat).toBe(none.lat);
      expect(harness.db.meshMessage.count()).toBe(1n);
    });

    it('rejects malformed payloads and creates a profile for an unknown sender', () => {
      const { harness, tx } = setup();
      expect(() => tx(ctx => h.relayMeshMessages(ctx, { payload: '[{"bad":1}]' }))).toThrow();
      const stranger = 'd'.repeat(64);
      const z = ZONES[2];
      const n = new MeshNode({ id: stranger, lat: z.centerLat, lng: z.centerLng - 0.01, hasSignal: true, now: () => T0ms });
      tx(ctx => h.relayMeshMessages(ctx, { payload: encodeUpload([n.originate({ kind: 'sos', displayName: 'Visitor', createdAtMs: T0ms })]) }));
      const p = harness.db.userProfile.identity.find(new Identity(stranger))!;
      expect(p).toMatchObject({ displayName: 'Visitor', optIn: true, isSynthetic: false });
      const c = [...harness.db.missingCase.iter()].find(x => x.user.toHexString() === stranger)!;
      expect(c).toMatchObject({ sos: true, viaMesh: false, meshHops: 0, zoneId: z.id });
    });

    it('end to end: a simulated mesh delivers SOS messages and each becomes an SOS case in the right zone', () => {
      const { harness, tx } = setup();
      const zone = ZONES[1];
      const people = DATA.users.filter(u => u.zoneId === zone.id);
      const nodes = people.map(u => ({ id: hexOf(u.index), lat: u.lat, lng: u.lng, hasSignal: u.riskTier === 'none' }));
      // A line of bystander phones west from each at-risk person, out past the zone edge.
      for (const u of people.filter(p => p.riskTier !== 'none')) {
        for (let i = 1; i <= 25; i++) nodes.push({ id: `bystander-${u.index}-${i}`, lat: u.lat, lng: u.lng - i * 0.006, hasSignal: false });
      }
      // Phones with signal in a ring just outside the zone.
      for (let k = 0; k < 72; k++) {
        const ang = (k / 72) * 2 * Math.PI;
        nodes.push({ id: `ring-${k}`, lat: zone.centerLat + ((zone.radiusKm * 1.15) / 110.574) * Math.cos(ang), lng: zone.centerLng + ((zone.radiusKm * 1.15) / 92.3) * Math.sin(ang), hasSignal: true });
      }
      const origins = people.filter(u => u.riskTier !== 'none').map(u => ({ node: hexOf(u.index), kind: 'sos' as const, displayName: u.displayName, createdAtMs: T0ms }));
      const sim = simulateMesh(nodes, origins, { rangeKm: 1, nowMs: T0ms });
      expect(sim.delivered).toHaveLength(6);
      tx(ctx => h.relayMeshMessages(ctx, { payload: encodeUpload(sim.delivered) }));
      const sosCases = [...harness.db.missingCase.iter()].filter(c => c.sos);
      expect(sosCases).toHaveLength(6);
      for (const c of sosCases) {
        expect(c.zoneId).toBe(zone.id);
        expect(c.meshHops).toBeGreaterThan(0);
      }
    });
  });

  it('update_profile: demo sign-in with household; vulnerability is derived from dependents and accessibility', () => {
    const { harness, tx } = setup();
    const base = { displayName: 'Maria G.', phone: '+1 (214) 555-0100', ageGroup: '18-64', dependentsChildren: 0, dependentsElderly: 0, needsAccessible: false, hasPets: false, optIn: false };
    const save = (patch: Partial<typeof base>) => {
      let id!: Identity;
      tx(ctx => {
        id = ctx.sender;
        h.updateProfile(ctx, { ...base, ...patch });
      });
      return harness.db.userProfile.identity.find(id)!;
    };
    expect(save({})).toMatchObject({ vulnerabilityFlag: false, phone: '+1 (214) 555-0100' });
    expect(save({ dependentsChildren: 2 }).vulnerabilityFlag).toBe(true);
    expect(save({ dependentsElderly: 1 }).vulnerabilityFlag).toBe(true);
    expect(save({ needsAccessible: true, hasPets: true })).toMatchObject({ vulnerabilityFlag: true, needsAccessible: true, hasPets: true });
    expect(() => save({ phone: 'call me' })).toThrow();
    expect(() => save({ displayName: '  ' })).toThrow();
    expect(() => save({ dependentsChildren: 21 })).toThrow();
  });

  it('respond_check_in: "help" opens an SOS case and alerts; "safe" closes it; the answer survives a profile save', () => {
    const { harness, tx } = setup();
    const profile = { displayName: 'Maria G.', phone: '+1 214 555 0100', ageGroup: '18-64', dependentsChildren: 1, dependentsElderly: 0, needsAccessible: false, hasPets: false, optIn: false };
    const z = ZONES[0];
    let me!: Identity;
    tx(ctx => {
      me = ctx.sender;
      h.updateProfile(ctx, profile);
    });
    const at = { hasLocation: true, lat: z.centerLat, lng: z.centerLng, accuracy: 20 };
    expect(() => tx(ctx => h.respondCheckIn(ctx, { status: 'maybe', note: '', ...at }))).toThrow();

    tx(ctx => h.respondCheckIn(ctx, { status: 'help', note: 'Roof collapsed', ...at }));
    const c = [...harness.db.missingCase.iter()].find(x => x.user.toHexString() === me.toHexString())!;
    expect(c).toMatchObject({ sos: true, sosNote: 'Roof collapsed', viaMesh: false, zoneId: z.id, status: 'open', vulnerabilityFlag: true });
    const a = [...harness.db.alert.iter()].find(x => x.caseId === c.id)!;
    expect(a.message).toMatch(/Help requested by Maria G\. from the app check-in/);
    expect(a.message).not.toMatch(/confirmed emergency/i);
    expect(harness.db.userProfile.identity.find(me)!).toMatchObject({ checkInStatus: 'help', optIn: true });

    tx(ctx => h.updateProfile(ctx, { ...profile, optIn: true }));
    expect(harness.db.userProfile.identity.find(me)!.checkInStatus).toBe('help');

    tx(ctx => h.respondCheckIn(ctx, { status: 'safe', note: '', ...at }));
    expect(harness.db.missingCase.id.find(c.id)!.status).toBe('resolved');
    expect(harness.db.userProfile.identity.find(me)!.checkInStatus).toBe('safe');
  });

  describe('agent pipeline', () => {
    it('code decides the minimum services per disaster; needs and the insurer are added on top', () => {
      expect(mandatoryServices('flood')).toEqual(['fire', 'hospital']);
      expect(mandatoryServices('earthquake')).toEqual(['fire', 'hospital']);
      expect(mandatoryServices('wildfire')).toEqual(['fire', 'hospital']);
      expect(mandatoryServices('unknown')).toEqual(['police', 'hospital']);
      const centers = DATA.centers;
      const z = ZONES[0];
      const plan = planDispatch({ lat: z.centerLat, lng: z.centerLng }, 'earthquake', ['security'], centers);
      expect(plan.map(p => [p.type, p.reason])).toEqual([
        ['fire', 'hazard'],
        ['hospital', 'hazard'],
        ['police', 'need'],
        ['insurer', 'always'],
      ]);
      expect(plan.every(p => p.km < 10)).toBe(true); // all in the same city
    });

    it('Monitor: re-rating a zone clears its advice; set_zone_advice writes the new one', () => {
      const { harness, tx } = setup();
      const z = ZONES[2];
      tx(ctx => h.setZoneAdvice(ctx, { zoneId: z.id, warning: 'Flash flood warning', instructions: ['Move to higher ground', 'Avoid driving through water'], source: 'llm' }));
      expect(harness.db.zone.id.find(z.id)!).toMatchObject({ safetyWarning: 'Flash flood warning', adviceSource: 'llm' });
      expect(harness.db.zone.id.find(z.id)!.safetyAdvice).toHaveLength(2);
      tx(ctx => h.simulateDisaster(ctx, { zoneId: z.id, severity: 4 }));
      expect(harness.db.zone.id.find(z.id)!).toMatchObject({ safetyWarning: '', adviceSource: '' });
      expect(() => tx(ctx => h.setZoneAdvice(ctx, { zoneId: z.id, warning: 'x', instructions: [], source: 'llm' }))).toThrow();
    });

    it('Triage needs feed Dispatch; Dispatch must cover the disaster\'s services and alerts each one once', () => {
      const { harness, tx } = setup();
      const z = ZONES[0]; // earthquake: fire + hospital required
      tx(ctx => h.simulateDisaster(ctx, { zoneId: z.id, severity: 4 }));
      const c = [...harness.db.missingCase.iter()].find(x => x.vulnerabilityFlag)!;
      tx(ctx => h.setRationale(ctx, { caseId: c.id, rationale: 'Vulnerable and silent.', source: 'llm', needs: ['medical', 'rescue', 'made-up'] }));
      expect(harness.db.missingCase.id.find(c.id)!.needs).toEqual(['medical', 'rescue']);

      const byType = (t: string) => [...harness.db.emergencyCenter.iter()].find(x => x.type === t && isInsideZone(x, { ...z, radiusKm: 10 }))!;
      // Dropping the hospital is refused (unless the nearest-center alert already reached one).
      // Read center ids before opening a transaction (reading the harness db inside one crashes the test engine).
      const insurerOnly = [byType('insurer').id];
      expect(() => tx(ctx => h.dispatchCase(ctx, { caseId: c.id, centerIds: insurerOnly, message: 'Help', source: 'llm' }))).toThrow(); // the module reports which service is missing

      const ids = [byType('fire').id, byType('hospital').id, byType('insurer').id];
      tx(ctx => h.dispatchCase(ctx, { caseId: c.id, centerIds: ids, message: 'SOS: vulnerable person, earthquake zone.', source: 'llm' }));
      const alerts = [...harness.db.alert.caseId.filter(c.id)];
      expect(new Set(alerts.map(a => a.centerId)).size).toBe(alerts.length); // no center twice
      expect(alerts.filter(a => a.role === 'nearest')).toHaveLength(1);
      expect(alerts.filter(a => a.role === 'dispatch').length).toBeGreaterThanOrEqual(1);
      expect(alerts.some(a => a.role === 'insurer')).toBe(true);
      expect(harness.db.missingCase.id.find(c.id)!).toMatchObject({ dispatched: true, dispatchSource: 'llm' });
      expect(() => tx(ctx => h.dispatchCase(ctx, { caseId: c.id, centerIds: ids, message: 'again', source: 'llm' }))).toThrow(); // dispatched once
    });

    it('a new SOS on a dispatched case re-runs triage and dispatch', () => {
      const { harness, tx } = setup();
      const z = ZONES[0];
      tx(ctx => h.simulateDisaster(ctx, { zoneId: z.id, severity: 4 }));
      const c = [...harness.db.missingCase.iter()][0];
      tx(ctx => h.setRationale(ctx, { caseId: c.id, rationale: 'r', source: 'llm', needs: [] }));
      const all = [...harness.db.emergencyCenter.iter()].filter(x => isInsideZone(x, { ...z, radiusKm: 10 })).map(x => x.id);
      tx(ctx => h.dispatchCase(ctx, { caseId: c.id, centerIds: all, message: 'm', source: 'fallback' }));
      const T0ms = Number(T0.microsSinceUnixEpoch / 1000n);
      const origin = new MeshNode({ id: c.user.toHexString(), lat: c.lastLat, lng: c.lastLng, hasSignal: true, now: () => T0ms });
      tx(ctx => h.relayMeshMessages(ctx, { payload: encodeUpload([origin.originate({ kind: 'sos', displayName: 'x', createdAtMs: T0ms })]) }));
      expect(harness.db.missingCase.id.find(c.id)!).toMatchObject({ sos: true, rationale: '', dispatched: false });
    });
  });

  it('acknowledge_alert updates alert and case', () => {
    const { harness, tx } = setup();
    tx(ctx => h.simulateDisaster(ctx, { zoneId: DEMO_ZONE.id, severity: 4 }));
    const a = [...harness.db.alert.iter()][0];
    tx(ctx => h.acknowledgeAlert(ctx, { alertId: a.id }));
    expect(harness.db.alert.id.find(a.id)!.status).toBe('acknowledged');
    expect(harness.db.missingCase.id.find(a.caseId)!.status).toBe('acknowledged');
  });

  it('reset_demo restores the seeded state', () => {
    const { harness, tx } = setup();
    tx(ctx => h.simulateDisaster(ctx, { zoneId: DEMO_ZONE.id, severity: 5 }));
    tx(ctx => h.resetDemo(ctx));
    expect(harness.db.missingCase.count()).toBe(0n);
    expect(harness.db.alert.count()).toBe(0n);
    expect(harness.db.userProfile.count()).toBe(30n);
    for (const z of harness.db.zone.iter()) expect(z.severity).toBe(1);
    expect(harness.db.zone.id.find(DEMO_ZONE.id)!.severity).toBe(1);
    expect(harness.db.scanSchedule.count()).toBe(1n);
  });
});
