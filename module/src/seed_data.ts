// Deterministic SYNTHETIC demo dataset. Every person, place, center, shelter and news item is invented.
// Pure TypeScript with no SpacetimeDB imports, so the module (reset_demo / init), the /seed script
// and tests all produce the same data.

export const SEED = 20261107;

export interface SeedZone {
  id: string;
  name: string;
  centerLat: number;
  centerLng: number;
  radiusKm: number;
}

export interface SeedUser {
  /** Index 0..199, turned into a synthetic Identity by the module. */
  index: number;
  displayName: string;
  ageGroup: '0-17' | '18-64' | '65+';
  vulnerabilityFlag: boolean;
  hasPets: boolean;
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

export interface SeedShelter {
  hostName: string;
  lat: number;
  lng: number;
  capacity: number;
  acceptsPets: boolean;
  accessible: boolean;
}

export interface SeedNews {
  area: string;
  text: string;
  minutesAgo: number;
}

export interface SeedDataset {
  zone: SeedZone;
  users: SeedUser[];
  centers: SeedCenter[];
  shelters: SeedShelter[];
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

/** A point at distance `km` and bearing `angle` (radians) from a center, flat-earth approximation (fine at city scale). */
function offset(lat: number, lng: number, km: number, angle: number) {
  return {
    lat: lat + (km * Math.cos(angle)) / KM_PER_DEG_LAT,
    lng: lng + (km * Math.sin(angle)) / kmPerDegLng(lat),
  };
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

export const DEMO_ZONE: SeedZone = {
  id: 'trinity-bottoms',
  name: 'Trinity Bottoms Flood Zone (synthetic)',
  centerLat: 32.7705,
  centerLng: -96.8265,
  radiusKm: 4,
};

const FIRST = [
  'Ava', 'Ben', 'Carla', 'Dev', 'Elena', 'Femi', 'Grace', 'Hector', 'Ines', 'Jamal', 'Kira', 'Luis',
  'Mina', 'Noah', 'Omar', 'Priya', 'Quinn', 'Rosa', 'Sam', 'Tara', 'Umar', 'Vera', 'Wes', 'Ximena',
  'Yusuf', 'Zoe', 'Ana', 'Bao', 'Chidi', 'Dana',
];
const LAST_INITIAL = 'ABCDEFGHJKLMNPRSTVWZ';

const CENTERS: SeedCenter[] = [
  { id: 1, type: 'fire', name: 'Levee Street Fire Station 12 (synthetic)', lat: 32.7841, lng: -96.8233 },
  { id: 2, type: 'fire', name: 'Cedar Bend Fire Station 4 (synthetic)', lat: 32.7512, lng: -96.8451 },
  { id: 3, type: 'fire', name: 'Northgate Fire Station 31 (synthetic)', lat: 32.8065, lng: -96.8619 },
  { id: 4, type: 'police', name: 'Riverside Police Substation (synthetic)', lat: 32.7629, lng: -96.8070 },
  { id: 5, type: 'police', name: 'West Mesa Police Post (synthetic)', lat: 32.7473, lng: -96.8812 },
  { id: 6, type: 'hospital', name: 'Bluebonnet General Hospital (synthetic)', lat: 32.8012, lng: -96.8105 },
  { id: 7, type: 'hospital', name: 'Oak Hollow Medical Center (synthetic)', lat: 32.7348, lng: -96.8194 },
  { id: 8, type: 'police', name: 'Elm Fork Police Station (synthetic)', lat: 32.7918, lng: -96.8487 },
];

const HOSTS = [
  'Grace Fellowship Hall', 'The Okafor family', 'Lakewood Rec Center', 'M. Delgado', 'Hilltop Community Church',
  'The Nguyen household', 'Cedar Ridge Middle School gym', 'R. Patel', 'Unity Mosque community room',
  'Elm Street Apartments clubhouse', 'The Johnson family', 'Oak Cliff Scout Lodge', 'S. Ramirez',
  'Temple Beth Shalom annex', 'Northside YMCA',
];

const NEWS: SeedNews[] = [
  { area: DEMO_ZONE.id, minutesAgo: 95, text: 'SYNTHETIC: Trinity Bottoms residents report water over curbs on Levee St after 4 inches of rain in two hours.' },
  { area: DEMO_ZONE.id, minutesAgo: 70, text: 'SYNTHETIC: County officials close three low-water crossings near the Trinity Bottoms; several cars stalled.' },
  { area: DEMO_ZONE.id, minutesAgo: 48, text: 'SYNTHETIC: Power outage affects about 6,000 customers in the flood area; cell towers on backup power.' },
  { area: DEMO_ZONE.id, minutesAgo: 30, text: 'SYNTHETIC: River gauge at Commerce St bridge rising fast, forecast to crest 2 ft above flood stage tonight.' },
  { area: DEMO_ZONE.id, minutesAgo: 12, text: 'SYNTHETIC: Swift-water rescue teams staged at Cedar Bend; officials urge residents to move to higher ground.' },
];

export function buildSeedDataset(seed = SEED): SeedDataset {
  const rand = prng(seed);
  const pick = <T>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)];

  const users: SeedUser[] = [];
  for (let i = 0; i < 200; i++) {
    // 160 inside the zone, 40 in a ring just outside it.
    const inside = i < 160;
    const km = inside
      ? DEMO_ZONE.radiusKm * Math.sqrt(rand()) * 0.95
      : DEMO_ZONE.radiusKm * (1.1 + rand() * 1.0);
    const p = offset(DEMO_ZONE.centerLat, DEMO_ZONE.centerLng, km, rand() * Math.PI * 2);

    const ageRoll = rand();
    const ageGroup: SeedUser['ageGroup'] = ageRoll < 0.1 ? '0-17' : ageRoll < 0.75 ? '18-64' : '65+';
    const vulnerabilityFlag = ageGroup === '65+' ? rand() < 0.5 : rand() < 0.12;
    const hasPets = rand() < 0.3;

    // ~18% stale heartbeats (15–150 min old), the rest fresh (< 2 min old).
    const silent = rand() < 0.18;
    const minutesAgo = silent ? 15 + rand() * 135 : rand() * 1.5;

    users.push({
      index: i,
      displayName: `${pick(FIRST)} ${LAST_INITIAL[Math.floor(rand() * LAST_INITIAL.length)]}. #${String(i + 1).padStart(3, '0')}`,
      ageGroup,
      vulnerabilityFlag,
      hasPets,
      lat: r6(p.lat),
      lng: r6(p.lng),
      accuracy: Math.round(5 + rand() * 45),
      minutesAgo: Math.round(minutesAgo * 10) / 10,
      silent,
    });
  }

  const shelters: SeedShelter[] = HOSTS.map(hostName => {
    const p = offset(DEMO_ZONE.centerLat, DEMO_ZONE.centerLng, 3 + rand() * 12, rand() * Math.PI * 2);
    return {
      hostName: `${hostName} (synthetic)`,
      lat: r6(p.lat),
      lng: r6(p.lng),
      capacity: 1 + Math.floor(rand() * 8),
      acceptsPets: rand() < 0.45,
      accessible: rand() < 0.55,
    };
  });

  return { zone: { ...DEMO_ZONE }, users, centers: CENTERS.map(c => ({ ...c })), shelters, news: NEWS.map(n => ({ ...n })) };
}

/** Synthetic identities live in a recognisable range so they never collide with real ones in practice. */
export const SYNTHETIC_IDENTITY_BASE = 0x5e5e_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000n;
export function syntheticIdentityValue(index: number): bigint {
  return SYNTHETIC_IDENTITY_BASE + BigInt(index + 1);
}
