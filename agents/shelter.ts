// Shelter step. CODE builds and ranks the shortlist (distance, capacity, pets, accessibility).
// The Shelter agent may only choose an offer FROM that shortlist and writes a short handoff note.
// If it picks anything else, code's top pick is used and the result is tagged fallback.
import { z } from 'zod';
import { shelterShortlist } from '../module/src/logic';
import { llm, type LlmClient, type Source } from './llm';
import type { CaseRow, OfferRow } from './types';

export const ShelterSchema = z.object({
  offerId: z.string().describe('id of the chosen offer, copied exactly from the shortlist'),
  note: z.string().min(10).max(400).describe('Two short sentences for the host and the responder'),
});

export type ShelterCase = Pick<
  CaseRow,
  'id' | 'displayName' | 'lastLat' | 'lastLng' | 'hasPets' | 'vulnerabilityFlag' | 'silentMinutes' | 'severity'
>;

export interface ShortlistEntry {
  offer: OfferRow;
  km: number;
}

export interface ShelterOutput {
  caseId: bigint;
  offerId: bigint;
  note: string;
  source: Source;
}

export function buildShortlist(c: ShelterCase, offers: Iterable<OfferRow>): ShortlistEntry[] {
  return shelterShortlist(
    { lat: c.lastLat, lng: c.lastLng, hasPets: c.hasPets, needsAccessible: c.vulnerabilityFlag },
    offers
  );
}

const SYSTEM = [
  'You are the Shelter agent for a disaster welfare-check system (concept prototype).',
  'Pick ONE offer from the shortlist (it is already filtered and ranked by distance in code) and write a short handoff note',
  'for the volunteer host and the responder. Do not invent distances. The person has NOT been reached yet:',
  'say the spot is held in case responders find them needing shelter.',
].join(' ');

export function shelterPrompt(c: ShelterCase, shortlist: ShortlistEntry[]): string {
  const needs = [c.hasPets ? 'has pets' : 'no pets', c.vulnerabilityFlag ? 'needs accessible space' : 'no accessibility need'];
  const offers = shortlist.map(
    (s, i) =>
      `${i + 1}. offerId ${s.offer.id}: ${s.offer.hostName}, ${s.km.toFixed(1)} km, ${s.offer.capacity} spots, ` +
      `pets ${s.offer.acceptsPets ? 'ok' : 'no'}, accessible ${s.offer.accessible ? 'yes' : 'no'}`
  );
  return `Person: ${c.displayName}; ${needs.join('; ')}; silent ${Math.round(c.silentMinutes)} min; zone severity ${c.severity}/5.\n\nShortlist (ranked by code):\n${offers.join('\n')}`;
}

export function fallbackNote(c: ShelterCase, s: ShortlistEntry): string {
  const extras = [s.offer.acceptsPets ? 'pets welcome' : '', s.offer.accessible ? 'accessible' : ''].filter(Boolean).join(', ');
  return (
    `Holding 1 spot at ${s.offer.hostName} (${s.km.toFixed(1)} km${extras ? `, ${extras}` : ''}) for ${c.displayName}. ` +
    `Use it only if responders reach them and they need shelter; release it otherwise.`
  );
}

export async function runShelter(
  c: ShelterCase,
  shortlist: ShortlistEntry[],
  client: LlmClient = llm()
): Promise<ShelterOutput | null> {
  if (shortlist.length === 0) return null;
  const top = shortlist[0];
  const res = await client.generateJson({
    task: 'shelter',
    system: SYSTEM,
    prompt: shelterPrompt(c, shortlist),
    schema: ShelterSchema,
    fallback: () => ({ offerId: String(top.offer.id), note: fallbackNote(c, top) }),
  });
  const chosen = shortlist.find(s => String(s.offer.id) === res.data.offerId.trim());
  if (!chosen) {
    // Model picked something outside the shortlist: ignore it.
    return { caseId: c.id, offerId: top.offer.id, note: fallbackNote(c, top), source: 'fallback' };
  }
  return { caseId: c.id, offerId: chosen.offer.id, note: res.data.note, source: res.source };
}
