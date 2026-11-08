// UI-side shapes. Generated binding rows are mapped onto these in live.ts, so components never
// depend on generated types and the mock backend can produce the same shapes.

export interface Profile {
  identity: string;
  displayName: string;
  ageGroup: string;
  phone: string;
  dependentsChildren: number;
  dependentsElderly: number;
  needsAccessible: boolean;
  vulnerabilityFlag: boolean;
  hasPets: boolean;
  hasWifi: boolean;
  /** Answer to the "Are you safe?" check-in: '' | 'safe' | 'help'. */
  checkInStatus: string;
  checkInAt: Date | undefined;
  optIn: boolean;
  isSynthetic: boolean;
  simSilent: boolean;
}

export interface Ping {
  user: string;
  lat: number;
  lng: number;
  accuracy: number;
  at: Date;
}

export interface Zone {
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
  updatedAt: Date;
  researchStatus: string;
}

export interface News {
  id: string;
  area: string;
  text: string;
  at: Date;
  isSynthetic: boolean;
}

export interface Center {
  id: number;
  type: string;
  name: string;
  lat: number;
  lng: number;
  isSynthetic: boolean;
}

export interface Case {
  id: string;
  user: string;
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
  lastSeen: Date;
  rationale: string;
  rationaleSource: string;
  status: string;
  assignedCenter: number | undefined;
  centerDistanceKm: number;
  /** The person sent an SOS. SOS cases rank first and never auto-resolve. */
  sos: boolean;
  sosNote: string;
  /** Arrived over the phone-to-phone mesh (the person's phone had no signal). */
  viaMesh: boolean;
  meshHops: number;
  relayedBy: string;
  openedAt: Date;
}

/** A message a phone with signal uploaded on behalf of the mesh. */
export interface MeshMsg {
  id: string;
  kind: string;
  origin: string;
  displayName: string;
  createdAt: Date;
  receivedAt: Date;
  hops: number;
  relayedBy: string;
  path: Array<[number, number]>;
  note: string;
  caseId: string | undefined;
}

export interface Alert {
  id: string;
  caseId: string;
  centerId: number;
  message: string;
  status: string;
  at: Date;
}

export interface Snapshot {
  profiles: Map<string, Profile>;
  pings: Map<string, Ping>;
  zones: Zone[];
  news: News[];
  centers: Center[];
  cases: Case[];
  alerts: Alert[];
  meshMessages: MeshMsg[];
  /** Model every agent uses, picked on the dashboard: 'gemini' | 'nvidia'. */
  llmProvider: string;
}

export const emptySnapshot = (): Snapshot => ({
  profiles: new Map(),
  pings: new Map(),
  zones: [],
  news: [],
  centers: [],
  cases: [],
  alerts: [],
  meshMessages: [],
  llmProvider: 'gemini',
});

/** What the phone screen saves: demo sign-in + household. vulnerabilityFlag is derived by the module. */
export interface ProfileInput {
  displayName: string;
  phone: string;
  ageGroup: string;
  dependentsChildren: number;
  dependentsElderly: number;
  needsAccessible: boolean;
  hasPets: boolean;
  optIn: boolean;
}

/** Reducer calls the UI can make. IDs are strings in the UI and converted to bigint at the edge. */
export interface Api {
  updateProfile(a: ProfileInput): Promise<void>;
  /** Demo sign-out: forget this browser's identity and start fresh. */
  signOut(): void;
  /** "Are you safe?" answer. 'help' opens an SOS case; 'safe' closes the person's case. */
  respondCheckIn(a: { status: 'safe' | 'help'; note: string; location?: { lat: number; lng: number; accuracy: number } }): Promise<void>;
  ping(a: { lat: number; lng: number; accuracy: number }): Promise<void>;
  requestResearch(zoneId: string): Promise<void>;
  simulateDisaster(zoneId: string, severity: number): Promise<void>;
  silenceUsers(zoneId: string, count: number): Promise<void>;
  resetDemo(): Promise<void>;
  acknowledgeAlert(alertId: string): Promise<void>;
  setLlmProvider(provider: string): Promise<void>;
  /** Upload mesh messages as a gateway would (JSON array from module/src/mesh.ts encodeUpload). */
  relayMesh(payload: string): Promise<void>;
}

export type ConnStatus = 'connecting' | 'live' | 'error' | 'disconnected';

export interface Backend {
  mode: 'spacetimedb' | 'mock';
  api: Api;
  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(cb: () => void): () => void;
  getState(): LiveState;
}

export interface LiveState {
  mode: 'spacetimedb' | 'mock';
  status: ConnStatus;
  error?: string;
  identity?: string;
  data: Snapshot;
  /** Increments on every change; handy as a React key / memo dep. */
  version: number;
}
