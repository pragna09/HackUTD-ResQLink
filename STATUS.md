# STATUS — Welfare Check

Snapshot: 2026-11-07, end of build session 1. Environment: Windows 11, Node 22.18, **no SpacetimeDB CLI, no Gemini/NVIDIA keys**.

## Completed (verified in this session)

- [x] **SpacetimeDB module** (`/module`) — 9 tables, 13 reducers + `init`, scheduled `scan_for_missing` (30 s interval schedule table).
  - Typechecks against the real `spacetimedb@2.14.1` package types.
  - **Reducer logic is executed in tests** with SpacetimeDB’s own in-process test harness (`spacetimedb/server/test-utils`,
    portable datastore WASM). Covered: seeding, scan threshold, scoring, nearest center, alerts, no duplicate cases, silence_users,
    resolve-on-ping, set_rationale/set_match constraints, acknowledge_alert, reset_demo.
- [x] **Urgency score inside a reducer** (`runScan` → `urgencyScore`), weights in `URGENCY_WEIGHTS`.
- [x] **Unit tests**: urgency formula and haversine distance (`module/test/logic.test.ts`) — pass.
- [x] **Agents** (`/agents`): `llm.ts` provider switch (gemini default / nvidia), zod validation, retry once, stored fallback,
  `source` tag, input-hash cache, throttle. Weather Research, Triage (batched ×10), Shelter (code shortlist → agent pick + note).
  NWS client. Worker that subscribes and reacts. 9 tests pass (fake provider, no network).
- [x] **Each agent run on a sample input** (`npm --prefix agents run sample`): all three returned valid results tagged
  `source: "fallback"`, **0 model calls**. Live NWS request to `/alerts/active?point=32.7705,-96.8265` returned HTTP 200 with 0 alerts.
- [x] **Web** (`/web`): `/app`, `/dashboard`, `/volunteer`, home. Loading (skeletons), empty and error states. Source badges everywhere.
  Production build passes. Driven headlessly in **preview mode (`?mock=1`)**: all buttons work, no console/page errors,
  no horizontal scroll at 390 px.
- [x] **Seed**: deterministic synthetic dataset (200 users / 41 stale, 8 centers, 15 shelters / 81 spots, 5 news items).
  `npm --prefix seed run generate` → `seed/synthetic-data.json`. The module’s `init` and `reset_demo` load the same data.
- [x] **Lint** (ESLint flat config, all packages): pass. **Docs**: README, docs/ARCHITECTURE.md (Mermaid), this file.

## Pending (needs the SpacetimeDB CLI)

| Item | Why pending | Command |
|---|---|---|
| **Publish module** | CLI not installed | `spacetime publish --server local --module-path module welfare-check` |
| **Generate client bindings** | CLI not installed | `npm run bindings` (= `spacetime generate --lang typescript --out-dir <pkg>/module_bindings --module-path module` ×3) |
| Typecheck of `agents`, `web`, `seed` | **Fails only because bindings are missing.** Errors are confined to the one adapter file per package: `agents/stdb.ts`, `web/src/stdb/live.ts`, `seed/seed.ts` (TS2307 “Cannot find module”, plus TS7006 implicit-any that follows from it). Every other file typechecks. | `npm run typecheck` after `npm run bindings` |
| Live end-to-end run (phone → scan → agents → dashboard) | needs published module + bindings | see “Commands” below |
| `npm --prefix seed run seed` | needs bindings + server | — |

## Unverified (written from docs/types, not yet exercised)

- **All agent outputs are `source = "fallback"`.** No live Gemini or NVIDIA call has been made. The Gemini and NVIDIA adapters in
  `agents/llm.ts` are unverified against the real APIs.
- **NVIDIA model ID** `nvidia/nemotron-3-super-120b-a12b`: the build.nvidia.com page exists, but the exact hosted ID was only confirmed
  from a summary of the page. Whether the hosted endpoint accepts `chat_template_kwargs` (reasoning off) is unconfirmed, so it is not sent;
  `<think>` blocks are stripped instead.
- **Gemini model** `gemini-3.5-flash-lite`: listed as Stable on the models page. Free-tier RPM/RPD is not published on the docs page
  (check AI Studio). `gemini-2.5-flash` is being retired on 2026-12-01, so don’t switch back to it.
- **Generated binding names.** Client code assumes camelCase accessors (`conn.db.missingCase`, `conn.reducers.setRationale({...})`,
  object-argument reducer calls, `resetDemo()` with no args) — this matches the SDK types and docs, but the generated files were
  not available. If names differ, only the three adapter files need edits.
- **Module packaging for `spacetime publish`**: `module/package.json` + `tsconfig.json` were hand-written (the docs did not show the
  template). If publish complains, run `spacetime init --lang typescript /tmp/x` and copy its `package.json`/`tsconfig.json` shape.
