import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENTS_DIR = dirname(fileURLToPath(import.meta.url));

// agents/.env wins over the repo-root .env. Neither is committed.
for (const p of [resolve(AGENTS_DIR, '.env'), resolve(AGENTS_DIR, '..', '.env')]) {
  if (existsSync(p)) loadEnv({ path: p, quiet: true });
}

const str = (k: string, d = '') => (process.env[k] ?? d).trim();
const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && process.env[k] !== '' ? v : d;
};

export const env = {
  LLM_PROVIDER: (str('LLM_PROVIDER', 'gemini').toLowerCase() === 'nvidia' ? 'nvidia' : 'gemini') as 'gemini' | 'nvidia',
  GEMINI_API_KEY: str('GEMINI_API_KEY'),
  GEMINI_MODEL: str('GEMINI_MODEL', 'gemini-3.5-flash-lite'),
  NVIDIA_API_KEY: str('NVIDIA_API_KEY'),
  NVIDIA_MODEL: str('NVIDIA_MODEL', 'nvidia/nemotron-3-super-120b-a12b'),
  NVIDIA_BASE_URL: 'https://integrate.api.nvidia.com/v1',
  LLM_FORCE_FALLBACK: str('LLM_FORCE_FALLBACK', '0') === '1',
  LLM_MIN_INTERVAL_MS: num('LLM_MIN_INTERVAL_MS', 4000),
  NWS_USER_AGENT: str('NWS_USER_AGENT', '(welfare-check-hackutd-concept, contact-unset@example.com)'),
  WEATHER_INTERVAL_MIN: num('WEATHER_INTERVAL_MIN', 10),
  STDB_URI: str('STDB_URI', 'ws://localhost:3000'),
  STDB_DB: str('STDB_DB', 'welfare-check'),
};
