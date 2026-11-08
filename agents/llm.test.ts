import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createLlm, extractJson, type ProviderAdapter } from './llm';
import { runTriage } from './triage';
import { WeatherSchema, storedWeatherFallback } from './weather';

const fake = (replies: string[], available = true): ProviderAdapter & { calls: number } => {
  const a = {
    name: 'fake' as const,
    model: 'fake-1',
    available,
    calls: 0,
    async complete() {
      a.calls++;
      return replies.shift() ?? '';
    },
  };
  return a;
};
const schema = z.object({ n: z.number() });
const task = { task: 't', system: 's', prompt: 'p', schema, fallback: () => ({ n: -1 }) };

describe('llm wrapper', () => {
  it('returns validated llm output tagged llm', async () => {
    const r = await createLlm({ adapter: fake(['{"n": 3}']) }).generateJson(task);
    expect(r).toMatchObject({ source: 'llm', data: { n: 3 }, cached: false });
  });
  it('retries once on bad JSON, then succeeds', async () => {
    const a = fake(['not json', '```json\n{"n": 4}\n```']);
    const r = await createLlm({ adapter: a }).generateJson(task);
    expect(r.source).toBe('llm');
    expect(a.calls).toBe(2);
  });
  it('falls back after two bad replies and tags it fallback', async () => {
    const a = fake(['{"n":"x"}', '{}']);
    const r = await createLlm({ adapter: a }).generateJson(task);
    expect(r).toMatchObject({ source: 'fallback', data: { n: -1 } });
    expect(a.calls).toBe(2);
  });
  it('never calls an unavailable provider', async () => {
    const a = fake(['{"n":1}'], false);
    const r = await createLlm({ adapter: a }).generateJson(task);
    expect(r.source).toBe('fallback');
    expect(a.calls).toBe(0);
  });
  it('caches by input hash', async () => {
    const a = fake(['{"n": 5}']);
    const c = createLlm({ adapter: a });
    await c.generateJson(task);
    const r = await c.generateJson(task);
    expect(r).toMatchObject({ source: 'llm', cached: true, data: { n: 5 } });
    expect(a.calls).toBe(1);
  });
  it('strips think blocks', () => {
    expect(extractJson('<think>{"n":0}</think> {"n": 7}')).toEqual({ n: 7 });
  });
});

describe('agents in fallback mode', () => {
  const off = createLlm({ adapter: fake([], false) });
  const c = {
    id: 9n,
    displayName: 'Test',
    silentMinutes: 42,
    severity: 4,
    vulnerabilityFlag: true,
    hasPets: true,
    urgencyScore: 72.5,
    scoreSeverity: 32,
    scoreSilence: 10.5,
    scoreVulnerability: 30,
    centerDistanceKm: 2.1,
    lastLat: 32.77,
    lastLng: -96.82,
  };

  it('stored weather fallback validates', () => {
    expect(WeatherSchema.parse(storedWeatherFallback('trinity-bottoms')).severity).toBe(4);
    expect(WeatherSchema.parse(storedWeatherFallback('nowhere')).severity).toBe(2);
  });

  it('triage fallback is tagged and never says "confirmed emergency"', async () => {
    const [r] = await runTriage([c], { name: 'Z', hazard: 'flood', summary: 's' }, off);
    expect(r.source).toBe('fallback');
    expect(r.rationale).not.toMatch(/confirmed emergency/i);
  });


});
