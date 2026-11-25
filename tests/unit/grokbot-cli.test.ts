import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildArgs,
  childEnv,
  classifyExecError,
  createCliClient,
  scrub,
  type CliCommand,
  type ExecFn,
} from '../../backend/src/grokbot/cli';
import { loadLiveControlConfig } from '../../backend/src/grokbot/config';
import { COZ } from '../fixtures/grokbot/fixtures';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A fake grok-bot-cli checkout: package.json + .git + dist/bin/gbot.mjs (never executed). */
const fakeRepo = (sub = 'grok-bot-cli') => {
  const root = mkdtempSync(join(tmpdir(), 'gbot-test-'));
  dirs.push(root);
  const repo = join(root, sub);
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'dist', 'bin'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'grok-bot-cli' }));
  writeFileSync(join(repo, 'dist', 'bin', 'gbot.mjs'), '// fake\n');
  chmodSync(join(repo, 'dist', 'bin', 'gbot.mjs'), 0o755);
  return { repo, entry: join(repo, 'dist', 'bin', 'gbot.mjs') };
};
const cfgFor = (cliPath: string, commit = '9616503') =>
  loadLiveControlConfig({
    ENABLE_GROKBOT_LIVE_CONTROL: 'true',
    GROKBOT_CLI_PATH: cliPath,
    GROKBOT_CLI_COMMIT: commit,
  });

type Call = { file: string; args: string[]; env: NodeJS.ProcessEnv; timeout: number };
const recorder = (answer: (c: Call) => string | Error) => {
  const calls: Call[] = [];
  const exec: ExecFn = async (file, args, opts) => {
    const c = { file, args, env: opts.env, timeout: opts.timeout };
    calls.push(c);
    const a = answer(c);
    if (a instanceof Error) throw a;
    return { stdout: a, stderr: '' };
  };
  return { calls, exec };
};
const happy = (c: Call) =>
  c.args[0] === '-C'
    ? '9616503f00dfeedfacecafebeefdeadbeef00001\n'
    : c.args.includes('--version')
      ? 'gbot 0.12.5\n'
      : '[]';

describe('CLI allowlist', () => {
  it('builds fixed argv arrays for read commands only', () => {
    expect(buildArgs({ cmd: 'version' })).toEqual(['--version']);
    expect(buildArgs({ cmd: 'bots' })).toEqual(['bots', 'list', '--json']);
    expect(buildArgs({ cmd: 'groups' })).toEqual(['groups', 'list', '--json']);
    expect(buildArgs({ cmd: 'thread', id: COZ, limit: 20 })).toEqual([
      'thread',
      COZ,
      '--json',
      '--no-history',
      '--limit',
      '20',
    ]);
    expect(buildArgs({ cmd: 'thread', id: COZ, limit: 50, after: 't8s2' })).toEqual([
      'thread',
      COZ,
      '--json',
      '--no-history',
      '--limit',
      '50',
      '--after',
      't8s2',
    ]);
  });

  it('refuses anything that is not an allowlisted, validated command', () => {
    const bad: unknown[] = [
      { cmd: 'thread', id: '--gateway', limit: 5 },
      { cmd: 'thread', id: `${COZ}; rm -rf /`, limit: 5 },
      { cmd: 'thread', id: 'Coz · Chief', limit: 5 },
      { cmd: 'thread', id: COZ, limit: 0 },
      { cmd: 'thread', id: COZ, limit: 201 },
      { cmd: 'thread', id: COZ, limit: 1.5 },
      { cmd: 'thread', id: COZ, limit: 5, after: '--root x' },
      { cmd: 'thread', id: COZ, limit: 5, after: '' },
      { cmd: 'send', id: COZ }, // send is allowlisted since Phase 3; without text it is refused

      { cmd: 'bots delete' },
      { cmd: 'doctor' },
    ];
    for (const b of bad) expect(() => buildArgs(b as CliCommand), JSON.stringify(b)).toThrow();
  });

  it('gives the child process no API keys or tokens', () => {
    const env = childEnv({
      HOME: '/Users/x',
      PATH: '/usr/bin',
      XAI_API_KEY: 'xai-secret',
      OFFICE_TOKEN: 'tok',
      GROKBOT_CLI_PATH: '/x',
      AWS_SECRET_ACCESS_KEY: 'a',
    });
    expect(env).toEqual({ HOME: '/Users/x', PATH: '/usr/bin' });
  });

  it('scrubs token-shaped text and caps length', () => {
    expect(scrub(`failed: xai-${'a'.repeat(30)} token=abc123`)).toBe(
      'failed: [redacted] token [redacted]',
    );
    expect(scrub('x'.repeat(10) + ' ' + 'y'.repeat(400)).length).toBeLessThanOrEqual(300);
  });
});

