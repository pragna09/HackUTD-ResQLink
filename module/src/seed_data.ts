// Deterministic SYNTHETIC demo dataset: three disaster scenarios (Dallas earthquake, Los Angeles fire,
// Miami flood), 10 people each. Every person, place, center and news item is invented.
// Pure TypeScript with no SpacetimeDB imports, so the module (reset_demo / init), the /seed script,
// the web preview backend and tests all produce the same data.

export const SEED = 20261107;

export interface SeedZone {
  id: string;
  name: string;
  /** City label for the dashboard's "Simulate <hazard> in <city>" menu. Not stored in the zone table. */
  city: string;
  hazard: 'earthquake' | 'fire' | 'flood';
  centerLat: number;
  centerLng: number;
  radiusKm: number;
}

/**
 * none   = far outside the zone, phone keeps heartbeating. Never gets a case.
 * medium = inside the zone, silent 30–70 min, not vulnerable.
 * high   = inside the zone, silent 90–120 min, vulnerable.
 */
export type RiskTier = 'none' | 'medium' | 'high';

export interface SeedUser {
  /** Index 0..29, turned into a synthetic Identity by the module. */
  index: number;
  displayName: string;
  ageGroup: '0-17' | '18-64' | '65+';
  zoneId: string;
  riskTier: RiskTier;
  vulnerabilityFlag: boolean;
  hasPets: boolean;
  hasWifi: boolean;
  lat: number;
  lng: number;
  accuracy: number;
  /** Minutes before "now" of the last heartbeat. */
  minutesAgo: number;
  /** True = phone has gone quiet (stale heartbeat that stays stale). */
  silent: boolean;
}

export interface SeedCenter {
  id: number;
  type: 'police' | 'fire' | 'hospital';
  name: string;
  lat: number;
  lng: number;
}

export interface SeedNews {
  area: string;
  text: string;
  minutesAgo: number;
}

export interface SeedDataset {
  zones: SeedZone[];
  users: SeedUser[];
  centers: SeedCenter[];
  news: SeedNews[];
}

/** mulberry32: tiny deterministic PRNG. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KM_PER_DEG_LAT = 110.574;
const kmPerDegLng = (lat: number) => 111.32 * Math.cos((lat * Math.PI) / 180);

/** A point `km` away on compass bearing `bearingDeg` (0 = north, 90 = east). Flat-earth, fine at city scale. */
function offset(lat: number, lng: number, km: number, bearingDeg: number) {
  const a = (bearingDeg * Math.PI) / 180;
  return {
    lat: Math.round((lat + (km * Math.cos(a)) / KM_PER_DEG_LAT) * 1e6) / 1e6,
    lng: Math.round((lng + (km * Math.sin(a)) / kmPerDegLng(lat)) * 1e6) / 1e6,
  };
}

export const ZONES: readonly SeedZone[] = [
  { id: 'dallas-earthquake', name: 'Dallas Earthquake Zone (synthetic)', city: 'Dallas', hazard: 'earthquake', centerLat: 32.7767, centerLng: -96.797, radiusKm: 8 },
  { id: 'la-fire', name: 'Los Angeles Fire Zone (synthetic)', city: 'Los Angeles', hazard: 'fire', centerLat: 34.0522, centerLng: -118.2437, radiusKm: 6 },
  { id: 'miami-flood', name: 'Miami Flood Zone (synthetic)', city: 'Miami', hazard: 'flood', centerLat: 25.7617, centerLng: -80.1918, radiusKm: 5 },
];

/** Default zone for pages that show a single area (/app demo location). */
export const DEMO_ZONE: SeedZone = ZONES[0];

// People: 4 none, 3 medium, 3 high per zone. In each zone one high-risk person has Wi-Fi and one does not.
// Positions use western bearings (190°–340°) so Miami points stay on land, not in Biscayne Bay.
interface PersonSpec {
  name: string;
  tier: RiskTier;
  age: SeedUser['ageGroup'];
  wifi: boolean;
  pets?: boolean;
  /** Fraction of the zone radius: < 1 inside, > 1 outside. */
  dist: number;
  bearing: number;
  /** Minutes since last heartbeat (medium/high only). */
  silentMin?: number;
}

