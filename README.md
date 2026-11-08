# ResQLink

**Concept prototype · HackUTD 2026 · all data is synthetic**

When a disaster hits thousands of people at once, the people who need help most are often the ones who go quiet.
ResQLink finds people who **stopped sending their location inside a disaster zone**, ranks them by urgency,
and tells the **nearest emergency center**.

- **Are you safe?** When someone's area becomes a disaster zone and their phone has signal, the app asks
  *"Are you safe, or do you need help?"* "I need help" alerts the nearest center right away.
- **Three AI agents in a pipeline:** Monitor warns everyone in the zone with safety steps → Triage explains each case
  and tags what the person needs → Dispatch contacts the right services for the disaster plus the insurer.
- **No signal?** A phone-to-phone mesh relays SOS messages to the nearest phone that still has internet, which
  uploads them. See [docs/MESH.md](docs/MESH.md).

Pitched as a module for an insurer’s mobile app (shown as a concept; no insurer logos, not affiliated).
Alerts are always worded as a **welfare check**, never a confirmed emergency — a dead battery looks the same as lost signal.

| Route        | What it is |
|--------------|------------|
| `/app`       | Phone app: two-step sign-in (name, phone, age group → household: children, elderly, pets, accessibility needs), location opt-in with a 60 s heartbeat, and the "Are you safe?" check-in |
| `/dashboard` | Responder dashboard: three disaster scenarios, live ranked queue, map, case detail, zone panel, AI model picker, demo controls, and a **Show phone** preview of the phone app |

Stack: **SpacetimeDB 2.x** (TypeScript module, reactive backend) · **Gemini** / **NVIDIA Nemotron** agents in Node, switchable
from the dashboard · **Vite + React + Leaflet/OpenStreetMap**. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the diagram and
data flow, and [STATUS.md](STATUS.md) for what is verified and what is pending.

## Repo layout

```
module/       SpacetimeDB module: tables, reducers, scheduled scan, urgency score (src/logic.ts),
              mesh routing (src/mesh.ts), synthetic seed (src/seed_data.ts)
agents/       Node worker: llm.ts (Gemini / Nemotron), weather.ts, triage.ts, nws.ts, worker.ts
web/          Vite + React app: /app (src/app), /dashboard (src/dashboard, incl. the mesh simulator meshSim.ts)
apps/mobile/  Expo phone app: offline SOS over a Bluetooth/Wi-Fi mesh (DRAFT, not yet run on a phone)
seed/         generate.ts (dump synthetic dataset to JSON) and seed.ts (load it via reset_demo)
docs/         ARCHITECTURE.md, MESH.md
scripts/      bindings.mjs (runs `spacetime generate` for every client package)
```

## Prerequisites

- Node.js 22+ (tested on 22.18)
- SpacetimeDB CLI (on Windows it installs to `%LOCALAPPDATA%\SpacetimeDB`; add that folder to PATH) — install from <https://spacetimedb.com/install>
  (Windows PowerShell: `iwr https://windows.spacetimedb.com -useb | iex`; macOS/Linux: `curl -sSf https://install.spacetimedb.com | sh`)
