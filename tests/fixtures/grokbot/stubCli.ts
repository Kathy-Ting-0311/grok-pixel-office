import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bots, COZ, KRYSTAL, OWNER, sendMessage, thread, userMessage } from './fixtures';

/**
 * A STUB grok-bot-cli for tests (never the real CLI): a fake checkout in a fresh temp folder outside the
 * repo, with a stub `git` that reports the expected commit. Every call is logged to `calls.log`.
 * Its transcripts are synthetic test fixtures, clearly marked "[stub]", served only to the test's own
 * in-memory server and never stored.
 *
 * Modes (file `mode`, re-read on every call): ok | fail | hang | ok-then-fail (ok for the first N calls).
 */
export type StubMode = 'ok' | 'fail' | 'hang' | 'ok-then-fail';

export const STUB_TEXT = '[stub] Hello from the stub CLI';

const SCRIPT = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// <root>/grok-bot-cli/dist/bin/gbot.mjs -> <root>/stub-data
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'stub-data');
const args = process.argv.slice(2);
appendFileSync(join(root, 'calls.log'), JSON.stringify(args) + '\\n');
const mode = readFileSync(join(root, 'mode'), 'utf8').trim();
const countFile = join(root, 'count');
const n = (existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0) + 1;
writeFileSync(countFile, String(n));
const okLeft = Number(readFileSync(join(root, 'ok-calls'), 'utf8'));
if (args[0] === '--version') { console.log('gbot 0.12.5'); process.exit(0); }
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'fail' || (mode === 'ok-then-fail' && n > okLeft)) {
  console.log(JSON.stringify({ exitCode: 1, delivery: 'unknown', error: 'stub: gateway unavailable' }));
  process.exit(1);
} else {
  const file = args[0] === 'bots' ? 'bots.json' : args[0] === 'groups' ? 'groups.json'
    : args[0] === 'thread' ? (args.includes('--after') ? 'empty-' + args[1] + '.json' : 'thread-' + args[1] + '.json')
    : null;
  if (!file || !existsSync(join(root, file))) { console.log(JSON.stringify({ exitCode: 1, error: 'stub: unsupported' })); process.exit(1); }
  process.stdout.write(readFileSync(join(root, file), 'utf8'));
}
`;

export function makeStubCli(opts: { mode?: StubMode; okCalls?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gbot-stub-'));
  const repo = join(root, 'grok-bot-cli');
  const data = join(root, 'stub-data');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'dist', 'bin'), { recursive: true });
  mkdirSync(data);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'grok-bot-cli' }));
  const cliPath = join(repo, 'dist', 'bin', 'gbot.mjs');
  writeFileSync(cliPath, SCRIPT);
  chmodSync(cliPath, 0o755);
  const gitPath = join(root, 'git');
  writeFileSync(gitPath, '#!/bin/sh\necho 9616503000000000000000000000000000000000\n');
  chmodSync(gitPath, 0o755);

  writeFileSync(join(data, 'bots.json'), JSON.stringify(bots));
  writeFileSync(join(data, 'groups.json'), '[]');
  const t = (id: string, name: string, entries: unknown[]) => {
    writeFileSync(join(data, `thread-${id}.json`), JSON.stringify(thread(id, entries, { name })));
    writeFileSync(join(data, `empty-${id}.json`), JSON.stringify(thread(id, [], { name, after: { cursor: 'c1' } })));
  };
  t(COZ, 'Coz · Chief', [
    userMessage('t1u', 1, '[stub] Hi Coz'),
    sendMessage('t1s0', 2, STUB_TEXT),
    sendMessage('t1s1', 3, '', { message: { type: 'widget' } }),
  ]);
  t(KRYSTAL, 'Krystal · Research', []);
  for (const b of bots) if (b.id !== COZ && b.id !== KRYSTAL) t(b.id, b.name, []);

  const setMode = (mode: StubMode, okCalls = 0) => {
    writeFileSync(join(data, 'mode'), mode);
    writeFileSync(join(data, 'ok-calls'), String(okCalls));
    writeFileSync(join(data, 'count'), '0');
  };
  setMode(opts.mode ?? 'ok', opts.okCalls ?? 0);
  const calls = (): string[][] => {
    const f = join(data, 'calls.log');
    return existsSync(f)
      ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[])
      : [];
  };
  const env = (over: Record<string, string> = {}) => ({
    ENABLE_GROKBOT_LIVE_CONTROL: 'true',
    GROKBOT_CLI_PATH: cliPath,
    GROKBOT_GIT_PATH: gitPath,
    GROKBOT_OWNER_AGENT_ID: OWNER,
    GROKBOT_LIVE_SEND_ENABLED: 'false',
    ...over,
  });
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { root, cliPath, gitPath, setMode, calls, env, cleanup, log: (s: string) => appendFileSync(join(data, 'notes.log'), s) };
}
