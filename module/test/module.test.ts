// Runs the real reducer bodies against SpacetimeDB's in-process test datastore (no CLI needed).
import { describe, expect, it } from 'vitest';
import { Timestamp } from 'spacetimedb';
import { TestAuth, TestClock, createModuleTestHarness } from 'spacetimedb/server/test-utils';
import spacetimedb from '../src/schema';
import * as moduleExports from '../src/index';
import * as h from '../src/handlers';
import { DEMO_ZONE } from '../src/seed_data';
import { SILENCE_THRESHOLD_MIN } from '../src/logic';

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
  it('seeds the synthetic dataset and the scan schedule', () => {
    const { harness } = setup();
    expect(harness.db.userProfile.count()).toBe(200n);
    expect(harness.db.locationPing.count()).toBe(200n);
    expect(harness.db.emergencyCenter.count()).toBe(8n);
    expect(harness.db.shelterOffer.count()).toBe(15n);
    expect(harness.db.newsItem.count()).toBe(5n);
    expect(harness.db.zone.count()).toBe(1n);
    expect(harness.db.scanSchedule.count()).toBe(1n);
  });

  it('opens no cases while the zone is below severity 3', () => {
    const { harness, tx } = setup();
    const r = tx(ctx => h.runScan(ctx));
    expect(r.opened).toBe(0);
    expect(harness.db.missingCase.count()).toBe(0n);
  });

  it('opens scored cases with a nearest center and an alert once severity >= 3', () => {
    const { harness, tx } = setup();
    tx(ctx =>
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
    const r = tx(ctx => h.runScan(ctx));
    expect(r.opened).toBeGreaterThan(10);
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

  it('silence_users adds cases; scores grow with time; a real ping resolves its case', () => {
    const { harness, clock, tx } = setup();
    const before = tx(ctx => h.simulateDisaster(ctx, { zoneId: DEMO_ZONE.id, severity: 4 })).opened;
    const added = tx(ctx => h.silenceUsers(ctx, { zoneId: DEMO_ZONE.id, count: 10 })).opened;
    expect(added).toBe(10);
    expect(Number(harness.db.missingCase.count())).toBe(before + 10);

    const first = [...harness.db.missingCase.iter()][0];
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

  it('agents write text without touching the score; set_match enforces constraints and capacity', () => {
    const { harness, tx } = setup();
    tx(ctx => h.simulateDisaster(ctx, { zoneId: DEMO_ZONE.id, severity: 5 }));
    const c = [...harness.db.missingCase.iter()][0];
    tx(ctx => h.setRationale(ctx, { caseId: c.id, rationale: 'Silent 40 min in a severity 5 flood.', source: 'fallback' }));
    const after = harness.db.missingCase.id.find(c.id)!;
    expect(after.rationaleSource).toBe('fallback');
    expect(after.urgencyScore).toBe(c.urgencyScore);

    const ok = [...harness.db.shelterOffer.iter()].find(
      o => (!c.hasPets || o.acceptsPets) && (!c.vulnerabilityFlag || o.accessible)
    )!;
    tx(ctx => h.setMatch(ctx, { caseId: c.id, offerId: ok.id, note: 'note', source: 'fallback' }));
    expect(harness.db.missingCase.id.find(c.id)!.matchedOffer).toBe(ok.id);
    expect(harness.db.shelterOffer.id.find(ok.id)!.capacity).toBe(ok.capacity - 1);
    expect(() => tx(ctx => h.setMatch(ctx, { caseId: c.id, offerId: ok.id, note: 'x', source: 'fallback' }))).toThrow();
    expect(() => tx(ctx => h.setRationale(ctx, { caseId: c.id, rationale: 'x', source: 'made-up' }))).toThrow();
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
    expect(harness.db.userProfile.count()).toBe(200n);
    expect(harness.db.zone.id.find(DEMO_ZONE.id)!.severity).toBe(1);
    expect(harness.db.scanSchedule.count()).toBe(1n);
  });
});
