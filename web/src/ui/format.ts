/** Urgency ramp (matches the CSS custom properties). */
export function urgencyColor(score: number): string {
  if (score >= 80) return '#a01d3c';
  if (score >= 65) return '#d4471c';
  if (score >= 50) return '#e8833a';
  if (score >= 35) return '#e0b23a';
  return '#b8b09e';
}

export function severityColor(sev: number): string {
  return ['#c9c2b2', '#c9c2b2', '#e0b23a', '#e8833a', '#d4471c', '#a01d3c'][Math.max(0, Math.min(5, sev))];
}

export function minutesLabel(min: number): string {
  if (min < 1) return '<1 min';
  if (min < 90) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${Math.round(min - h * 60)} min`;
}

export function ago(d: Date, now = Date.now()): string {
  return `${minutesLabel((now - d.getTime()) / 60_000)} ago`;
}

export const ageLabel: Record<string, string> = { '0-17': 'under 18', '18-64': '18–64', '65+': '65+' };