const PEOPLE: Record<string, PersonSpec[]> = {
  'dallas-earthquake': [
    { name: 'Marcus T.', tier: 'none', age: '18-64', wifi: true, dist: 1.6, bearing: 200 },
    { name: 'Jennifer L.', tier: 'none', age: '18-64', wifi: true, pets: true, dist: 1.8, bearing: 250 },
    { name: 'Diego R.', tier: 'none', age: '18-64', wifi: false, dist: 2.0, bearing: 300 },
    { name: 'Ashley W.', tier: 'none', age: '65+', wifi: true, dist: 2.2, bearing: 340 },
    { name: 'Brandon K.', tier: 'medium', age: '18-64', wifi: true, pets: true, dist: 0.3, bearing: 190, silentMin: 34 },
    { name: 'Sofia M.', tier: 'medium', age: '18-64', wifi: false, dist: 0.5, bearing: 240, silentMin: 52 },
    { name: 'Tyler H.', tier: 'medium', age: '18-64', wifi: true, dist: 0.7, bearing: 290, silentMin: 68 },
    { name: 'Dorothy P.', tier: 'high', age: '65+', wifi: true, dist: 0.4, bearing: 215, silentMin: 112 },
    { name: 'Luis G.', tier: 'high', age: '65+', wifi: false, pets: true, dist: 0.6, bearing: 265, silentMin: 96 },
    { name: 'Keisha J.', tier: 'high', age: '18-64', wifi: false, dist: 0.8, bearing: 320, silentMin: 104 },
  ],
  'la-fire': [
    { name: 'Kevin N.', tier: 'none', age: '18-64', wifi: true, pets: true, dist: 1.6, bearing: 190 },
    { name: 'Emily C.', tier: 'none', age: '18-64', wifi: true, dist: 1.8, bearing: 235 },
    { name: 'Jorge V.', tier: 'none', age: '65+', wifi: false, dist: 2.0, bearing: 280 },
    { name: 'Hannah S.', tier: 'none', age: '18-64', wifi: true, dist: 1.6, bearing: 330 },
    { name: 'Ryan O.', tier: 'medium', age: '18-64', wifi: false, dist: 0.4, bearing: 200, silentMin: 41 },
    { name: 'Mei L.', tier: 'medium', age: '18-64', wifi: true, pets: true, dist: 0.6, bearing: 255, silentMin: 58 },
    { name: 'Andre B.', tier: 'medium', age: '18-64', wifi: true, dist: 0.3, bearing: 305, silentMin: 31 },
    { name: 'Ruth A.', tier: 'high', age: '65+', wifi: false, pets: true, dist: 0.5, bearing: 225, silentMin: 118 },
    { name: 'Carlos D.', tier: 'high', age: '65+', wifi: true, dist: 0.7, bearing: 275, silentMin: 91 },
    { name: 'Linh T.', tier: 'high', age: '18-64', wifi: true, dist: 0.35, bearing: 340, silentMin: 107 },
  ],
  'miami-flood': [
    { name: 'Gabriela F.', tier: 'none', age: '18-64', wifi: true, dist: 1.6, bearing: 210 },
    { name: 'Michael R.', tier: 'none', age: '18-64', wifi: false, pets: true, dist: 1.8, bearing: 255 },
    { name: 'Yolanda P.', tier: 'none', age: '65+', wifi: true, dist: 1.6, bearing: 290 },
    { name: 'Ethan B.', tier: 'none', age: '18-64', wifi: true, dist: 2.0, bearing: 325 },
    { name: 'Isabella C.', tier: 'medium', age: '18-64', wifi: true, dist: 0.5, bearing: 205, silentMin: 47 },
    { name: 'Darnell W.', tier: 'medium', age: '18-64', wifi: false, pets: true, dist: 0.7, bearing: 250, silentMin: 63 },
    { name: 'Camila R.', tier: 'medium', age: '18-64', wifi: true, dist: 0.4, bearing: 300, silentMin: 38 },
    { name: 'Harold S.', tier: 'high', age: '65+', wifi: true, dist: 0.6, bearing: 230, silentMin: 99 },
    { name: 'Mariela H.', tier: 'high', age: '18-64', wifi: false, pets: true, dist: 0.3, bearing: 280, silentMin: 115 },
    { name: 'Jean-Pierre L.', tier: 'high', age: '65+', wifi: false, dist: 0.8, bearing: 315, silentMin: 93 },
  ],
};

interface PlaceSpec {
  km: number;
  bearing: number;
}

const CENTER_SPECS: Record<string, Array<{ type: SeedCenter['type']; name: string } & PlaceSpec>> = {
  'dallas-earthquake': [
    { type: 'police', name: 'Dallas Central Patrol Station (synthetic)', km: 2.5, bearing: 200 },
    { type: 'fire', name: 'Dallas Fire Station 18 (synthetic)', km: 3.5, bearing: 280 },
    { type: 'hospital', name: 'Trinity Medical Center (synthetic)', km: 4.0, bearing: 330 },
  ],
  'la-fire': [
    { type: 'police', name: 'LA Central Community Police Station (synthetic)', km: 2.0, bearing: 190 },
    { type: 'fire', name: 'LA Fire Station 9 (synthetic)', km: 3.0, bearing: 260 },
    { type: 'hospital', name: 'Echo Park General Hospital (synthetic)', km: 3.5, bearing: 320 },
  ],
  'miami-flood': [
    { type: 'police', name: 'Little Havana Police District (synthetic)', km: 2.0, bearing: 240 },
    { type: 'fire', name: 'Miami Fire Station 5 (synthetic)', km: 2.5, bearing: 290 },
    { type: 'hospital', name: 'Biscayne Regional Hospital (synthetic)', km: 3.0, bearing: 330 },
  ],
};

