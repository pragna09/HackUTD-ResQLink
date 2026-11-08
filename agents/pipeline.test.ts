// Agent pipeline in fallback / rogue-model mode: no network, no keys.
import { describe, expect, it } from 'vitest';
import { buildSeedDataset, ZONES } from '../module/src/seed_data';
import { runDispatch } from './dispatch';
import { createLlm, type ProviderAdapter } from './llm';
import { fallbackAdvice, runMonitor } from './monitor';
import { fallbackNeeds, runTriage } from './triage';

const off = createLlm({ adapter: { name: 'fake', model: 'none', available: false, unavailableReason: 'test', complete: async () => '' } as ProviderAdapter });
const replying = (text: string) => createLlm({ adapter: { name: 'fake', model: 'fake', available: true, complete: async () => text } as ProviderAdapter });

const zone = { ...ZONES[0], severity: 4, summary: 's', hazard: 'earthquake' };
const centers = buildSeedDataset().centers;
const c = {
  id: 7n, displayName: 'Ana', silentMinutes: 95, severity: 4, urgencyScore: 85, lastLat: zone.centerLat, lastLng: zone.centerLng,
  rationale: 'Vulnerable and silent.', needs: ['medical'], sos: true, sosNote: 'Trapped', viaMesh: false, vulnerabilityFlag: true, hasPets: false,
};

describe('agent pipeline', () => {
  it('Monitor falls back to advice for the disaster type', async () => {
    const r = await runMonitor(zone, [], off);
    expect(r.source).toBe('fallback');
    expect(r.data.warning).toMatch(/earthquake/i);
    expect(fallbackAdvice('flash flood', 3).instructions[0]).toMatch(/higher ground/i);
  });

  it('Triage tags needs from the household and SOS', async () => {
    const base = { id: 1n, displayName: 'A', silentMinutes: 40, severity: 4, vulnerabilityFlag: true, hasPets: false, urgencyScore: 70, scoreSeverity: 32, scoreSilence: 10, scoreVulnerability: 30, centerDistanceKm: 1 };
    expect(fallbackNeeds({ ...base, sos: true, person: { ageGroup: '18-64', dependentsChildren: 0, dependentsElderly: 1, needsAccessible: false, hasPets: false, hasWifi: true, checkInStatus: 'help' } }, 'flood').sort()).toEqual(['evacuation', 'medical', 'rescue']);
    const [r] = await runTriage([base], zone, off);
    expect(r.needs).toEqual(['medical']);
  });

  it('Dispatch: code plan always includes the disaster services + insurer; the model can add but never remove', async () => {
    const rogue = replying('{"message":"SOS from Ana trapped after the earthquake at the given coordinates; please send rescue and medical help.","addServices":["police"]}');
    const d = await runDispatch(c, zone, centers, undefined, rogue);
    expect(d.source).toBe('llm');
    expect(d.targets.map(t => t.type)).toEqual(['fire', 'hospital', 'police', 'insurer']);
    const fb = await runDispatch(c, zone, centers, undefined, off);
    expect(fb.targets.map(t => t.type)).toEqual(['fire', 'hospital', 'insurer']);
    expect(fb.message).toMatch(/Unverified/);
    const scary = await runDispatch(c, zone, centers, undefined, replying('{"message":"This is a confirmed emergency, people are dying here now.","addServices":[]}'));
    expect(scary.message).not.toMatch(/confirmed emergency/i);
  });
});
