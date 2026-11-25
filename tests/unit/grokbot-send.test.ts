import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildArgs,
  createCliClient,
  SEND_MAX_CHARS,
  SEND_TIMEOUT_MS,
  type CliCommand,
  type ExecFn,
} from '../../backend/src/grokbot/cli';
import { loadLiveControlConfig } from '../../backend/src/grokbot/config';
import { COZ } from '../fixtures/grokbot/fixtures';

// Phase 3: `send` only through a fake runner. No test here starts a process or sends anything.

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const fakeRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'gbot-send-test-'));
  dirs.push(root);
  const repo = join(root, 'grok-bot-cli');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'dist', 'bin'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'grok-bot-cli' }));
  writeFileSync(join(repo, 'dist', 'bin', 'gbot.mjs'), '// fake\n');
  chmodSync(join(repo, 'dist', 'bin', 'gbot.mjs'), 0o755);
  return join(repo, 'dist', 'bin', 'gbot.mjs');
};
const cfgFor = (cliPath: string) =>
  loadLiveControlConfig({ ENABLE_GROKBOT_LIVE_CONTROL: 'true', GROKBOT_CLI_PATH: cliPath });

type Call = { args: string[]; timeout: number };
const runner = (onSend: () => { stdout: string } | Error) => {
  const calls: Call[] = [];
  const exec: ExecFn = async (_file, args, opts) => {
    calls.push({ args, timeout: opts.timeout });
    if (args[0] === '-C') return { stdout: '9616503f00dfeedfacecafebeefdeadbeef00001\n', stderr: '' };
    if (args.includes('--version')) return { stdout: 'gbot 0.12.5\n', stderr: '' };
    const a = onSend();
    if (a instanceof Error) throw a;
    return { stdout: a.stdout, stderr: '' };
  };
  return { calls, exec, sends: () => calls.filter((c) => c.args[1] === 'send') };
};

const MSG = 'Live Control test from Pixel Office - please reply OK';

describe('send allowlist', () => {
  it('builds one fixed argv: target, text, --gateway --no-history --json', () => {
    expect(buildArgs({ cmd: 'send', id: COZ, text: MSG })).toEqual([
      'send',
      COZ,
      MSG,
      '--gateway',
      '--no-history',
      '--json',
    ]);
  });

  it('refuses bad targets and bad text', () => {
    const bad: unknown[] = [
      { cmd: 'send', id: 'Coz · Chief', text: 'hi' },
      { cmd: 'send', id: '--files', text: 'hi' },
      { cmd: 'send', id: COZ, text: '' },
      { cmd: 'send', id: COZ, text: '   ' },
      { cmd: 'send', id: COZ, text: 'x'.repeat(SEND_MAX_CHARS + 1) },
      { cmd: 'send', id: COZ, text: '--envelope' },
      { cmd: 'send', id: COZ, text: 'line1\nline2' },
      { cmd: 'send', id: COZ, text: 'bell\u0007' },
    ];
    for (const b of bad) expect(() => buildArgs(b as CliCommand), JSON.stringify(b)).toThrow();
  });
});

describe('client.send', () => {
  it('refuses to send before the CLI is verified', async () => {
    const r = runner(() => ({ stdout: '{}' }));
    const cli = createCliClient(cfgFor(fakeRepo()), r.exec);
    await expect(cli.send(COZ, MSG)).rejects.toThrow(/not been verified/);
    expect(r.calls).toHaveLength(0);
  });

  it('runs exactly once and returns the receipt as is', async () => {
    const receipt = { exitCode: 0, delivery: 'accepted', kind: 'bot', id: COZ, messageId: 'm1' };
    const r = runner(() => ({ stdout: JSON.stringify(receipt) }));
    const cli = createCliClient(cfgFor(fakeRepo()), r.exec);
    await cli.verify();
    const out = await cli.send(COZ, MSG);
    expect(out).toMatchObject({ ok: true, timedOut: false, doc: receipt });
    expect(r.sends()).toHaveLength(1);
    expect(r.sends()[0].timeout).toBe(SEND_TIMEOUT_MS);
  });

  it('a failure is returned word for word and never retried', async () => {
    const doc = { exitCode: 1, delivery: 'unknown', error: 'gateway closed' };
    const r = runner(() =>
      Object.assign(new Error('Command failed'), { code: 1, stdout: JSON.stringify(doc), stderr: '' }),
    );
    const cli = createCliClient(cfgFor(fakeRepo()), r.exec);
    await cli.verify();
    const out = await cli.send(COZ, MSG);
    expect(out).toMatchObject({ ok: false, exitCode: 1, timedOut: false, doc });
    expect(r.sends()).toHaveLength(1);
  });

  it('a timeout is reported as timed out (delivery unknown) and never retried', async () => {
    const r = runner(() => Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' }));
    const cli = createCliClient(cfgFor(fakeRepo()), r.exec);
    await cli.verify();
    const out = await cli.send(COZ, MSG);
    expect(out).toMatchObject({ ok: false, timedOut: true });
    expect(r.sends()).toHaveLength(1);
  });
});