describe('CLI client', () => {
  it('verifies commit and version, then runs node with the absolute entry and a fixed argv', async () => {
    const { repo, entry } = fakeRepo();
    const { calls, exec } = recorder(happy);
    const cli = createCliClient(cfgFor(entry), exec);
    const info = await cli.verify();
    expect(info).toMatchObject({ commit: '9616503', version: 'gbot 0.12.5' });
    expect(calls[0]).toMatchObject({ file: '/usr/bin/git' });
    expect(calls[0].args[0]).toBe('-C');
    expect(calls[0].args.slice(2)).toEqual(['rev-parse', 'HEAD']);
    expect(calls[0].args[1].endsWith('grok-bot-cli')).toBe(true);
    expect(repo.endsWith('grok-bot-cli')).toBe(true);
    await cli.json({ cmd: 'bots' });
    const last = calls.at(-1)!;
    expect(last.file).toBe(process.execPath);
    expect(last.args.slice(1)).toEqual(['bots', 'list', '--json']);
    expect(last.args[0].endsWith('/dist/bin/gbot.mjs')).toBe(true);
    expect(last.env.XAI_API_KEY).toBeUndefined();
    expect(last.timeout).toBe(15000);
  });

  it('refuses a missing, relative, npm-installed or wrong-commit CLI without running it', async () => {
    const { calls, exec } = recorder(happy);
    await expect(createCliClient(cfgFor(''), exec).verify()).rejects.toMatchObject({
      kind: 'missing',
    });
    await expect(createCliClient(cfgFor('dist/bin/gbot.mjs'), exec).verify()).rejects.toMatchObject(
      { kind: 'missing' },
    );
    await expect(
      createCliClient(cfgFor('/nonexistent/grok-bot-cli/dist/bin/gbot.mjs'), exec).verify(),
    ).rejects.toMatchObject({ kind: 'missing' });
    const plain = fakeRepo();
    chmodSync(plain.entry, 0o644);
    await expect(createCliClient(cfgFor(plain.entry), exec).verify()).rejects.toMatchObject({
      kind: 'missing',
      message: 'GROKBOT_CLI_PATH is not an executable file.',
    });
    const npx = fakeRepo('_npx/abc/node_modules/grok-bot-cli');
    await expect(createCliClient(cfgFor(npx.entry), exec).verify()).rejects.toMatchObject({
      kind: 'unverified',
    });
    expect(calls).toEqual([]);
    const { entry } = fakeRepo();
    await expect(createCliClient(cfgFor(entry, 'abcdef0'), exec).verify()).rejects.toMatchObject({
      kind: 'unverified',
      message: expect.stringMatching(/expected abcdef0/),
    });
    // Only git ran; the CLI itself never did.
    expect(calls.map((c) => c.file)).toEqual(['/usr/bin/git']);
    await expect(createCliClient(cfgFor(entry), exec).json({ cmd: 'bots' })).rejects.toMatchObject({
      kind: 'unverified',
    });
  });

  it('reports a CLI removed after verification as missing', async () => {
    const { repo, entry } = fakeRepo();
    const { exec } = recorder(happy);
    const cli = createCliClient(cfgFor(entry), exec);
    await cli.verify();
    rmSync(repo, { recursive: true, force: true });
    await expect(cli.json({ cmd: 'bots' })).rejects.toMatchObject({ kind: 'missing' });
  });

  it('maps failures to typed errors', async () => {
    const { entry } = fakeRepo();
    let next: Error | string = '[]';
    const { exec } = recorder((c) =>
      c.args[0] === '-C' || c.args.includes('--version') ? happy(c) : next,
    );
    const cli = createCliClient(cfgFor(entry), exec);
    await cli.verify();
    next = 'not json';
    await expect(cli.json({ cmd: 'bots' })).rejects.toMatchObject({ kind: 'parse' });
    next = Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' });
    await expect(cli.json({ cmd: 'bots' })).rejects.toMatchObject({ kind: 'timeout' });
    next = Object.assign(new Error('exit'), {
      code: 1,
      stdout: JSON.stringify({ error: 'Gateway is not reachable', exitCode: 1 }),
    });
    await expect(cli.json({ cmd: 'bots' })).rejects.toMatchObject({
      kind: 'exit',
      message: expect.stringMatching(/Gateway is not reachable/),
    });
    expect(classifyExecError(Object.assign(new Error('x'), { code: 'ENOENT' })).kind).toBe(
      'missing',
    );
  });
});
