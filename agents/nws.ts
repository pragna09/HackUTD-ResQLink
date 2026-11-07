// US National Weather Service active alerts for a point.
// Docs: https://www.weather.gov/documentation/services-web-api (User-Agent required)
// Route: GET https://api.weather.gov/alerts/active?point={lat},{lng}  (GeoJSON FeatureCollection)
// NWS asks clients not to poll more than every 30 s; the weather agent runs far less often.
import { env } from './config';
import type { NwsAlert } from './types';

export interface NwsResult {
  ok: boolean;
  alerts: NwsAlert[];
  error?: string;
}

export async function fetchActiveAlerts(lat: number, lng: number, timeoutMs = 8000): Promise<NwsResult> {
  const url = `https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lng.toFixed(4)}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': env.NWS_USER_AGENT, Accept: 'application/geo+json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, alerts: [], error: `NWS HTTP ${res.status}` };
    const body = (await res.json()) as { features?: Array<{ properties?: Record<string, unknown> }> };
    const alerts = (body.features ?? []).slice(0, 5).map(f => {
      const p = f.properties ?? {};
      return {
        event: String(p.event ?? ''),
        severity: String(p.severity ?? ''),
        headline: String(p.headline ?? ''),
        description: String(p.description ?? '').slice(0, 600),
      };
    });
    return { ok: true, alerts };
  } catch (e) {
    return { ok: false, alerts: [], error: e instanceof Error ? e.message : String(e) };
  }
}
