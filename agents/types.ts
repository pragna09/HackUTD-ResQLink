// Plain domain shapes the agents work with. They mirror the module's tables (camelCase fields) but do
// not depend on generated bindings, so the agents typecheck and run their sample tests without them.
// stdb.ts maps generated rows onto these shapes.

export interface ZoneRow {
  id: string;
  name: string;
  centerLat: number;
  centerLng: number;
  radiusKm: number;
  hazard: string;
  severity: number;
  confidence: number;
  summary: string;
  evidence: string[];
  source: string;
  researchStatus: string;
  /** Monitor agent output ('' / [] until written). */
  safetyWarning?: string;
  safetyAdvice?: string[];
}

export interface NewsRow {
  id: bigint;
  area: string;
  text: string;
  timestampMs: number;
}

export interface CaseRow {
  id: bigint;
  /** Person's identity (hex), to look up their household. */
  user?: string;
  zoneId: string;
  displayName: string;
  silentMinutes: number;
  severity: number;
  vulnerabilityFlag: boolean;
  hasPets: boolean;
  scoreSeverity: number;
  scoreSilence: number;
  scoreVulnerability: number;
  urgencyScore: number;
  lastLat: number;
  lastLng: number;
  rationale: string;
  status: string;
  assignedCenter: number | undefined;
  centerDistanceKm: number;
  /** Mesh relay: the person sent an SOS (possibly hop by hop over nearby phones). */
  sos?: boolean;
  sosNote?: string;
  viaMesh?: boolean;
  meshHops?: number;
  /** Triage agent output. */
  rationaleSource?: string;
  needs?: string[];
  /** Dispatch agent output. */
  dispatched?: boolean;
}

/** Household details from the phone app, used by Triage. */
export interface PersonRow {
  ageGroup: string;
  dependentsChildren: number;
  dependentsElderly: number;
  needsAccessible: boolean;
  hasPets: boolean;
  hasWifi: boolean;
  checkInStatus: string;
}

export interface CenterRow {
  id: number;
  type: string;
  name: string;
  lat: number;
  lng: number;
}

export interface NwsAlert {
  event: string;
  severity: string;
  headline: string;
  description: string;
}
