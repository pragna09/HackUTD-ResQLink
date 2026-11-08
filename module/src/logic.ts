// Pure, dependency-free logic shared by the SpacetimeDB module, the agents worker, the web app and tests.
// Code decides every number here. Language models never compute scores, distances or nearest choices.

/**
 * Urgency weights. A TUNABLE, UNVALIDATED model chosen for a hackathon demo.
 * score = severity * (sev/5) + silence * (min(silentMin, cap)/cap) + vulnerability * flag
 * The three weights sum to 100, so the score reads as 0–100.
 */
export const URGENCY_WEIGHTS = {
  severity: 40,
  silence: 30,
  vulnerability: 30,
} as const;

/** Silence stops adding urgency after this many minutes. */
export const SILENCE_CAP_MIN = 120;
/** A heartbeat older than this counts as "went silent". Phones ping every 60 s. */
export const SILENCE_THRESHOLD_MIN = 10;
/** Zones at or above this severity are scanned for silent users. */
export const MIN_SEVERITY_FOR_SCAN = 3;
/** Scheduled scan interval. */
export const SCAN_INTERVAL_SEC = 30;
/** Heartbeat interval used by /app. */
export const HEARTBEAT_INTERVAL_SEC = 60;

export interface LatLng {
  lat: number;
  lng: number;
}

export interface UrgencyInputs {
  /** Zone severity, 1–5. */
  severity: number;
  /** Minutes since last heartbeat. */
  silentMinutes: number;
  /** Self-reported vulnerability flag. */
  vulnerable: boolean;
}

export interface UrgencyBreakdown {
  severityPart: number;
  silencePart: number;
  vulnerabilityPart: number;
  total: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

/** The urgency formula. Inputs are clamped so bad data cannot push the score outside 0–100. */
export function urgencyScore(
  input: UrgencyInputs,
  weights: { severity: number; silence: number; vulnerability: number } = URGENCY_WEIGHTS
): UrgencyBreakdown {
  const sev = clamp(Number.isFinite(input.severity) ? input.severity : 0, 0, 5);
  const silent = clamp(Number.isFinite(input.silentMinutes) ? input.silentMinutes : 0, 0, SILENCE_CAP_MIN);
  const severityPart = weights.severity * (sev / 5);
  const silencePart = weights.silence * (silent / SILENCE_CAP_MIN);
  const vulnerabilityPart = weights.vulnerability * (input.vulnerable ? 1 : 0);
  return {
    severityPart: round1(severityPart),
    silencePart: round1(silencePart),
    vulnerabilityPart: round1(vulnerabilityPart),
    total: round1(severityPart + silencePart + vulnerabilityPart),
  };
}

const EARTH_RADIUS_KM = 6371.0088;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in kilometres (haversine formula). */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Nearest item by haversine distance, or null for an empty list. */
export function nearest<T extends LatLng>(point: LatLng, items: Iterable<T>): { item: T; km: number } | null {
  let best: { item: T; km: number } | null = null;
  for (const item of items) {
    const km = haversineKm(point, item);
    if (best === null || km < best.km) best = { item, km };
  }
  return best;
}

export function isInsideZone(point: LatLng, zone: { centerLat: number; centerLng: number; radiusKm: number }): boolean {
  return haversineKm(point, { lat: zone.centerLat, lng: zone.centerLng }) <= zone.radiusKm;
}

/** Whole and fractional minutes between two microsecond timestamps. Never negative. */
export function minutesBetweenMicros(laterMicros: bigint, earlierMicros: bigint): number {
  const diff = laterMicros - earlierMicros;
  if (diff <= 0n) return 0;
  return Number(diff) / 60_000_000;
}

/** The exact alert wording. Never says "confirmed emergency". */
export function welfareCheckMessage(args: {
  displayName: string;
  silentMinutes: number;
  zoneName: string;
  centerName: string;
  centerKm: number;
}): string {
  return (
    `Welfare check requested for ${args.displayName}: no location update for ` +
    `${Math.round(args.silentMinutes)} min inside ${args.zoneName}. Last known position is ` +
    `${args.centerKm.toFixed(1)} km from ${args.centerName}. Status unknown — a dead battery and lost signal look the same.`
  );
}
