// Triage agent: one sentence per missing case explaining why it ranks where it does.
// It receives the score inputs as read-only facts and NEVER changes the score.
// Batches up to 10 cases per model call to stay inside free-tier limits.
import { z } from 'zod';
import { llm, type LlmClient, type Source } from './llm';
import type { CaseRow, ZoneRow } from './types';

export const TRIAGE_BATCH = 10;

export const TriageSchema = z.object({
  results: z
    .array(
      z.object({
        caseId: z.string().describe('The case id exactly as given'),
        reason: z.string().min(10).max(300).describe('One sentence for a responder'),
      })
    )
    .min(1),
});

export type TriageCase = Pick<
  CaseRow,
  | 'id'
  | 'displayName'
  | 'silentMinutes'
  | 'severity'
  | 'vulnerabilityFlag'
  | 'hasPets'
  | 'urgencyScore'
  | 'scoreSeverity'
  | 'scoreSilence'
  | 'scoreVulnerability'
  | 'centerDistanceKm'
  | 'sos'
  | 'sosNote'
  | 'viaMesh'
  | 'meshHops'
>;

export interface TriageOutput {
  caseId: bigint;
  rationale: string;
  source: Source;
}

const SYSTEM = [
  'You are the Triage agent for a disaster welfare-check system (concept prototype).',
  'For each case write ONE plain sentence telling a responder why this person needs a welfare check now.',
  'Use only the facts given. Do not invent medical conditions. Do not restate or change the score.',
  'Never say "confirmed emergency": a silent phone may only mean a dead battery or lost signal.',
  'If a case says the person sent an SOS, lead with that: they asked for help, possibly relayed phone-to-phone because they had no signal. Do not mention hop counts.',
].join(' ');

export function triagePrompt(cases: TriageCase[], zone: Pick<ZoneRow, 'name' | 'hazard' | 'summary'> | undefined): string {
  const z = zone ? `Zone: ${zone.name}. Hazard: ${zone.hazard}. Summary: ${zone.summary}` : 'Zone: unknown';
  const lines = cases.map(
    c =>
      `- caseId ${c.id}: silent ${Math.round(c.silentMinutes)} min; zone severity ${c.severity}/5; ` +
      `vulnerable ${c.vulnerabilityFlag ? 'yes' : 'no'}; pets ${c.hasPets ? 'yes' : 'no'}; ` +
      `urgency ${c.urgencyScore.toFixed(1)}/100 (severity ${c.scoreSeverity}, silence ${c.scoreSilence}, vulnerability ${c.scoreVulnerability}); ` +
      `nearest center ${c.centerDistanceKm >= 0 ? `${c.centerDistanceKm.toFixed(1)} km` : 'unknown'}` +
      (c.sos ? `; SENT AN SOS${c.viaMesh ? ' with no signal, relayed phone-to-phone' : ''}${c.sosNote ? `, message: "${c.sosNote}"` : ''}` : '')
  );
  return `${z}\n\nCases:\n${lines.join('\n')}\n\nReturn {"results":[{"caseId":"...","reason":"..."}]} with one entry per case.`;
}

/** Deterministic template used when the model is unavailable. */
export function fallbackReason(c: TriageCase, hazard = 'hazard'): string {
  const parts = [`Silent ${Math.round(c.silentMinutes)} min inside a severity ${c.severity} ${hazard} zone`];
  if (c.sos) {
    const route = c.viaMesh ? ' with no signal (relayed phone-to-phone)' : '';
    const note = c.sosNote ? `: "${c.sosNote}"` : '';
    return `Sent an SOS${route}${note} — inside a severity ${c.severity} ${hazard} zone${c.vulnerabilityFlag ? ', self-reported as vulnerable' : ''}; send a welfare check.`;
  }
  if (c.vulnerabilityFlag) parts.push('self-reported as vulnerable');
  if (c.hasPets) parts.push('has pets');
  const where = c.centerDistanceKm >= 0 ? `; last seen ${c.centerDistanceKm.toFixed(1)} km from the nearest center` : '';
  return `${parts.join(', ')}${where} — status unknown, the phone may simply be off or out of signal.`;
}

export async function runTriage(
  cases: TriageCase[],
  zone: Pick<ZoneRow, 'name' | 'hazard' | 'summary'> | undefined,
  client: LlmClient = llm()
): Promise<TriageOutput[]> {
  const out: TriageOutput[] = [];
  for (let i = 0; i < cases.length; i += TRIAGE_BATCH) {
    const batch = cases.slice(i, i + TRIAGE_BATCH);
    const hazard = zone?.hazard && zone.hazard !== 'none' ? zone.hazard : 'hazard';
    const res = await client.generateJson({
      task: 'triage',
      system: SYSTEM,
      prompt: triagePrompt(batch, zone),
      schema: TriageSchema,
      fallback: () => ({ results: batch.map(c => ({ caseId: String(c.id), reason: fallbackReason(c, hazard) })) }),
    });
    const byId = new Map(res.data.results.map(r => [r.caseId, r.reason]));
    for (const c of batch) {
      const reason = byId.get(String(c.id));
      // A case the model skipped gets the template, tagged honestly as fallback.
      if (reason && res.source === 'llm') out.push({ caseId: c.id, rationale: reason, source: 'llm' });
      else out.push({ caseId: c.id, rationale: reason ?? fallbackReason(c, hazard), source: reason ? res.source : 'fallback' });
    }
  }
  return out;
}
