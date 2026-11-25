# Grok Bot Live Control — Plan (Phase 0)

Status: **approved with decisions below** (2026-11-25). Phases 0–6 done on `feature/grokbot-live-control` (uncommitted); live send blocked, Live Control NOT verified. See FINAL-REPORT.md.

## 0. Decisions (2026-11-25)

These override anything below that disagrees.

| # | Decision |
| --- | --- |
| D1 Browser | Option B: screenshots only, by driving the installed Google Chrome with the project's existing Playwright (`channel: 'chrome'`). No Chromium download, no dependency change. The script lives outside the repo (scratch folder) and is never committed. A full e2e setup will be a separate approval later. |
| D2 Kat | Kat (`523c1232…`) is the **owner agent ("me")**. Never mapped to a character. Messages from Kat are labelled `owner` and are not bot activity, but they are kept (never dropped). The 8 real bots are the other 8. The owner id is configured with `GROKBOT_OWNER_AGENT_ID` (in your `.env`; the id is not committed). |
| D3 1:1 attribution | Every live message carries `attribution`: `verified` (the CLI gave a sender id), `thread-target` (inferred from the thread, only when an entry field shows the message is not from the owner), `owner`, or `unattributed`. It also carries a `basis` string naming the field used. Unclear direction → `unattributed`, shown only in the Live Control view. Speech bubbles are allowed for `verified` and `thread-target`. |
| D4 Storage | **Do not write to `data/office.db`.** Phase 2 broadcasts live messages over SSE only (not `ProviderManager.publish`, which persists). Storing them later (source tag `grokbot-live`) needs a new approval, and the proposal must include the exact delete query as the rollback. |
| D5 Groups | Group messages stay plain messages: no meeting is created and no character is moved to the meeting room. |
| D6 Send box | A new **"Live Grok Bot"** tab next to the existing chat tab, reusing the existing chat components and styles. The existing xAI Bot chat tab is unchanged. The tab shows "Sends to real Grok Bot Desktop" next to the connection indicator. |
| D7 Polling | Only when `ENABLE_GROKBOT_LIVE_CONTROL=true` (default false). Bounded, with backoff, and a status endpoint on 127.0.0.1. Phases 1–3: polling starts at server start. From Phase 4: every server start begins **paused**, and the UI toggle resumes or pauses polling in memory only. The toggle is never saved to persisted preferences without asking. |

Attribution rules as implemented (D2 + D3):

1. `author.id` present → `owner` if it is the owner id; `verified` if it is a discovered bot; otherwise `unattributed`.
2. `role: "user"` → `owner`.
3. Group thread without `author.id` → `unattributed`.
4. 1:1 thread, `role: "assistant"` → `thread-target` (basis `role:assistant`).
5. 1:1 thread, `kind: "send-message"` with no role or author → `thread-target` (basis `kind:send-message`). The CLI's
   own source documents this kind as "Bot replies", and in the observed data owner messages are always
   `kind:"message", role:"user"`. **Please confirm this rule at the Phase 1 gate.**
