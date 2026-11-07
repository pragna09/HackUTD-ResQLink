// Weather Research agent: NWS active alerts + stored news items -> hazard rating for one zone.
// The model reads text and returns {hazard, severity, confidence, summary, evidence}. Code validates it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { AGENTS_DIR } from './config';
import { llm, type LlmClient, type LlmResult } from './llm';
import type { NewsRow, NwsAlert, ZoneRow } from './types';

export const WeatherSchema = z.object({
  hazard: z.string().min(1).max(40).describe('Short hazard type, e.g. flood, flash flood, tornado, wildfire, none'),
  severity: z.number().int().min(1).max(5).describe('1 = no threat, 3 = people likely cut off, 5 = catastrophic'),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1).max(500).describe('Exactly two sentences'),
  evidence: z.array(z.string().max(300)).max(6).describe('Short quotes copied from the inputs'),
});
export type WeatherRating = z.infer<typeof WeatherSchema>;

export interface WeatherInput {
  zone: Pick<ZoneRow, 'id' | 'name' | 'centerLat' | 'centerLng' | 'radiusKm'>;
  news: Pick<NewsRow, 'text'>[];
  nwsAlerts: NwsAlert[];
  nwsError?: string;
}

const SYSTEM = [
  'You are the Weather Research agent for a disaster welfare-check system (concept prototype).',
  'Rate the hazard for ONE zone using ONLY the NWS alerts and news items provided. Do not invent facts.',
  'Severity scale: 1 none/minor, 2 elevated, 3 people likely cut off or unreachable, 4 major, 5 catastrophic.',
  'confidence is how well the inputs support the rating (0 to 1). summary must be exactly two sentences.',
  'evidence is a list of short snippets copied from the inputs that justify the rating.',
].join(' ');

export function weatherPrompt(input: WeatherInput): string {
  const alerts = input.nwsAlerts.length
    ? input.nwsAlerts.map((a, i) => `${i + 1}. [${a.severity}] ${a.event}: ${a.headline}`).join('\n')
    : `none${input.nwsError ? ` (NWS lookup failed: ${input.nwsError})` : ''}`;
  const news = input.news.length ? input.news.map((n, i) => `${i + 1}. ${n.text}`).join('\n') : 'none';
  return [
    `Zone: ${input.zone.name} (id ${input.zone.id}), center ${input.zone.centerLat.toFixed(4)}, ${input.zone.centerLng.toFixed(4)}, radius ${input.zone.radiusKm} km.`,
    `NWS active alerts for the zone center:\n${alerts}`,
    `News items stored for this zone:\n${news}`,
  ].join('\n\n');
}

type StoredWeather = Record<string, WeatherRating | string>;
let stored: StoredWeather | undefined;
export function storedWeatherFallback(zoneId: string, news: Pick<NewsRow, 'text'>[] = []): WeatherRating {
  stored ??= JSON.parse(readFileSync(resolve(AGENTS_DIR, 'fallbacks', 'weather.json'), 'utf8')) as StoredWeather;
  const hit = stored[zoneId];
  if (hit && typeof hit === 'object') return hit;
  const d = stored._default as WeatherRating;
  return { ...d, evidence: news.slice(0, 3).map(n => n.text.slice(0, 200)) };
}

export async function runWeatherResearch(input: WeatherInput, client: LlmClient = llm()): Promise<LlmResult<WeatherRating>> {
  return client.generateJson({
    task: 'weather',
    system: SYSTEM,
    prompt: weatherPrompt(input),
    schema: WeatherSchema,
    fallback: () => storedWeatherFallback(input.zone.id, input.news),
  });
}
