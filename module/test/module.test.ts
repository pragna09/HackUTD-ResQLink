// Runs the real reducer bodies against SpacetimeDB's in-process test datastore (no CLI needed).
import { describe, expect, it } from 'vitest';
import { Identity, Timestamp } from 'spacetimedb';
import { TestAuth, TestClock, createModuleTestHarness } from 'spacetimedb/server/test-utils';
import spacetimedb from '../src/schema';
import * as moduleExports from '../src/index';
import * as h from '../src/handlers';
import { DEMO_ZONE, ZONES, buildSeedDataset, syntheticIdentityValue } from '../src/seed_data';
import { SILENCE_THRESHOLD_MIN, isInsideZone } from '../src/logic';

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
    expect(harness.db.emergencyCenter.count()).toBe(9n);
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
