// Dispatch agent (pipeline step 3): decide who to contact and write the message.
//   Code: the plan = nearest center of every service the disaster requires + one per Triage need + the insurer.
//   Agent: may ADD services (e.g. hospital for medical equipment) and writes one dispatch message.
//   Code again: merges the plan with the additions (nothing required can be dropped); the module re-checks.
import { z } from 'zod';
import { SERVICE_TYPES, planDispatch, type DispatchTarget } from '../module/src/logic';
import { llm, type LlmClient, type Source } from './llm';
import type { CaseRow, CenterRow, PersonRow, ZoneRow } from './types';

export const DispatchSchema = z.object({
  message: z.string().min(20).max(600).describe('The dispatch message every chosen service and the insurer receive'),
  addServices: z.array(z.enum(SERVICE_TYPES)).max(3).describe('Extra service types to contact beyond the plan; [] if none'),
});
export type DispatchDecision = z.infer<typeof DispatchSchema>;

export type DispatchCaseInput = Pick<
  CaseRow,
  'id' | 'displayName' | 'silentMinutes' | 'severity' | 'urgencyScore' | 'lastLat' | 'lastLng' | 'rationale' | 'needs' | 'sos' | 'sosNote' | 'viaMesh' | 'vulnerabilityFlag' | 'hasPets'
>;

export interface DispatchOutput {
  caseId: bigint;
  centerIds: number[];
  targets: DispatchTarget<CenterRow>[];
  message: string;
  source: Source;
}

const SYSTEM = [
  'You are the Dispatch agent for a disaster response system (concept prototype).',
  'You receive one case, the triage reason and a code-built plan of services to contact.',
  'Write ONE clear dispatch message (2 to 4 sentences) with who, where (coordinates), the disaster, why it is urgent, and what help is likely needed.',
  'You may add services the plan is missing (police, fire, hospital) if the facts call for it. You cannot remove planned services.',
  'Never say "confirmed emergency": this is an unverified welfare check or SOS. Do not invent medical conditions.',
  'Refer to people by name or as "they"; never guess gender from a name.',
].join(' ');

export function dispatchPrompt(c: DispatchCaseInput, zone: Pick<ZoneRow, 'name' | 'hazard'> | undefined, plan: DispatchTarget<CenterRow>[], person?: PersonRow): string {
  const household = person
    ? `household: ${person.dependentsChildren} children, ${person.dependentsElderly} elderly; accessibility needs ${person.needsAccessible ? 'yes' : 'no'}; pets ${person.hasPets ? 'yes' : 'no'}`
    : `vulnerable ${c.vulnerabilityFlag ? 'yes' : 'no'}; pets ${c.hasPets ? 'yes' : 'no'}`;
  return [
    `Case ${c.id}: ${c.displayName} (refer to them by name or as "they", never "he" or "she"), last position ${c.lastLat.toFixed(5)}, ${c.lastLng.toFixed(5)}.`,
    `Disaster: ${zone?.hazard ?? 'unknown'} in ${zone?.name ?? 'unknown zone'}, severity ${c.severity}/5. Urgency ${c.urgencyScore.toFixed(1)}/100.`,
    c.sos ? `They SENT AN SOS${c.viaMesh ? ' with no signal, relayed phone-to-phone' : ''}${c.sosNote ? `: "${c.sosNote}"` : ''}.` : `Silent for ${Math.round(c.silentMinutes)} min.`,
    `${household}.`,
    `Triage: ${c.rationale || 'none'}. Needs: ${(c.needs ?? []).join(', ') || 'none flagged'}.`,
    `Plan (already chosen by code):\n${plan.map(p => `- ${p.type}: ${p.center.name} (${p.km.toFixed(1)} km, ${p.reason})`).join('\n')}`,
    'Return {"message": "...", "addServices": []}.',
  ].join('\n');
}

export function fallbackMessage(c: DispatchCaseInput, zone: Pick<ZoneRow, 'name' | 'hazard'> | undefined): string {
  const what = c.sos ? `SOS from ${c.displayName}${c.sosNote ? ` ("${c.sosNote}")` : ''}` : `${c.displayName} silent for ${Math.round(c.silentMinutes)} min`;
  const needs = c.needs?.length ? ` Likely needs: ${c.needs.join(', ')}.` : '';
  return (
    `${what} in ${zone?.name ?? 'a disaster zone'} (${zone?.hazard ?? 'hazard'}, severity ${c.severity}/5). ` +
    `Last position ${c.lastLat.toFixed(5)}, ${c.lastLng.toFixed(5)}.${needs} Unverified — please send a welfare check.`
  );
}

export async function runDispatch(
  c: DispatchCaseInput,
  zone: Pick<ZoneRow, 'name' | 'hazard'> | undefined,
  centers: CenterRow[],
  person?: PersonRow,
  client: LlmClient = llm()
): Promise<DispatchOutput> {
  const at = { lat: c.lastLat, lng: c.lastLng };
  const plan = planDispatch(at, zone?.hazard ?? '', c.needs ?? [], centers);
  const res = await client.generateJson({
    task: 'dispatch',
    system: SYSTEM,
    prompt: dispatchPrompt(c, zone, plan, person),
    schema: DispatchSchema,
    fallback: () => ({ message: fallbackMessage(c, zone), addServices: [] }),
  });
  // Merge: the plan stays, agent additions are appended.
  const targets = planDispatch(at, zone?.hazard ?? '', c.needs ?? [], centers, res.data.addServices);
  const message = /confirmed emergency/i.test(res.data.message) ? fallbackMessage(c, zone) : res.data.message;
  return { caseId: c.id, centerIds: targets.map(t => t.center.id), targets, message, source: res.source };
}
