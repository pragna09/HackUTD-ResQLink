// Monitor agent (pipeline step 1): when a zone becomes dangerous, write a short warning and safety
// instructions for everyone registered in it. They appear in the phone app's "Are you safe?" prompt.
// It runs after the zone is rated (Weather research or a simulated disaster) and never changes the rating.
import { z } from 'zod';
import { llm, type LlmClient, type LlmResult } from './llm';
import type { NewsRow, ZoneRow } from './types';

export const MonitorSchema = z.object({
  warning: z.string().min(5).max(160).describe('One short headline for people in the zone'),
  instructions: z.array(z.string().min(5).max(140)).min(2).max(5).describe('Concrete safety steps, most important first'),
});
export type MonitorAdvice = z.infer<typeof MonitorSchema>;

const SYSTEM = [
  'You are the Monitor agent for a disaster response system (concept prototype).',
  'Write a short warning and 3 to 5 concrete safety instructions for people inside the disaster zone.',
  'Base them on the hazard type, severity and the news provided. Plain words, imperative mood, no panic.',
  'Do not invent shelter addresses, phone numbers or official orders that are not in the inputs.',
].join(' ');

export function monitorPrompt(zone: Pick<ZoneRow, 'name' | 'hazard' | 'severity' | 'summary'>, news: Pick<NewsRow, 'text'>[]): string {
  const items = news.length ? news.map((n, i) => `${i + 1}. ${n.text}`).join('\n') : 'none';
  return [
    `Zone: ${zone.name}. Hazard: ${zone.hazard}. Severity ${zone.severity}/5.`,
    `Assessment: ${zone.summary}`,
    `News for this zone:\n${items}`,
    'Return {"warning": "...", "instructions": ["...", "..."]}.',
  ].join('\n\n');
}

/** Deterministic advice per disaster type, used when the model is unavailable. */
export function fallbackAdvice(hazard: string, severity: number): MonitorAdvice {
  const h = hazard.toLowerCase();
  const level = severity >= 4 ? 'Severe' : 'Active';
  if (/flood|surge|hurricane|storm/.test(h))
    return {
      warning: `${level} flooding in your area`,
      instructions: ['Move to higher ground or an upper floor now', 'Do not walk or drive through flood water', 'Turn off electricity at the main switch if water is rising', 'Keep your phone charged and answer the safety check'],
    };
  if (/quake/.test(h))
    return {
      warning: `${level} earthquake: expect aftershocks`,
      instructions: ['Drop, cover and hold on during shaking', 'Stay away from windows and damaged buildings', 'Check for gas leaks; do not use open flames', 'Text instead of calling to keep lines free'],
    };
  if (/fire|smoke/.test(h))
    return {
      warning: `${level} wildfire near you: be ready to leave`,
      instructions: ['Leave now if told to evacuate or you see flames', 'Close all windows and doors before leaving', 'Wear a mask or damp cloth against smoke', 'Take medicines, pets and documents with you'],
    };
  return {
    warning: `${level} emergency in your area`,
    instructions: ['Stay where you are safe and follow official guidance', 'Keep your phone charged', 'Check on neighbours who may need help'],
  };
}

export async function runMonitor(
  zone: Pick<ZoneRow, 'name' | 'hazard' | 'severity' | 'summary'>,
  news: Pick<NewsRow, 'text'>[],
  client: LlmClient = llm()
): Promise<LlmResult<MonitorAdvice>> {
  return client.generateJson({
    task: 'monitor',
    system: SYSTEM,
    prompt: monitorPrompt(zone, news),
    schema: MonitorSchema,
    fallback: () => fallbackAdvice(zone.hazard, zone.severity),
  });
}