const NEWS: SeedNews[] = [
  { area: 'dallas-earthquake', minutesAgo: 120, text: 'SYNTHETIC: Magnitude 5.8 earthquake centered near downtown Dallas; shaking felt across the Metroplex.' },
  { area: 'dallas-earthquake', minutesAgo: 95, text: 'SYNTHETIC: Facades collapse on older brick buildings in Deep Ellum; several streets closed.' },
  { area: 'dallas-earthquake', minutesAgo: 70, text: 'SYNTHETIC: About 40,000 customers without power; cell service congested citywide.' },
  { area: 'dallas-earthquake', minutesAgo: 40, text: 'SYNTHETIC: Magnitude 4.1 aftershock; crews inspect I-30 and I-35E overpasses.' },
  { area: 'dallas-earthquake', minutesAgo: 15, text: 'SYNTHETIC: Fire-Rescue asks residents to check on elderly neighbors and report trapped people.' },
  { area: 'la-fire', minutesAgo: 110, text: 'SYNTHETIC: Brush fire ignites in Elysian Park and spreads toward Echo Park on strong Santa Ana winds.' },
  { area: 'la-fire', minutesAgo: 85, text: 'SYNTHETIC: Mandatory evacuation ordered north of the 101 between Echo Park and Silver Lake.' },
  { area: 'la-fire', minutesAgo: 60, text: 'SYNTHETIC: Fire grows to 2,400 acres with 0% containment; smoke closes parts of the 5 and 110.' },
  { area: 'la-fire', minutesAgo: 35, text: 'SYNTHETIC: Utility cuts power to 25,000 customers to reduce ignition risk; some cell towers offline.' },
  { area: 'la-fire', minutesAgo: 10, text: 'SYNTHETIC: Firefighters going door to door; residents with limited mobility urged to call 911.' },
  { area: 'miami-flood', minutesAgo: 115, text: 'SYNTHETIC: Over 12 inches of rain in six hours floods Little Havana and the Miami River corridor.' },
  { area: 'miami-flood', minutesAgo: 90, text: 'SYNTHETIC: King tide pushes Biscayne Bay over seawalls in Brickell; several roads impassable.' },
  { area: 'miami-flood', minutesAgo: 65, text: 'SYNTHETIC: 55,000 outages in Miami-Dade; flooded substations delay restoration.' },
  { area: 'miami-flood', minutesAgo: 30, text: 'SYNTHETIC: Water rescues underway on SW 8th St; residents told not to drive through standing water.' },
  { area: 'miami-flood', minutesAgo: 8, text: 'SYNTHETIC: Officials ask families to check on older relatives who have not been heard from.' },
];

export function buildSeedDataset(seed = SEED): SeedDataset {
  const rand = prng(seed);
  const users: SeedUser[] = [];
  const centers: SeedCenter[] = [];

  for (const z of ZONES) {
    for (const s of PEOPLE[z.id]) {
      const p = offset(z.centerLat, z.centerLng, s.dist * z.radiusKm, s.bearing);
      const silent = s.tier !== 'none';
      users.push({
        index: users.length,
        displayName: s.name,
        ageGroup: s.age,
        zoneId: z.id,
        riskTier: s.tier,
        vulnerabilityFlag: s.tier === 'high',
        hasPets: s.pets ?? false,
        hasWifi: s.wifi,
        lat: p.lat,
        lng: p.lng,
        accuracy: Math.round(5 + rand() * 30),
        minutesAgo: silent ? s.silentMin! : Math.round(rand() * 15) / 10,
        silent,
      });
    }
    for (const c of CENTER_SPECS[z.id]) {
      centers.push({ id: centers.length + 1, type: c.type, name: c.name, ...offset(z.centerLat, z.centerLng, c.km, c.bearing) });
    }
  }

  return { zones: ZONES.map(z => ({ ...z })), users, centers, news: NEWS.map(n => ({ ...n })) };
}

/** Synthetic identities live in a recognisable range so they never collide with real ones in practice. */
export const SYNTHETIC_IDENTITY_BASE = 0x5e5e_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000n;
export function syntheticIdentityValue(index: number): bigint {
  return SYNTHETIC_IDENTITY_BASE + BigInt(index + 1);
}
