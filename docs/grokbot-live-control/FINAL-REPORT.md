# Grok Bot Live Control — Final report

Date: 2026-11-25. Branch: `feature/grokbot-live-control` (from `grok-chat-tasks-results` at `f89deec`).
Nothing is committed, pushed or merged.

**Outcome:** read-only Live Control works (roster, group and transcript sync, the "Live Grok Bot" view, and live
messages survive a page reload).
**Sending is blocked** (the gateway answers 409 for server-run bots) and **Live Control is NOT verified**.

## 1. Baseline vs final test results

| Check | Baseline (`f89deec`, Phase 0) | Final (feature branch) |
| --- | --- | --- |
| Type-check | pass, 0 errors | pass, 0 errors |
| Lint | 0 errors, 2 warnings (`Environment.tsx:90`, `:93`) | 0 errors, the same 2 warnings |
| Unit tests (Vitest) | 6 files, 65/65 | 14 files, **124/124** |
| Build | pass, JS 1,486.74 kB | pass, JS 1,493.34 kB (+6.6 kB, the Live Grok Bot view) |
| Browser tests, `npm run test:e2e` as configured | 0/13 (Playwright's Chromium not installed) | **16/16** after installing Playwright's Chromium (the same 13 plus 3 new) |
| Browser tests with installed Chrome (out-of-repo config) | **13/13** | 15/15 (before the reload-buffer test was added) |
| Flag-off screenshots vs baseline (5 screens) | — | 0% on office, conversation, group chat, replay; sidebar 0.19% (character activity icons, which move between runs; test ids identical); 0 page errors; 0 live-control requests |

## 2. Added files

| File | Lines | Purpose |
| --- | --- | --- |
| `backend/src/grokbot/config.ts` | 65 | Settings; off unless `ENABLE_GROKBOT_LIVE_CONTROL=true`; `GROKBOT_LIVE_SEND_ENABLED` default false; starts paused |
| `backend/src/grokbot/cli.ts` | 294 | The only process launcher: `execFile`, no shell, allowlisted argv, minimal env, timeout, path/commit/version checks; `send` runs once, never retried |
| `backend/src/grokbot/schemas.ts` | 48 | Loose zod schemas for CLI output |
| `backend/src/grokbot/transcript.ts` | 195 | Text/placeholder extraction, attribution rules, per-thread cursor and dedupe |
| `backend/src/grokbot/adapter.ts` | 391 | Discovery and bounded polling (concurrency 1, backoff, auto-off), pause/resume, status, send path gated by the send flag |
| `backend/src/grokbot/routes.ts` | 70 | `/api/live-control/{status, thread/:id, active, reconnect, pause, resume, send}`; only registered with the flag on; send → 403 while the send flag is off |
| `backend/src/grokbot/mapping.ts` | 70 | Real bot → existing character by name; owner never mapped |
| `backend/src/grokbot/bridge.ts` | 89 | Broadcasts eligible live messages over SSE (never stored); in-memory reload buffer (last 100 per thread) |
| `shared/liveControl.ts` | 106 | Shared types and the send-blocked label |
| `frontend/src/live/liveFlag.ts` | 12 | Whether the server runs Live Control (from the SSE snapshot only) |
| `frontend/src/live/LiveGrokBotTab.tsx` | 262 | The read-only "Live Grok Bot" view |
| `tests/unit/grokbot-adapter.test.ts` | 360 | Adapter, scheduler, backoff, dedupe, auto-off |
| `tests/unit/grokbot-cli.test.ts` | 209 | Allowlist, env, verification |
| `tests/unit/grokbot-flag.test.ts` | 115 | Flag off: nothing constructed, spawned or scheduled; routes 404 |
| `tests/unit/grokbot-phase2.test.ts` | 426 | Real-sample attribution, mapping, integration, failure modes |
| `tests/unit/grokbot-send.test.ts` | 117 | Send argv and once-only behaviour (fake runner) |
| `tests/unit/grokbot-phase4.test.ts` | 150 | Paused start, send flag, 403 refusal, SSE marker |
| `tests/unit/grokbot-stubs.test.ts` | 141 | Gateway-down cases against a real child process (stub CLI) |
| `tests/unit/grokbot-buffer.test.ts` | 113 | Reload buffer: cap per thread, ordering, snapshot only when on, never stored |
| `tests/e2e/live-control.spec.ts` | 154 | Browser: flag off; flag on with the stub CLI; reload keeps live messages |
| `tests/fixtures/grokbot/fixtures.ts` | 96 | Synthetic ids and entries |
| `tests/fixtures/grokbot/real-samples.json` | 278 | 12 entry *shapes* from real transcripts; all text `[redacted]` or a label, all ids synthetic |
| `tests/fixtures/grokbot/stubCli.ts` | 96 | Stub CLI for tests (temp folder outside the repo, synthetic "[stub]" data) |
| `docs/grokbot-live-control/PLAN.md` | 389 | Plan, decisions D1–D7, progress log |
| `docs/grokbot-live-control/README.md` | 153 | Settings, tests, limitations, demo-data notes, disable, roll back |
| `docs/grokbot-live-control/FINAL-REPORT.md` | 147 | This report |

## 3. Modified existing files (`git diff --stat f89deec`: 7 files, +68 / −7)

| File | Lines | Reason |
| --- | --- | --- |
| `.env.example` | +21 | Placeholder settings: flag off, send flag off, placeholder CLI path and owner id, commented tuning |
| `backend/src/index.ts` | +29 / −2 | Build the adapter, routes and bridge only when the flag is on; stop it on close; start it paused; add `liveControl: true` and the buffered live messages to the SSE snapshot only when it exists; test override option |
| `backend/src/providers.ts` | +5 | `broadcast()`: notify SSE listeners without storing (D4) |
| `frontend/src/api.ts` | +2 | Read the snapshot marker |
| `frontend/src/ui/RightPanel.tsx` | +9 / −3 | "Live Grok Bot" menu item and view, only while the marker is set |
| `playwright.config.ts` | +1 / −1 | Pin `ENABLE_GROKBOT_LIVE_CONTROL=false` for the e2e server |
| `vitest.config.ts` | +1 / −1 | The same pin for unit tests |

No `package.json`, lockfile, schema, scene, roster or saved-data file was changed. The existing browser tests
from `f89deec` are unchanged.

## 4. Live connectivity

**Verified with the real patched CLI** (`9616503`, read-only):

- **Roster:** `bots list` returns 9 bots (the 8 real bots plus the owner). 6 map to office characters by name;
  the owner is never drawn.
- **Groups:** `groups list` returns 1 group (6 members); its transcript reads with `author.id` on bot entries.
- **Transcript sync:** incremental `thread --after` reads with dedupe. Phase 2 server run: 71 messages broadcast
  to the 6 mapped characters (58 thread-target, 13 verified), 0 database rows. Phase 4 browser run: Coz's thread
  showed 20 real messages (11 thread-target, 6 owner, 3 unknown, 1 placeholder).
- Startup validation and auto-off (missing path, owner not set or not listed) with clear status messages.

**Not verified:**

- **Sending.** The one approved send (Krystal · Research, "Live Control test from Pixel Office - please reply
  OK", 2026-11-25 09:12:36Z) was rejected: `{"delivery":"rejected","error":"sendPrompt failed: 409 This Bot runs
  on the server, and this version of the app can't message it. Update the app and try again.",...}`. A read-only
  read of the thread afterwards showed it was not delivered. Nothing was retried.
- Gateway-down behaviour with the real Desktop app (tested only with a stub CLI).
- A group transcript view in the UI (not built; group messages reach the office only as bubbles when verified).

## 5. Screenshots

Session scratch folder (outside the repo; can be cleared on reboot):
`/private/tmp/claude-501/-Users-huangjianting-Projects-grok-pixel-office/d0efb654-6e1a-49f3-8bab-cd61857bf285/scratchpad/shots2/`

- **Before (baseline `f89deec`):** `baseline/1-office.view.png`, `2-sidebar.view.png`,
  `3-conversation-panel.view.png`, `4-group-chat-meetings.view.png`, `5-replay-picker.view.png`
- **After, flag off:** `p4-flag-off/` (same five names); per-screen diffs in `p4-diff/`
- **After, flag on:** `p4-on/A-menu.png`, `p4-on/B-live-tab-paused.png`, `p4-on/C-live-tab-messages.png`
  (these contain real transcript text)

## 6. Data check

**`data/office.db` was not modified. Evidence:**

- File times: `data/office.db` 13:22:27 and `data/office.db-wal` 13:27:22 (local), both before this session
  started (Phase 0 backup 15:30:58). In WAL mode every committed write appends to the `-wal` file, so no write
  was committed after 13:27.
- Contents: newest event received 05:27:22Z (13:27 local); newest `kv` update 05:27:09Z.
- Row-by-row SHA-256 of `events` (16,095 rows) and `kv` (4 rows) was identical to the backup taken at 16:52:44
  (that backup was deleted afterwards at your request; the file times above still hold).
- `data/office.db-shm` changed at 16:52:44. That is SQLite's shared-memory index, updated when my backup opened
  the database read-only, not database content.
- `data/tasks.json`, `data/chats.json` and `data/results/` were last written at 13:20 or earlier, before the
  session. `.env` was last modified on 2026-11-20.

**Saved settings were not modified. Evidence and limits:**

- Server-side settings are the `kv` row `settings` in `data/office.db`: unchanged (updated 2026-11-25 04:56:03Z,
  identical hash above).
- The demo database `data/demo/office.db` has no `settings` row (only `progression` and `source:simulation`),
  so the incident wrote no settings there.
- Browser-side settings live in each browser's local storage. All my browser runs used fresh headless Chrome
  profiles from Playwright, on other ports. I did not open or read your Chrome profile, so I cannot inspect it,
  but nothing I ran had access to it.

**What did change during the session (outside `data/office.db`):** `data/demo/office.db` (the incident and the
approved 7-row delete, documented in the README), `data/demo/tasks.json` (16:27:39, most likely rewritten by
your demo server when `tsx watch` restarted it on my edits; I have no earlier copy to compare), and
`data/demo/dev.log` (your demo server's own log, last line when my cleanup stopped it).

## 7. Remaining blockers and suggested next steps

Resolved after the first version of this report (owner decisions, 2026-11-25):

- **Reload buffer built:** the last 100 live office messages per thread are kept in memory and added to the SSE
  snapshot only when the flag is on; cleared on restart; never stored. Unit and browser tests cover it.
- **Browser tests run as configured:** Playwright's Chromium was installed (outside the project; `package.json`
  and the lockfile byte-identical). `npm run test:e2e`: 16/16. One run showed a one-off failure of the existing
  `f89deec` test "first playable scene" (`labels overlap`; characters wander randomly). It then passed 5/5 on both
  this branch and `f89deec`, and the full suite passed 16/16 on the rerun.
- **Clean-up done:** the memory note, `~/pixel-office-cleanup/`, the two database backups and the Phase 0 backups
  were deleted.

Still open:

1. **Sending (blocker, left blocked by owner decision).** The gateway refuses this CLI's send route for
   server-run bots (409). Keep `GROKBOT_LIVE_SEND_ENABLED=false`. Reopening it needs either a bot that runs
   locally (then a newly approved test send) or a CLI send route for server-run bots (an upstream change).
   Live Control therefore stays **NOT verified**.
2. **Deviations from PLAN.md:** the planned `sends.ts` ledger and the group thread section in `Modals.tsx` were not
   built, and the view lives in `frontend/src/live/LiveGrokBotTab.tsx` instead of the planned file names. Four
   Phase 2 integration tests still start their in-memory test server with `simulation: true`.
3. **Old session scratch folder:** it still holds copies of real transcripts and screenshots with real text
   (`/private/tmp/claude-501/-Users-huangjianting-Projects-grok-pixel-office/d0efb654-…/`). It is outside the
   repo and cleared on reboot, or can be deleted on request.
4. **Pull request** from `feature/grokbot-live-control` into `grok-chat-tasks-results`: to be opened by the owner.
