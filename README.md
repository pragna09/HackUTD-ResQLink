# Welfare Check

**Concept prototype · HackUTD 2026 · all data is synthetic**

When a disaster hits thousands of people at once, the people who need help most are often the ones who go quiet.
Welfare Check finds people who **stopped sending their location inside a disaster zone**, ranks them by urgency,
tells the **nearest emergency center**, and **holds a spot at a volunteer shelter**.

Pitched as a module for an insurer’s mobile app (shown as a concept; no insurer logos, not affiliated).
Alerts are always worded as a **welfare check**, never a confirmed emergency — a dead battery looks the same as lost signal.

| Route        | What it is                                                                            |
|--------------|---------------------------------------------------------------------------------------|
| `/app`       | Phone page: opt in, small profile (name, age group, vulnerability, pets), 60 s heartbeat |
| `/dashboard` | Responder dashboard: live ranked queue, map, case detail, zone panel, counters, demo controls |
| `/volunteer` | Volunteer shelter offer form                                                          |

Stack: **SpacetimeDB 2.x** (TypeScript module, reactive backend) · **Gemini** (default) / **NVIDIA Nemotron** (switch) agents in
Node · **Vite + React + Leaflet/OpenStreetMap**. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the diagram and data flow,
and [STATUS.md](STATUS.md) for what is verified and what is pending.

## Repo layout

```
module/   SpacetimeDB module: tables, reducers, scheduled scan, urgency score (src/logic.ts), synthetic seed (src/seed_data.ts)
agents/   Node worker: llm.ts (provider switch), weather.ts, triage.ts, shelter.ts, nws.ts, worker.ts
web/      Vite + React app (/app, /dashboard, /volunteer)
seed/     generate.ts (dump synthetic dataset to JSON) and seed.ts (load it via reset_demo)
docs/     ARCHITECTURE.md
scripts/  bindings.mjs (runs `spacetime generate` for every client package)
```

## Prerequisites

- Node.js 22+ (tested on 22.18)
- SpacetimeDB CLI — install from <https://spacetimedb.com/install>
  (Windows PowerShell: `iwr https://windows.spacetimedb.com -useb | iex`; macOS/Linux: `curl -sSf https://install.spacetimedb.com | sh`)
- Optional: a Gemini API key (<https://aistudio.google.com/apikey>) or an NVIDIA API key (<https://build.nvidia.com>).
  Without keys every agent uses its stored fallback and tags results `fallback`.

## Install

```bash
npm run install:all          # root (eslint) + module + agents + web + seed
cp .env.example .env         # then fill GEMINI_API_KEY (optional) and NWS_USER_AGENT contact
```

`.env` is git-ignored. API keys are only read by `/agents`. The web app only sees `VITE_*` values (URI + database name).

## Run (local SpacetimeDB)

```bash
# terminal 1 — local SpacetimeDB server on :3000
spacetime start

# terminal 2 — publish the module (init seeds 200 synthetic users and starts the 30 s scan), then generate bindings
spacetime login                                   # once; opens a browser
spacetime publish --server local --module-path module welfare-check
npm run bindings                                  # -> web/src/module_bindings, agents/module_bindings, seed/module_bindings

# terminal 2 — agents worker (Weather / Triage / Shelter)
npm --prefix agents run dev

# terminal 3 — web app
npm --prefix web run dev                          # http://localhost:5173/dashboard
```

Re-seed any time with the dashboard **Reset** button, `npm --prefix seed run seed`, or `spacetime call --server local welfare-check reset_demo`.

After any module change: `spacetime publish --server local --module-path module welfare-check` then `npm run bindings`.
Add `--delete-data always` to the publish command to wipe and re-run `init`.

### Offline UI preview (no SpacetimeDB needed)

```bash
npm --prefix web run dev     # then open http://localhost:5173/dashboard?mock=1
```

A blue banner marks preview mode: a local mock built from the same seed and scoring code. No persistence, no agents.

## Demo script (90 seconds)

1. Open `/dashboard`. Zone is severity 1, queue empty. 200 synthetic last-known pins on the map.
2. **Run weather research** → the Weather agent reads NWS + the 5 synthetic news items → severity 4 flood (badge shows `llm` or `fallback`).
3. Immediately (the rating triggers a scan) ~30 silent people appear, ranked. Each has a nearest center, a welfare-check alert, a one-line triage reason, and a held shelter spot.
4. **Silence users** → more people go quiet; the queue reorders live.
5. Open `/app` on a phone, opt in, tick *Use demo location*. Stop the heartbeat (close the tab) → after 10 min you appear in the queue; reopen → your case resolves.
6. **Simulate disaster** sets severity directly (badge `simulated`) when you need a deterministic demo.

## Urgency score

```
score = 40 × (severity / 5) + 30 × (min(silent_minutes, 120) / 120) + 30 × vulnerability_flag
```

Computed inside the `scan_for_missing` reducer. Weights live in `URGENCY_WEIGHTS` (`module/src/logic.ts`). This is a **tunable,
unvalidated** model, and the dashboard says so.

## Checks

```bash
npm run lint        # eslint across all packages
npm test            # module (urgency, haversine, reducers in SpacetimeDB's test harness) + agents (llm wrapper, fallbacks)
npm run typecheck   # needs generated bindings for agents/web/seed
npm run build       # web production build
npm --prefix agents run sample   # each agent once on a sample input (fallback mode without keys)
```

## LLM provider switch

`LLM_PROVIDER=gemini` (default, `@google/genai`, `GEMINI_MODEL=gemini-3.5-flash-lite`) or `LLM_PROVIDER=nvidia`
(`openai` SDK → `https://integrate.api.nvidia.com/v1`, `NVIDIA_MODEL=nvidia/nemotron-3-super-120b-a12b`).
Every result is zod-validated, retried once on bad JSON, then replaced by a stored fallback. Results carry `source = llm | fallback`
and the UI shows that badge everywhere. LLM results are cached by input hash in `agents/.cache/`. `LLM_FORCE_FALLBACK=1` forces
fallbacks for a fully deterministic demo.

## Synthetic data

All 200 users, 8 emergency centers, 15 shelter offers and 5 news items are **invented** (`module/src/seed_data.ts`, deterministic).
Names carry a `#NNN` suffix and every place name is marked “(synthetic)”. `npm --prefix seed run generate` writes the full dataset to
`seed/synthetic-data.json`.