- `spacetime call --server local …` flag placement (CLI marks `call` as unstable).
- Real-browser geolocation on a phone (tested only with the demo-location override in headless Chrome).

## Blocked

Nothing is blocked on code. Everything left waits on the actions below.

## Actions you must take

1. **Install the SpacetimeDB CLI** — <https://spacetimedb.com/install>
   (PowerShell: `iwr https://windows.spacetimedb.com -useb | iex`). Check: `spacetime --version`.
2. **Log in**: `spacetime login` (browser). Needed to publish, including to a local server.
3. **Get a Gemini API key** at <https://aistudio.google.com/apikey> → put it in `.env` as `GEMINI_API_KEY=` (MLH Best Use of Gemini).
4. **Optional NVIDIA key** at <https://build.nvidia.com> → `NVIDIA_API_KEY=`; confirm the Nemotron model ID on the model page;
   set `LLM_PROVIDER=nvidia` to demo the switch.
5. Set `NWS_USER_AGENT` in `.env` to your app name + a real contact email (NWS requirement).
6. Decide where to host the demo database: local (`--server local`) or Maincloud (`--server maincloud`, then set
   `VITE_STDB_URI=wss://maincloud.spacetimedb.com` and `STDB_URI` to the same).
7. Fill in team size/skills in the Devpost. Record the 90-second demo (README “Demo script”).

## Commands (once the CLI and keys exist)

```bash
npm run install:all
cp .env.example .env                                   # add GEMINI_API_KEY, NWS_USER_AGENT
spacetime start                                        # terminal 1
spacetime login
spacetime publish --server local --module-path module welfare-check
npm run bindings
npm run typecheck && npm run lint && npm test && npm run build
npm --prefix seed run check                            # expect 200 users, 8 centers, 15 offers, 5 news, 1 zone
npm --prefix agents run sample                         # with a key: badges should now say "llm"
npm --prefix agents run dev                            # terminal 2
npm --prefix web run dev                               # terminal 3 → http://localhost:5173/dashboard
spacetime logs --server local welfare-check -f         # optional: watch "scan: opened=…" lines
```

## Where this differs from the brief (docs won)

- **SpacetimeDB 2.x syntax** (current docs + package 2.14.1): `schema({ ...tables })` default-exported; reducers are exported consts
  named in camelCase → snake_case canonical names (`updateProfile` → `update_profile`); client uses `withDatabaseName` (not
  `withModuleName`); scheduled reducers bind with `reducer({ onSchedule: table }, …)`. **Scheduled reducers fit**, so no worker
  fallback was needed. Scheduled reducers are private in 2.x, so demo reducers call the same scan function directly.
- **Gemini docs now lead with the Interactions API** (`ai.interactions.create`). The installed `@google/genai@3.0.0` still ships
  `ai.models.generateContent` with `responseMimeType` / `responseJsonSchema`, which is what `llm.ts` uses for schema-constrained JSON.
- **Data model additions** (all used by the MVP):
  - `user_profile`: `hasPets` (the shelter pet filter needs it), `isSynthetic` + `simSilent` (simulated phones for the 200 seeded users),
    `updatedAt`.
  - `zone.researchStatus` + reducer **`request_research`**: how the dashboard button reaches the external Weather worker through SpacetimeDB.
  - `missing_case`: score breakdown, snapshot of inputs (`severity`, `vulnerabilityFlag`, `hasPets`, `displayName`, last lat/lng/seen),
    `rationaleSource`, `handoffNote`, `matchSource`, `centerDistanceKm`, timestamps. `zone` is stored as `zoneId`.
  - `alert.case` → `caseId`, `alert.center` → `centerId` (avoid reserved words).
  - `shelter_offer`: `owner` (shows volunteers their own offers), `isSynthetic`; `capacity` = remaining spots, decremented by `set_match`.
  - Private `scan_schedule` table (required by scheduled reducers).
- `upsert_zone` also triggers a scan immediately so a new rating shows on the dashboard without waiting for the 30 s tick.
- Cases **resolve automatically** when the person pings again (frees any held shelter spot).
- Extra `/` home page, and a `?mock=1` preview backend so the UI can be worked on before the CLI is installed (always bannered).

## Known gaps / risks to fix before going beyond a demo

- **No authorization on reducers.** Any client can call `upsert_zone`, `set_rationale`, `set_match`, `reset_demo`, etc. For the demo
  that is fine; for anything real, restrict agent/demo reducers to known identities and make `user_profile`/`location_ping` private
  with views for responders.
- All tables are public, so real `/app` users’ names and locations are visible to any subscriber.
- The 200-row synthetic heartbeat refresh runs every 30 s; fine at demo scale, not at real scale.
- Stretch goals not built (by design): offline queueing, service workers, SMS fallback, Bluetooth. The heartbeat sender is isolated in
  `web/src/app/heartbeat.ts` so they can be added without schema changes.
