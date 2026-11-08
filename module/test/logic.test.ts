import { describe, expect, it } from 'vitest';
import {
  URGENCY_WEIGHTS,
  haversineKm,
  nearest,
  shelterShortlist,
  urgencyScore,
  welfareCheckMessage,
} from '../src/logic';

describe('urgencyScore', () => {
  it('matches the published formula', () => {
    // 40*(4/5) + 30*(60/120) + 30*1 = 32 + 15 + 30 = 77
    const s = urgencyScore({ severity: 4, silentMinutes: 60, vulnerable: true });
    expect(s).toEqual({ severityPart: 32, silencePart: 15, vulnerabilityPart: 30, total: 77 });
  });

  it('caps silence at 120 minutes', () => {
    expect(urgencyScore({ severity: 5, silentMinutes: 600, vulnerable: false }).silencePart).toBe(30);
    expect(urgencyScore({ severity: 5, silentMinutes: 120, vulnerable: false }).total).toBe(70);
  });

  it('is 100 at the maximum and never leaves 0..100', () => {
    expect(urgencyScore({ severity: 5, silentMinutes: 120, vulnerable: true }).total).toBe(100);
    expect(urgencyScore({ severity: 99, silentMinutes: 1e9, vulnerable: true }).total).toBe(100);
    expect(urgencyScore({ severity: -3, silentMinutes: -10, vulnerable: false }).total).toBe(0);
    expect(urgencyScore({ severity: Number.NaN, silentMinutes: Number.NaN, vulnerable: false }).total).toBe(0);
  });

  it('weights sum to 100 and can be overridden', () => {
    expect(URGENCY_WEIGHTS.severity + URGENCY_WEIGHTS.silence + URGENCY_WEIGHTS.vulnerability).toBe(100);
    const s = urgencyScore({ severity: 5, silentMinutes: 0, vulnerable: false }, { severity: 10, silence: 0, vulnerability: 0 });
    expect(s.total).toBe(10);
  });

  it('ranks a vulnerable person above a non-vulnerable one with the same silence', () => {
    const a = urgencyScore({ severity: 3, silentMinutes: 30, vulnerable: true }).total;
    const b = urgencyScore({ severity: 3, silentMinutes: 30, vulnerable: false }).total;
    expect(a).toBeGreaterThan(b);
  });
});

describe('haversineKm', () => {
  it('is zero for the same point', () => {
    expect(haversineKm({ lat: 32.77, lng: -96.8 }, { lat: 32.77, lng: -96.8 })).toBe(0);
  });

  it('matches known distances', () => {
    // One degree of latitude ~ 111.2 km
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111.19, 1);
    // Dallas (32.7767, -96.7970) to Houston (29.7604, -95.3698) ~ 362 km great-circle
    expect(haversineKm({ lat: 32.7767, lng: -96.797 }, { lat: 29.7604, lng: -95.3698 })).toBeGreaterThan(355);
    expect(haversineKm({ lat: 32.7767, lng: -96.797 }, { lat: 29.7604, lng: -95.3698 })).toBeLessThan(370);
  });

  it('is symmetric and handles the antimeridian', () => {
    const a = { lat: 10, lng: 179.5 };
    const b = { lat: 10, lng: -179.5 };
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 9);
    expect(haversineKm(a, b)).toBeLessThan(120);
  });

  it('picks the nearest item', () => {
    const items = [
      { id: 1, lat: 32.8, lng: -96.8 },
      { id: 2, lat: 32.771, lng: -96.827 },
      { id: 3, lat: 33.0, lng: -97.0 },
    ];
    expect(nearest({ lat: 32.7705, lng: -96.8265 }, items)?.item.id).toBe(2);
    expect(nearest({ lat: 0, lng: 0 }, [])).toBeNull();
  });
});

describe('shelterShortlist', () => {
  const base = { status: 'open', capacity: 2, acceptsPets: true, accessible: true };
  const offers = [
    { ...base, id: 1n, lat: 32.78, lng: -96.82 },
    { ...base, id: 2n, lat: 32.771, lng: -96.826, acceptsPets: false },
    { ...base, id: 3n, lat: 32.772, lng: -96.826, accessible: false },
    { ...base, id: 4n, lat: 32.773, lng: -96.826, capacity: 0 },
    { ...base, id: 5n, lat: 34.0, lng: -96.8 },
  ];
  it('filters by pets, accessibility, capacity and distance', () => {
    const ids = shelterShortlist({ lat: 32.7705, lng: -96.8265, hasPets: true, needsAccessible: true }, offers).map(o => o.offer.id);
    expect(ids).toEqual([1n]);
  });
  it('ranks nearest first', () => {
    const ids = shelterShortlist({ lat: 32.7705, lng: -96.8265, hasPets: false, needsAccessible: false }, offers).map(o => o.offer.id);
    expect(ids).toEqual([2n, 3n, 1n]);
  });
});

describe('welfareCheckMessage', () => {
  it('never claims a confirmed emergency', () => {
    const m = welfareCheckMessage({ displayName: 'A', silentMinutes: 33, zoneName: 'Z', centerName: 'C', centerKm: 1.234 });
    expect(m).toMatch(/welfare check/i);
    expect(m).not.toMatch(/confirmed emergency/i);
    expect(m).toContain('1.2 km');
  });
});