- Optional: a Gemini API key (<https://aistudio.google.com/apikey>) and/or an NVIDIA API key (<https://build.nvidia.com>).
  Without keys every agent uses its stored fallback and tags results `fallback`.

## Install

```bash
npm run install:all          # root (eslint) + module + agents + web + seed
cp .env.example .env         # then fill GEMINI_API_KEY / NVIDIA_API_KEY (optional) and NWS_USER_AGENT contact
```

`.env` is git-ignored. API keys are only read by `/agents`. The web app only sees `VITE_*` values (URI + database name).

## Run (local SpacetimeDB)

```bash
# terminal 1 — local SpacetimeDB server on :3000
spacetime start

# terminal 2 — publish the module (init seeds the 3 scenarios and starts the 30 s scan), then generate bindings
spacetime login                                   # once; opens a browser
spacetime publish --server local --module-path module welfare-check
npm run bindings                                  # -> web, agents, seed and apps/mobile module_bindings

# terminal 2 — agents worker (Weather research + Triage)
npm --prefix agents run dev

# terminal 3 — web app
npm --prefix web run dev                          # http://localhost:5173/dashboard  (also reachable from your network)
```

Re-seed any time with the dashboard **Reset** button, `npm --prefix seed run seed`, or `spacetime call --server local welfare-check reset_demo`.

After any module change: `spacetime publish --server local --module-path module welfare-check` then `npm run bindings`.
If the change adds or removes columns, add `-c` to the publish command (wipes the local data and re-runs `init`).

### Offline UI preview (no SpacetimeDB needed)

```bash
npm --prefix web run dev     # then open http://localhost:5173/dashboard?mock=1
```

A blue banner marks preview mode: a local mock built from the same seed and scoring code. No persistence, no agents.

## Demo script (about 2 minutes, all on one screen)

1. Open `/dashboard`. Three synthetic scenarios are loaded (Dallas earthquake, Los Angeles fire, Miami flood), all at severity 1, queue empty.
   Pick the **AI model** (Gemini or NVIDIA Nemotron) in the demo controls.
2. Click **Show phone**. A phone frame runs the real phone app: sign in, add the household, turn on location sharing
   (its demo location sits in the selected city). First time only.
3. Pick **Simulate disaster ▾ → Simulate earthquake in Dallas** (badge `simulated`).
   - The queue fills with that city's 6 at-risk people, ranked: the 3 high-risk above the 3 medium-risk. Each case has a
     nearest center, a welfare-check alert, a Wi-Fi tag and a one-line reason from the Triage agent.
   - In the phone frame a **notification** slides down: *"Disaster alert … Are you safe, or do you need help?"* Tap it →
     **I need help** (with a note). An SOS case jumps to the top of the queue and the nearest center is alerted.
4. Or **Run weather research**: the Weather agent reads NWS alerts + the zone's news and rates the hazard itself (badge `llm` / `fallback`).
5. **Simulate mesh (no signal)**: towers in the zone go down; SOS messages hop phone-to-phone on the map to phones with
   signal, then appear as SOS cases tagged **via mesh**, with the route on the map.
6. **Reset** to run it again.

## Agent pipeline

One model (Gemini or NVIDIA Nemotron, picked on the dashboard) runs three agents, each feeding the next:

| Agent | Trigger | Writes |
|---|---|---|
| **Monitor** (`agents/monitor.ts`) | a zone reaches severity 3+ | a warning + 3–5 safety instructions, shown in the zone panel and the phone's "Are you safe?" prompt |
| **Triage** (`agents/triage.ts`) | a new or newly-SOS case | a one-line reason + needs (medical, rescue, evacuation, security) from the household, SOS note and check-in answer |
| **Dispatch** (`agents/dispatch.ts`) | a triaged case | which services to contact and one dispatch message, sent to each service and the insurer claims desk |

Code keeps control where it matters: it ranks the queue, and it decides the services every case in a disaster must reach
(flood / earthquake / fire → fire & rescue + hospital). Dispatch may add services but never remove one, and the module
re-checks before sending. Every agent has a template fallback, so the demo works without a model. Each case shows the
three steps in an **Agent pipeline** panel.

## Urgency score

```
score = 40 × (severity / 5) + 30 × (min(silent_minutes, 120) / 120) + 30 × vulnerability_flag
```

Computed inside the `scan_for_missing` reducer. Weights live in `URGENCY_WEIGHTS` (`module/src/logic.ts`). This is a **tunable,
unvalidated** model, and the dashboard says so. `vulnerability_flag` is derived from the phone app's household answers:
any children or elderly dependents, or accessibility needs. SOS cases (from "I need help" or the mesh) always rank first.

Code computes every number (score, silence, distances, nearest center). The AI model only rates the hazard during weather
research and writes the one-line reasons.

## Checks

```bash
npm run lint        # eslint across all packages (apps/mobile has its own `npx expo lint`)
npm test            # module (scoring, mesh routing, reducers in SpacetimeDB's test harness) + agents (llm wrapper, fallbacks)
npm run typecheck   # needs generated bindings for agents/web/seed
npm run build       # web production build
npm --prefix agents run sample   # each agent once on a sample input (fallback mode without keys)
```

## AI models

Pick the model on the dashboard (**AI model** dropdown); every agent switches within a second. `LLM_PROVIDER` in `.env` is only the
starting choice.

- **Gemini**: `@google/genai`, `GEMINI_MODEL=gemini-3.5-flash-lite`.
- **NVIDIA Nemotron**: `openai` SDK → `https://integrate.api.nvidia.com/v1`, `NVIDIA_MODEL=nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`
  with thinking turned off (the larger `nemotron-3-super-120b-a12b` returns 404 on free accounts).

Every result is zod-validated, retried once on bad JSON, then replaced by a stored fallback. Results carry `source = llm | fallback`
and the UI shows that badge everywhere. LLM results are cached by input hash in `agents/.cache/`. `LLM_FORCE_FALLBACK=1` forces
fallbacks for a fully deterministic demo.

## Phone notifications on a real phone (optional)

The dashboard's **Show phone** preview is enough for a demo. To get real system notifications on an Android phone, open
`http://<laptop-IP>:5173/app` in Chrome on the same network, and in `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
add that address (browsers only allow notifications on HTTPS or localhost). The browser has to stay open in the background.

## Synthetic data

All 30 people (10 per scenario: 4 no-risk outside the zone, 3 medium-risk, 3 high-risk), 9 emergency centers and 15 news items
are **invented** (`module/src/seed_data.ts`, deterministic). Every place name is marked “(synthetic)”. `npm --prefix seed run generate`
writes the full dataset to `seed/synthetic-data.json`.