6. A `thread-target` that resolves to the owner id (Kat's own thread) → `owner`.
7. Anything else → `unattributed`.

## 1. Starting state

| Item | Value |
| --- | --- |
| Branch | `grok-chat-tasks-results` (tracks `origin/grok-chat-tasks-results`; `main` exists) |
| HEAD | `f89deec Grok API: chat with Bots, place tasks, results board` |
| Tracked changes | none (`git diff` is empty) |
| Untracked | `.DS_Store`, `tests/.DS_Store` |
| Backup | `~/pixel-office-backup-20261125-1530.patch` (0 bytes, no diff) and `~/pixel-office-backup-20261125-1530.status.txt` |

The feature branch will be created from this HEAD with `git switch -c feature/grokbot-live-control`
after approval. `grok-chat-tasks-results` stays untouched.

## 2. Architecture summary

- **Stack.** TypeScript throughout, Node ≥ 24, ESM. Backend: Fastify 5 on `127.0.0.1:4319`, SQLite through `node:sqlite`.
  Frontend: React 19 + React Three Fiber/drei (Three 0.187), Zustand 5, Tailwind 4, Vite 8. `shared/` holds pure,
  unit-tested logic used by both sides. Tests: Vitest (unit), Playwright (e2e).
- **Server** `backend/src/index.ts` → `buildServer(opts)` builds everything (the `opts` object makes it testable) and
  registers all `/api/*` routes. `/api/stream` is an SSE feed (snapshot first, then events).
- **Event pipeline.** Providers → `ProviderManager.publish` (`backend/src/providers.ts`) → `store.addEvent`
  (`INSERT OR IGNORE`, the id is the primary key, so duplicates are dropped) → SSE listeners → frontend
  `useStore.ingest` (dedupes by id again) → `applyEvent` reducer (`shared/events.ts`) → `systems/world.ts`
  directives → character brains.
- **Local cache reader / monitoring** `backend/src/localCache.ts` (Provider A): read-only watcher of one authorised
  JSONL folder (fs.watch plus a 3 s poll, per-file offsets, rotation and dedupe). It refuses `~/.grokbot` and other
  credential folders. Only events whose `botId` is in the 6-bot roster are accepted.
- **Simulation** `shared/simProvider.ts` (Provider B) runs on the server every 1 s, with a browser fallback in
  `frontend/src/api.ts` when no backend is reachable. **Replay** `shared/replay.ts` + `ReplayPicker` / `ReplayBar`
  in `frontend/src/ui/Modals.tsx`. `OfficialApiAdapter` (Provider C) is a placeholder that is always unavailable.
- **State store** `frontend/src/store.ts`, one Zustand store. `conversations` (ConversationLine[]) and `bubbles` are
  filled from `message` events in `ingest`. Separate small stores already exist for features (`useBoard` in
  `TaskComposer.tsx`, `useResults` in `ui/results.ts`), and this plan follows that pattern.
- **Conversation panel**: the `BotPanel` "chat" tab in `frontend/src/ui/RightPanel.tsx`, list `data-testid="conversation"`.
  **Bot chat** `frontend/src/ui/BotChat.tsx` talks to the **xAI API** (Grok models role-playing the Bots via
  `backend/src/chat.ts`). It is not connected to Grok Bot Desktop. **Group chat / meetings**: `MeetingPanel` in
  `frontend/src/ui/Modals.tsx`, based on `state.meetings` (meeting events gather characters in the meeting room).
- **Persistence.** Layout, appearances, progression and settings go to localStorage (`pixel-office:v1:*`) and to the
  SQLite kv table through `/api/state/:key`. Tasks, chats and results go to JSON files under `data/`.
- **Config / flags.** Backend only: `backend/src/config.ts` loads `.env` once with `process.loadEnvFile` (shell
  values win) and parses it with `loadGrokConfig(env)` (pattern `env.X?.trim().toLowerCase() === 'true'`). The
  frontend reads **no** env (`import.meta.env` is unused) and learns server facts through `/api/*`.
- **Roster** `shared/roster.ts`: 6 fixed Bots with `mock-*` ids. Character definitions are not touched by this plan.

## 3. Baseline results (Phase 0, unmodified tree)

| Command | Result | Details |
| --- | --- | --- |
| `npm run typecheck` | ✅ pass | 0 errors |
| `npm run lint` | ✅ pass | 0 errors, **2 warnings** (already there): `frontend/src/scene/Environment.tsx:90` unused eslint-disable, `:93` missing `season` dep |
| `npm test` (Vitest) | ✅ pass | 6 files, **65 / 65** tests |
| `npm run build` | ✅ pass | `index-*.js` 1,486.74 kB (gzip 416.58 kB), CSS 34.85 kB |
| `npm run test:e2e` (Playwright) | ❌ **0 / 13** | All 13 fail at `browserType.launch`: Chromium headless shell 1255 is not installed (`~/Library/Caches/ms-playwright` missing). This is the environment, not the code. |

E2e can only become a useful regression signal once a browser is available (see open question Q1).

## 4. CLI verification (read-only)

| Check | Result |
| --- | --- |
| Repo | `/Users/huangjianting/Projects/grok-bot-cli`, branch `fix/grok-bot-desktop-1-3`, `git rev-parse --short HEAD` = **9616503**, clean tree, origin `ScriptedAlchemy/grok-bot-cli` |
| Executable | `/Users/huangjianting/Projects/grok-bot-cli/dist/bin/gbot.mjs` (`#!/usr/bin/env node`), run as `node <path>` |
| `--version` | `gbot 0.12.5`. **The same string as stock npm 0.12.5**, so the version cannot prove it is the patched build; the commit check is the proof. |
| Global `grok-bot` | `/opt/homebrew/bin/grok-bot` → realpath is the patched repo's `dist/bin/gbot.mjs` (an `npm link`). It is not used; the adapter calls the absolute path only. |
| `bots list --json` | exit 0, ~1.4 s. **9** entries, all `kind: "bot"`: Coz · Chief, Miu Natcha · Reviewer, Lena Lalina · Execution, Oom Eisaya · Visual Designer, Krystal · Research, Piploy · Strategy, Social Media Manager, Coding UX&UX Designer, **Kat** |
| `groups list --json` | exit 0, ~0.9 s. 1 group, "Social Media: Music Information Team", 6 members |
| `thread <Coz id> --limit 3 --json --no-history` | exit 0, ~1.5 s. `{ target{id,name,isGroup,memberIds,…}, transcript{ entries[], nextBeforeSeq, precedingTimestampMs } }` |
| `thread <group id> --limit 8 --json --no-history` | exit 0. Bot entries carry `author{id,name}`; user entries are `kind:"message", role:"user"` with `clientNonce` |
| Sent | **nothing**. `doctor` was deliberately not run because it lists auth sources. |

Transcript entry shapes seen:

- `send-message` — `{id, message{type,content}, timestampMs, requestId, seq, author?}`. In the group thread `author.id` is
  always present. In the 1:1 thread there is **no author field**; the CLI source (`src/core/transcript.js`) documents
  `send-message` as "Bot replies".
- `message` — `{id, role: "user"|"assistant", content, timestampMs, seq, clientNonce?, toAgent?, richText?}`. One
  `role:"assistant"` entry with id `agent-outbound-…` and `toAgent: Kat` was seen in the 1:1 thread.
- Ids such as `t8s2` look thread-scoped, so dedupe keys will include the thread id.
- `send` (from source `src/cli/send.tsx`): without `--reply-mode` it takes the manual path and returns a receipt with
  `exitCode`, `kind`, `name`, `id`, `messageId?`, `envelopeId`; errors are returned as a failure document.
  `--request-id` is only used in auto mode. Message words are joined with a space.

## 5. New files (all additive)

| Path | Phase | Purpose |
| --- | --- | --- |
| `backend/src/grokbot/config.ts` | 1 | `loadLiveControlConfig(env)`, following the `loadGrokConfig` pattern (imports `../config` so `.env` is loaded once) |
| `backend/src/grokbot/cli.ts` | 1 | The only place a process is spawned: `execFile(process.execPath, [CLI_ABS, ...allowlistedArgs], { shell: false, timeout, killSignal: 'SIGKILL', maxBuffer: 8 MB, env: minimal })`. Typed errors: `CliMissingError`, `CliTimeoutError`, `CliExitError`, `CliParseError`, `CliRefusedError` |
| `backend/src/grokbot/schemas.ts` | 1 | zod schemas (passthrough) for bots, groups, thread and the send receipt; unknown entry kinds are counted and skipped |
| `backend/src/grokbot/transcript.ts` | 1 | Normalising entries, per-thread cursors (`--after <entry id>` plus a seq high-water mark), dedupe by `threadId:entryId`, sender attribution rules (§8) |
| `backend/src/grokbot/adapter.ts` | 1 | `GrokBotGatewayAdapter`: discovery, a bounded scheduler (concurrency 1, configurable intervals, exponential backoff, auto-off after N consecutive failures), health status, `start()/stop()` that clear every timer |
| `backend/src/grokbot/routes.ts` | 1 | `registerLiveControlRoutes(app, adapter)` under `/api/live-control/*`, with its own `OFFICE_TOKEN` check (same rule as the existing guard) |
| `backend/src/grokbot/mapping.ts` | 2 | Real agent id → roster id mapping layer (§9); unmapped bots reported, never shown as characters |
| `backend/src/grokbot/sends.ts` | 3 | Send ledger (in memory): client message id, state `pending → sent → delivered \| failed \| unknown`, never retried automatically |
| `shared/liveControl.ts` | 1 | Types shared with the frontend (status, delivery state, thread view) |
| `frontend/src/liveControl/store.ts` | 2/4 | Small Zustand store plus one status probe (the `useBoard` / `useResults` pattern) |
| `frontend/src/ui/LiveControl.tsx` | 4 | `LiveControlComposer` (input, confirm step, delivery state), `LiveControlStatus` (indicator + toggle), `LiveGroupThread`, built from existing classes (`btn`, `chip`, `panel`, `Section`, `SourceBadge`) |
| `tests/unit/grokbot-adapter.test.ts` | 1 | Adapter, scheduler, backoff, cursors, dedupe, attribution, timeouts, auto-off |
| `tests/unit/grokbot-flag.test.ts` | 1 | Flag off: adapter never constructed, CLI runner never called, no timers, routes 404 |
| `tests/unit/grokbot-cli.test.ts` | 1 | Allowlist refuses anything outside §7; argument validation; no shell |
| `tests/fixtures/grokbot/*.json` | 1 | **Synthetic** fixtures with the real *shape* and fake ids/text (no real transcript content is copied into the repo) |
| `tests/e2e/live-control.spec.ts` | 5 | Flag off (no controls rendered) and flag on with a stubbed CLI (never the real one in e2e) |
| `docs/grokbot-live-control/README.md` | 6 | Configuration, limitations, disable and rollback |

## 6. Existing files to modify

| File | Phase | Exact reason | Size | Risk |
| --- | --- | --- | --- | --- |
| `.env.example` | 1 | Document `ENABLE_GROKBOT_LIVE_CONTROL=false` and the `GROKBOT_*` settings (commented) | +10 lines, append only | none |
| `backend/src/index.ts` | 1 | In `buildServer`: `const live = liveCfg.enabled ? new GrokBotGatewayAdapter(…, publish) : undefined; if (live) registerLiveControlRoutes(app, live);` plus `live?.stop()` in the existing `onClose` hook, and an optional `opts.liveControl` override for tests | ~+10 lines, 0 changed | low: the whole block is skipped when the flag is off |
| `frontend/src/ui/RightPanel.tsx` | 4 | Render `<LiveControlComposer botId={id} />` inside the existing `tab === 'chat'` block. It renders `null` unless the flag is on, the server says enabled, and the Bot is mapped | ~+3 lines | low |
| `frontend/src/ui/Modals.tsx` | 4 | Render `<LiveGroupThread />` as an extra section in `MeetingPanel` (null when off) | ~+3 lines | low |

| `vitest.config.ts` | 1 | Pin `ENABLE_GROKBOT_LIVE_CONTROL: 'false'` in the test env (same pattern as the existing "never a real key" pins), so a `true` in your `.env` can never make the unit tests spawn the real CLI | 1 line | none |
| `playwright.config.ts` | 1 | The same pin for the e2e web server | 1 line | none |

Nothing else changes: no `package.json` or lockfile, no schemas, no `data/`, no `.env`, no character or roster
definitions, and no scene files. If any phase turns out to need more than this, I will stop and ask.

## 7. Allowlisted CLI invocations

The executable is always `process.execPath` (the running Node) with `GROKBOT_CLI_PATH` as the first argument.
The path must be absolute, must exist, its realpath must not be inside an npm/npx cache (`/_npx/`,
`/lib/node_modules/grok-bot-cli/`), and the commit check below must pass. Otherwise Live Control is `unavailable`
and nothing is spawned. Arguments are built from fixed tokens in code; the frontend only ever supplies a target id
(which must be one of the ids from the last discovery) and, in Phase 3, the message text.

| Purpose | argv after the CLI path | Validation |
| --- | --- | --- |
| Commit check (once at start) | `/usr/bin/git -C <repo root> rev-parse --short HEAD` (separate execFile) | must equal `GROKBOT_CLI_COMMIT` (default `9616503`) |
| Version / health | `--version` | must match `/^gbot \d+\.\d+\.\d+/` |
| Bot discovery | `bots list --json` | — |
| Group discovery | `groups list --json` | — |
| Transcript | `thread <id> --json --no-history --limit <n>` [`--after <entryId>`] | id ∈ discovered set and UUID-shaped; `n` integer 1–200; entryId `/^[A-Za-z0-9:_-]{1,200}$/` |
| **Phase 3 only** send | `send <id> --json --no-history <text>` | id ∈ discovered set; text 1–2000 chars, no NUL; **refused if it starts with `-`** until we confirm the parser honours `--` (Q6); requires `confirmed: true` from the UI and a fresh client message id |

The child gets a minimal environment (`HOME`, `PATH`, `USER`, `LANG`, `TMPDIR` only), so `XAI_API_KEY` and
`OFFICE_TOKEN` never reach it. stdout/stderr are never logged verbatim; errors are passed through the existing
`redact`. Grok Bot Desktop auth files are never read by this code (the CLI reads them itself).

## 8. Sender attribution rules (verified ids only)

- Group thread, `send-message` with `author.id` → that id. Without `author.id` → **unattributed** (counted, not
  shown as any character).
- `role: "user"` entries → the owner (you). Shown in the Live Control thread view only, never as a Bot bubble.
- 1:1 thread `send-message` with no `author` → **needs your decision (Q3)**.
- `message` with `role: "assistant"` and no author (the `agent-outbound-…` / `toAgent` case) → unattributed until
  its meaning is confirmed.

## 9. Mapping real bots to existing characters

A mapping layer only: `shared/roster.ts` and the appearances are not changed. Proposed default rule: exact match of
the display name before ` · ` with a roster `name`, overridable with
`GROKBOT_AGENT_MAP=<realId>:<rosterId>,…`. Applied to today's data:

| Real bot | Real id (prefix) | → Character |
| --- | --- | --- |
| Coz · Chief | 820e4906 | `mock-chief-01` Coz |
| Miu Natcha · Reviewer | a2d4b60a | `mock-review-06` |
| Lena Lalina · Execution | fb011f01 | `mock-execution-04` |
| Oom Eisaya · Visual Designer | af97afe3 | `mock-visual-05` |
| Krystal · Research | 2721ca7a | `mock-research-02` |
| Piploy · Strategy | 5ff04e18 | `mock-strategy-03` |
| Social Media Manager | 16fef0c4 | unmapped (listed in Live Control status only) |
| Coding UX&UX Designer | b804d2bf | unmapped |
| Kat | 523c1232 | unmapped |

Mapped messages enter the **existing** pipeline as `message` events (`id: grokbot:<threadId>:<entryId>`,
`source: 'real'`, `botId: <roster id>`, `timestamp` from `timestampMs`, `payload: { text, kind: 'grokbot',
threadId }`), so conversation panels, bubbles (only for entries < 20 s old, as today) and the activity log work
through their current interfaces. Group messages are published **without** a `meetingId`, so no meeting is invented
and nobody walks to the meeting room (Q5). The cache reader, simulation and replay are not touched and keep running
alongside.

## 10. Polling budget

Each CLI call costs about 0.4 s CPU and 1–1.5 s wall time. Polling all 10 threads every 15 s would keep about a
third of a CPU core busy, so the proposed defaults are:

- discovery (`bots list`, `groups list`): every 5 min, plus on reconnect
- the thread open in the UI (if any): every 10 s
- every other mapped thread: round-robin, one thread every 15 s (each about every 2 min)
- concurrency 1 (single queue; a tick is skipped while one is running), 15 s timeout per read, 30 s per send
- on failure: backoff 2 s → 4 s → … up to 2 min. After 3 consecutive failures, or if the CLI is missing, the adapter
  goes **`off (error)`**: every timer is cleared, nothing more is spawned, and the status shows why. "Reconnect" in the
  UI (or `POST /api/live-control/reconnect`) is the only way back.
- first sync per thread reads the last 20 entries. Cursors stay in memory; after a restart the event-table dedupe
  makes re-reading harmless.

All of these are env-configurable (`GROKBOT_POLL_ACTIVE_MS`, `GROKBOT_POLL_IDLE_MS`, `GROKBOT_DISCOVERY_MS`,
`GROKBOT_CLI_TIMEOUT_MS`, `GROKBOT_MAX_FAILURES`).

## 11. Feature flag wiring, and proving "off = unchanged"

- `ENABLE_GROKBOT_LIVE_CONTROL` is read by `loadLiveControlConfig` and is true only for the exact value `true`
  (default false). It goes in `.env.example`; you set it in your own `.env`.
- Off: `buildServer` never imports-and-constructs the adapter (construction sits behind the check), no routes are
  registered, nothing is spawned, and no timers are created.
- Frontend: the Live Control components ask `GET /api/live-control/status` **once** on first mount. A 404 (flag off)
  makes them render `null` permanently. This single probe is the only observable difference when the flag is off.
  (The alternative, a Vite build-time define, would mean editing `vite.config.ts`, so I don't recommend it.)
- Proof:
  1. `grokbot-flag.test.ts`: with the flag off, a spy on the adapter constructor and on the CLI runner records 0
     calls; `vi.getTimerCount()` is the same with and without the feature module; `/api/live-control/status` is 404.
  2. The full baseline suite gives the same numbers as §3, plus only the new tests.
  3. UI: the scene is randomised (simulation seeded from `Date.now()`, idle wandering, weather/season "auto"), so
     **pixel-identical full-page screenshots are not possible even between two baseline runs**. I'll compare
     (a) a DOM inventory of every `data-testid` and the accessibility tree, flag off vs baseline, which must be
     identical, and (b) screenshots of the panels (sidebar, toolbar, right panel, meetings modal) with a pixel diff
     report. Differences inside the 3D canvas are reported as expected randomness.

## 12. Screenshots

No browser tool is available in this session (no Playwright MCP or Chrome extension tools are loaded), and
Playwright's own Chromium isn't installed. Google Chrome **is** installed in `/Applications`, so Playwright 1.65.1
(already in `devDependencies`) could drive it with `channel: 'chrome'` from a throwaway script in my scratch
folder, with no download and no change to the project. See Q1. If you'd rather capture them yourself, I need these
screens, saved to `docs/grokbot-live-control/baseline/`:

1. `office.png` — main office view, live mode, default camera
2. `sidebar.png` — left sidebar open
3. `conversation.png` — a Bot selected, right panel on the chat tab (conversation list + Bot chat)
4. `group-chat.png` — Meetings modal with a simulated meeting running
5. `replay.png` — Replay mode with the demo replay playing

## 13. Open questions

Q1–Q5, Q7 and Q8 are resolved by §0 (D1–D7). Q6 is still open for Phase 3. Changed consequences: the
`RightPanel.tsx` change becomes a new "Live Grok Bot" tab (still small and additive; I will stop and ask if it goes
over ~30 lines), and Phase 2 broadcasts over a new SSE event instead of persisting events.

- **Q1 (browser).** For e2e and screenshots, choose one: (a) let me run `npx playwright install chromium`, which
  downloads into `~/Library/Caches/ms-playwright`, outside the project; (b) drive the installed Google Chrome from a
  scratch script for screenshots only (e2e stays 0/13); (c) you capture the screenshots by hand.
- **Q2 (Kat).** `bots list` returns **9** bots, not 8. Is "Kat" (523c1232) your own/owner agent that should be left
  out, or a ninth bot?
- **Q3 (1:1 attribution).** In 1:1 threads, bot replies (`send-message`) have no `author`. May the adapter attribute
  them to the thread's `target.id`? That comes from the CLI, and the CLI documents these entries as bot replies, but
  it is not a per-message sender id. If not, 1:1 replies appear only in the Live Control thread view and never as
  character bubbles.
- **Q4 (event DB).** Mapped live messages would be stored in `data/office.db` (existing `events` table, no schema
  change) so they appear in conversation panels and Historical Replay like other real events. OK, or should they be
  broadcast only and not stored?
- **Q5 (group = meeting?).** Should messages from the real group stay plain messages (proposed), or should an active
  group conversation open a meeting so the characters gather in the meeting room? The second would be a derived,
  not reported, activity.
- **Q6 (send arguments).** The CLI joins `message...` words and may treat text starting with `-` as a flag. For now
  the plan refuses such text. During Phase 3 I would read the argument parser in `@agent-bundle/runtime` to see
  whether `--` is honoured.
- **Q7 (existing Bot chat).** The right panel already has a Bot chat input that talks to the xAI API (role-play),
  which is not Grok Bot Desktop. The Live Control composer would sit in the same chat tab, labelled clearly ("Send to
  real Grok Bot"). Is that the placement you want, or should it be its own tab in the `…` menu?
- **Q8 (polling on start).** With the flag on, should polling start when the server starts (proposed, so Phase 2
  can be validated before the UI exists), with the Phase 4 toggle pausing/resuming in memory?

## 14. Risks

- The CLI's JSON output is undocumented and could change. Mitigation: passthrough schemas; unknown kinds are
  skipped and counted, not guessed.
- Mapping by display name breaks if a bot is renamed. Mitigation: the `GROKBOT_AGENT_MAP` override, and unmapped
  bots stay visible in the status list.
- Delivery confirmation depends on finding the sent message in a later transcript read; if it can't be matched,
  the state stays `sent` or becomes `unknown` and is **never** resent.
- E2e cannot catch regressions until Q1 is resolved.
- CPU and gateway load from polling (§10).

## 15. Issues noticed (not fixed, per the rules)

- Lint warnings at `frontend/src/scene/Environment.tsx:90` and `:93`.
- `.DS_Store` files are not in `.gitignore`.
- The Playwright browser is not installed, so e2e fails locally.
- `docs/architecture.md` and the roster comment say the app shows no real Grok Bot data; that will need a docs note
  once Live Control lands (Phase 6, docs only).

## 16. Progress log

**Phase 1 (2026-11-25), read-only adapter.** Branch `feature/grokbot-live-control`. New: `backend/src/grokbot/{config,cli,schemas,transcript,adapter,routes}.ts`,
`shared/liveControl.ts`, `tests/unit/grokbot-{adapter,cli,flag}.test.ts`, `tests/fixtures/grokbot/fixtures.ts`
(the plan said `*.json`; a TS module with synthetic data was simpler and holds no real content). Modified:
`backend/src/index.ts` (+16/−1), `.env.example` (+16), `vitest.config.ts` (1 line), `playwright.config.ts` (1 line).
Routes when the flag is on: `GET /api/live-control/status`, `GET /api/live-control/thread/:id`,
`POST /api/live-control/active`, `POST /api/live-control/reconnect`. Incremental reads use `limit 50` with `--after`.
Entries whose `message.type` is `user-form` or `widget` have no text; they are counted as skipped (not shown).

**Phase 2 (2026-11-25), sync and mapping.** New: `backend/src/grokbot/{mapping,bridge}.ts`,
`tests/unit/grokbot-phase2.test.ts`, `tests/fixtures/grokbot/real-samples.json` (sanitised real entries).
Modified: `backend/src/providers.ts` (+5: `broadcast()` without storing), `backend/src/index.ts` (bridge wiring),
`.env.example` (placeholder values). Attribution now follows the gate rule exactly (`unattributed` renamed `unknown`);
every message keeps `raw {kind, role, authorId, authorName, messageType}`; non-text entries are placeholders.
Startup validation: CLI path absolute/existing/executable, owner id set, UUID-shaped and present in `bots list`.

**Incident during the Phase 2 screenshot step (08:31–08:33 UTC).** My env overrides were passed as one unquoted zsh
variable, so they did not apply, and the ports I chose (API 4359, web 5213) were already used by the owner's own
running dev server (logging to `data/demo/dev.log`). My "flag-off" capture therefore ran against that server: it
POSTed `/api/sources/simulation` and `/api/simulate/meeting` (simulated events + kv `source:simulation`), the page
saved kv `progression`, and my cleanup sent SIGTERM to that server. No paid API call was made; `data/office.db`,
tasks, chats and results were not written. A stray SQLite file set named `:memory: OFFICE_TASKS_FILE=…` was created
in the project root. The flag-off screenshot comparison is **invalid** and must be redone on verified-free ports.

**Correction to the incident note above.** The stray `:memory: OFFICE_TASKS_FILE=…` files (main, `-wal`, `-shm`) were
created in the scratch baseline copy, not in the project root; they were moved to `~/pixel-office-cleanup/`. The
database affected was `data/demo/office.db`. Cleanup (owner-approved, 2026-11-25): backups
`~/pixel-office-db-backup-before-cleanup.db` (`data/demo/office.db`) and
`~/pixel-office-db-backup-before-cleanup-data-office.db` (`data/office.db`); the 7 rows of the simulated meeting
`meeting-mwvv8hk7-210` deleted by exact id in one transaction (events 100,248 → 100,241, kv 2 → 2). The inferred
+4 XP in kv `progression` was left as is (see README, "Known demo-data differences").

**Phase 2: done (2026-11-25).** Flag-off screenshot comparison redone on verified-free ports with my own servers:
0% pixel difference on office, conversation, group chat and replay; sidebar 0.11% (character activity icons, which
move between runs; test ids identical); 0 page errors; 0 live-control requests. Missing CLI path with the flag on:
`unavailable` with a clear reason, 0 CLI calls, server and SSE kept running. Unit tests 105/105.

**Phase 3: BLOCKED (2026-11-25).** Code: `send` added to the allowlist in `backend/src/grokbot/cli.ts`
(`['send', <uuid>, <text>, '--gateway', '--no-history', '--json']`, text 1–500 chars, no control characters, no
leading `-`), `client.send()` runs once and never retries; `tests/unit/grokbot-send.test.ts` (fake runner only).
Unit tests 111/111. The one approved live send (Krystal · Research, `2721ca7a-ceca-4916-b9ad-a562d0a07f76`,
"Live Control test from Pixel Office - please reply OK") at 09:12:36Z was **rejected** by the gateway:
`{"delivery":"rejected","error":"sendPrompt failed: 409 This Bot runs on the server, and this version of the app can't message it. Update the app and try again.","exitCode":1,...}`.
The message was **not delivered**: a read-only read of the thread at 09:14:30Z showed 0 entries after the pre-send
cursor `t6s0`. No retry. **Live Control sending is NOT verified.**

**Phase 4 (2026-11-25), read-only UI (owner decision: option E).** Status: **live view working; live send blocked
(409, server-run bots); Live Control NOT verified.**
- New: `frontend/src/live/LiveGrokBotTab.tsx` (the "Live Grok Bot" view in the bot panel's menu: real 1:1
  transcript, connection indicator with Pause/Resume/Reconnect, attribution chips, placeholders in italics; the
  send box and button are rendered disabled with "Sending unavailable: Grok Bot Desktop rejects this CLI's send
  route for server-run bots (409)."), `frontend/src/live/liveFlag.ts`, `tests/unit/grokbot-phase4.test.ts`.
- Backend: `GROKBOT_LIVE_SEND_ENABLED` (default false) in `config.ts`; `adapter.send()` keeps the send path but
  refuses before the CLI while it is off; routes `POST /api/live-control/{pause,resume,send}` — `send` answers 403
  before anything else while the flag is off, and needs `confirm: true` when on. Every server start now begins
  paused (D7); `GROKBOT_START_PAUSED=false` is only used by automated tests.
- Existing files: `backend/src/index.ts` (SSE snapshot gets `liveControl: true` only when the adapter exists),
  `frontend/src/api.ts` (+2: reads that marker), `frontend/src/ui/RightPanel.tsx` (+9/−3: menu item and view,
  only when the marker is set), `.env.example` (+2). With the flag off the page makes no live-control request.
- Checks: unit tests 116/116; flag off vs baseline: 0% on office, conversation, group chat, replay, sidebar 0.19%
  (activity icons only), 0 page errors, 0 live-control requests. Flag on (real CLI, send off): started paused,
  Resume showed 20 real messages (11 thread-target, 6 owner, 3 unknown, 1 placeholder), send box and button
  disabled with the exact label, direct `POST /api/live-control/send` → 403 refused, CLI call count unchanged
  (5 → 5), no `gbot.mjs send` process seen during the run.

**Phase 5 (2026-11-25), regression and browser tests.** Status unchanged: **live view working; live send blocked
(409, server-run bots); Live Control NOT verified.**
- New: `tests/fixtures/grokbot/stubCli.ts` (a stub CLI for tests, never the real one: a fake checkout plus a stub
  `git` in a fresh temp folder outside the repo, synthetic "[stub]" transcripts, every call logged, modes
  ok / fail / hang / ok-then-fail), `tests/unit/grokbot-stubs.test.ts` (5 tests against a real child process:
  works; path does not exist; exits with an error; hangs → killed at the timeout, no process left; works then fails
  mid-session. Each checks that monitoring (local cache reader) and replay keep working; no simulated data),
  `tests/e2e/live-control.spec.ts` (flag off: no Live Grok Bot view, live-control routes 404; flag on with the stub:
  paused at start, Resume shows the stub transcript with attribution chips and a `[widget]` placeholder, send box and
  button disabled with the 409 label, direct `POST /api/live-control/send` → 403 and the stub never sees `send`).
- E2e ran with the **installed Google Chrome** through a scratch Playwright config outside the repo (D1: no browser
  download, no dependency or repo-config change). Baseline `f89deec`: **13/13**. Feature branch: **15/15** (the
  same 13 plus the 2 new). Unit 121/121, type-check clean, lint 0 errors (the 2 pre-existing warnings), build OK.

**Phase 6 (2026-11-25), docs and final report.** README rewritten (settings with defaults, running the tests incl.
the out-of-repo Chrome config, known limitations, demo-data notes, disable, roll back); `FINAL-REPORT.md` added.
The `officeStillWorks` helper in `tests/unit/grokbot-phase2.test.ts` now checks the local cache reader and replay
only (no simulated meeting); unit tests 121/121. Status: **live view working; live send blocked (409, server-run
bots); Live Control NOT verified.** Nothing committed.

**Follow-up (2026-11-25), owner decisions after Phase 6.** Sending stays blocked (409). Built the reload buffer in
`backend/src/grokbot/bridge.ts` (last 100 live office events per thread, memory only, added to the SSE snapshot only
when the flag is on; `backend/src/index.ts` +1/−1), with `tests/unit/grokbot-buffer.test.ts` and a reload test in
`tests/e2e/live-control.spec.ts`. Installed Playwright's Chromium (outside the project; package files unchanged):
`npm run test:e2e` 16/16 (one earlier one-off `labels overlap` failure in the existing "first playable scene" test,
then 5/5 on this branch and on `f89deec`). Unit 124/124. Deleted on request: the memory note, `~/pixel-office-cleanup/`,
the database backups and the Phase 0 backups.
