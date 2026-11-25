# Grok Bot Live Control

Status (2026-11-25):

- **Live view: working.** With the flag on, each mapped character's bot panel has a "Live Grok Bot" view (in the
  "…" menu) showing the real 1:1 transcript from Grok Bot Desktop, a connection indicator (Live / Paused / Off)
  with Pause, Resume and Reconnect, and an attribution label on every message. Real bot messages also appear in
  the existing conversation panel and speech bubbles. Every server start begins **paused**; Resume starts reading.
- **Live send: blocked (409, server-run bots).** The one approved live send was rejected by the gateway on
  2026-11-25 (HTTP 409: "This Bot runs on the server, and this version of the app can't message it. Update the
  app and try again."); the message was not delivered. The send box is shown disabled, and the server refuses send
  requests while `GROKBOT_LIVE_SEND_ENABLED` is false (the default).
- **Live Control: NOT verified.** Sending has never succeeded.

It is **off by default**. With the flag off, nothing below runs: no adapter, no CLI process, no timers, no
`/api/live-control/*` routes (they return 404), and the page shows no Live Grok Bot view and makes no live-control
request.

## Settings

Add these to your own `.env` (never committed). `.env.example` has the same placeholders.

| Setting | Default | What it does |
| --- | --- | --- |
| `ENABLE_GROKBOT_LIVE_CONTROL` | `false` | `true` (exactly) turns Live Control on. Anything else, or missing, is off. |
| `GROKBOT_LIVE_SEND_ENABLED` | `false` | Separate switch for sending. While `false` the server refuses every send request (403) before the CLI is called. Keep it `false`: sending is blocked (see status). |
| `GROKBOT_CLI_PATH` | empty (Live Control stays unavailable) | Absolute path to the **patched** CLI entry. Must exist and be executable; npm/npx installs are refused. |
| `GROKBOT_OWNER_AGENT_ID` | empty (Live Control stays unavailable) | Your own agent id ("me"). Must appear in `bots list`. Your messages are labelled "you" and never drawn as a Bot. |

Placeholder example:

```sh
ENABLE_GROKBOT_LIVE_CONTROL=false
GROKBOT_LIVE_SEND_ENABLED=false
GROKBOT_CLI_PATH=/absolute/path/to/grok-bot-cli/dist/bin/gbot.mjs
GROKBOT_OWNER_AGENT_ID=00000000-0000-0000-0000-000000000000
```

Optional: `GROKBOT_CLI_COMMIT` (required CLI repo commit, default `9616503`), `GROKBOT_AGENT_MAP`
(`<agentId>:<characterId>,…` when a real bot's name does not match a character), and polling tuning
`GROKBOT_POLL_ACTIVE_MS` (10 s), `GROKBOT_POLL_IDLE_MS` (15 s), `GROKBOT_DISCOVERY_MS` (5 min),
`GROKBOT_CLI_TIMEOUT_MS` (15 s), `GROKBOT_MAX_FAILURES` (3).

Find your owner id (read-only):

```sh
node /absolute/path/to/grok-bot-cli/dist/bin/gbot.mjs bots get <your name> --json   # use the "id" field
```

At startup Live Control checks the CLI path, the repo commit, the CLI version, that the owner id is set and
well-formed, and that it appears in the bots list. If any check fails it turns itself off and
`GET /api/live-control/status` explains why. Monitoring, simulation and replay keep running.

## What it does

- Polls the CLI (`bots list`, `groups list`, `thread <id> --after <cursor>`), one call at a time, with backoff.
  After 3 consecutive failures, or a missing or unverified CLI, it turns itself off until Reconnect.
- Attributes each message (`verified` by `author.id`; `thread-target` only for a 1:1 `send-message` with no author
  and a role other than `user`; `owner`; otherwise `unknown`) and keeps the raw kind, role and author on each one.
- Maps real bots to existing characters by name (`Coz · Chief` → Coz). Unmapped bots and the owner are never drawn.
- Sends only `verified` and `thread-target` text messages from mapped bots into the existing SSE event stream, so
  they appear in conversation panels and speech bubbles. Owner, unknown and non-text entries stay in the Live
  Grok Bot view.
- **Stores nothing.** Live messages are broadcast only; they are never written to `data/office.db` or elsewhere.
- **Survives a page reload.** The last 100 live office messages per thread are kept in server memory and added to
  the SSE snapshot a newly loaded page receives (only while the flag is on). The buffer is cleared when the server
  restarts and is never written to any database.

## Running the tests

```sh
npm test            # unit tests (Vitest); Live Control is pinned off in vitest.config.ts
npm run lint
npm run build
```

Unit tests never call the real CLI. Process-level tests (`tests/unit/grokbot-stubs.test.ts`) use a stub CLI that
`tests/fixtures/grokbot/stubCli.ts` writes into a fresh temp folder outside the repo and removes afterwards.

**Browser tests.** `npm run test:e2e` runs the suite as configured with Playwright's own Chromium. If that
browser is missing (`~/Library/Caches/ms-playwright`), install it once with
`node_modules/.bin/playwright install chromium` (a download outside the project; no dependency change).

Alternatively, the suite can use the installed Google Chrome through a Playwright config kept **outside the repo**
(never committed). Save this anywhere outside the repo, e.g. `~/pixel-office-e2e/pw-chrome.config.ts`:

```ts
import base from '/Users/<you>/Projects/grok-pixel-office/playwright.config';
export default {
  ...base,
  testDir: '/Users/<you>/Projects/grok-pixel-office/tests/e2e',
  outputDir: '/tmp/pixel-office-e2e-results',
  use: { ...base.use, channel: 'chrome' },
  webServer: { ...(base as any).webServer, cwd: '/Users/<you>/Projects/grok-pixel-office' },
};
```

and run from the project folder:

```sh
node_modules/.bin/playwright test -c ~/pixel-office-e2e/pw-chrome.config.ts
```

The suite starts its own servers on ports 4339/5193 (flag off) and 4349/5203 (flag on, stub CLI). The
Live Control spec refuses to start if its ports are already in use.

## Known limitations

- **Live send is blocked.** Grok Bot Desktop's gateway answers 409 ("This Bot runs on the server…") to this CLI's
  send route for server-run bots. The send box is disabled and the server refuses send requests.
- **Live messages survive a reload only while the server runs.** The in-memory buffer keeps the last 100 per
  thread; a server restart clears it (by design, nothing is stored). The Live Grok Bot view itself always
  re-reads its thread from the server.
- **One-to-one replies are attributed to the thread's bot.** In a 1:1 thread the CLI gives bot replies no
  author, so they are labelled `thread target` (inferred from the thread), not `verified`. 1:1 entries of kind
  `message` with role `assistant` (e.g. agent-outbound summaries) match no rule and are `unknown`, shown only in
  the Live Grok Bot view.
- **Forms and widgets appear only as placeholders** (`[form: <title>]`, `[widget]`, `[attachment]`, …), in the
  Live Grok Bot view only: no bubble, nothing clickable, contents never read. A form's title can name an
  account (e.g. a login form).
- Polling costs about 0.4 s CPU per CLI call (~1 call every 10–15 s while running).
- The CLI's JSON output is undocumented; unexpected shapes are counted as malformed and skipped.
- The gateway-down path is tested with a stub CLI (missing, failing, hanging, failing mid-session), not by
  quitting Grok Bot Desktop.

## Demo-data notes

On 2026-11-25 (08:31–08:33 UTC) a screenshot script accidentally ran against the owner's own dev server, which
uses `data/demo/office.db`:

- **The 7 meeting rows were deleted.** The simulated "Demo stand-up" meeting (`meeting-mwvv8hk7-210`) was
  removed by exact id in one transaction (events 100,248 → 100,241). The pre-cleanup backup was deleted
  afterwards at the owner's request.
- **The +4 XP was left as it is.** kv `progression` most likely has `botXp` +4 each for `mock-chief-01`,
  `mock-review-06`, `mock-execution-04` and `mock-visual-05` (from that meeting's `meeting_started`). This is an
  inference, so no guess was written into the data.
- kv `source:simulation` was rewritten as `{"enabled":true}` at 08:32:39 UTC; the simulation was already on, so
  only its timestamp changed.

`data/office.db` was not affected (verified against a backup, which was deleted afterwards at the owner's request).

## Disable

Set `ENABLE_GROKBOT_LIVE_CONTROL=false` (or remove it) in `.env` and restart the server. Nothing is stored, so
there is nothing to clean up.

## Roll back

The feature is PR #2 from `feature/grokbot-live-control`. `main` (with PR #1 merged) does not contain it.

- **Before it is merged:** close or leave PR #2; `main` is unchanged. Locally, `git switch main`.
- **After it is merged:** use GitHub's **Revert** button on the merged PR (it opens a revert PR), or run
  `git revert -m 1 <merge commit>` on a new branch and open a PR. No data migration is needed: no schema or saved
  data changed. Do not use `git reset --hard`, `git push --force` or rebase.
