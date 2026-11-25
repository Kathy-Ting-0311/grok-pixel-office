import { execFile as nodeExecFile } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { LiveControlConfig } from './config';

/**
 * The only place Live Control starts a process. Commands are a closed union built into fixed argv
 * arrays; nothing from a request is ever used as a command or flag. No shell, absolute paths only,
 * a minimal environment (no API keys or tokens), a timeout and an output cap on every call.
 */

export type CliErrorKind =
  'missing' | 'unverified' | 'config' | 'timeout' | 'exit' | 'parse' | 'refused';

export class GrokBotCliError extends Error {
  constructor(
    readonly kind: CliErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'GrokBotCliError';
  }
}

/** Read-only commands (Phase 1) plus one write command, `send` (Phase 3, approved per test). */
export type CliCommand =
  | { cmd: 'version' }
  | { cmd: 'bots' }
  | { cmd: 'groups' }
  | { cmd: 'thread'; id: string; limit: number; after?: string }
  | { cmd: 'send'; id: string; text: string };

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTRY_ID = /^[A-Za-z0-9:_-]{1,200}$/;
export const SEND_MAX_CHARS = 500;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Builds the argv for one allowlisted command, or throws `refused`. */
export function buildArgs(c: CliCommand): string[] {
  switch (c.cmd) {
    case 'version':
      return ['--version'];
    case 'bots':
      return ['bots', 'list', '--json'];
    case 'groups':
      return ['groups', 'list', '--json'];
    case 'thread': {
      if (!UUID.test(c.id)) throw new GrokBotCliError('refused', 'Thread id is not a valid id.');
      if (!Number.isInteger(c.limit) || c.limit < 1 || c.limit > 200)
        throw new GrokBotCliError('refused', 'Thread limit must be 1-200.');
      const args = ['thread', c.id, '--json', '--no-history', '--limit', String(c.limit)];
      if (c.after !== undefined) {
        if (!ENTRY_ID.test(c.after))
          throw new GrokBotCliError('refused', 'Cursor is not a valid entry id.');
        args.push('--after', c.after);
      }
      return args;
    }
    case 'send': {
      // The target is checked against the discovered 1:1 bots by the caller; here only its shape.
      if (!UUID.test(c.id)) throw new GrokBotCliError('refused', 'Send target is not a valid id.');
      const t = c.text;
      if (typeof t !== 'string' || t.trim().length === 0 || t.length > SEND_MAX_CHARS)
        throw new GrokBotCliError('refused', `Message must be 1-${SEND_MAX_CHARS} characters.`);
      if (CONTROL.test(t)) throw new GrokBotCliError('refused', 'Message has control characters.');
      // A leading '-' could be parsed as a flag.
      if (t.startsWith('-')) throw new GrokBotCliError('refused', 'Message may not start with "-".');
      // Fixed flags only: no --envelope, --reply-mode or --request-id.
      return ['send', c.id, t, '--gateway', '--no-history', '--json'];
    }
    default:
      throw new GrokBotCliError('refused', 'Command is not allowlisted.');
  }
}

/** Only what the CLI needs to find the user's Grok Bot Desktop; never XAI_API_KEY or OFFICE_TOKEN. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ['HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR'])
    if (env[k] !== undefined) out[k] = env[k];
  return out;
}

/** Removes anything token-shaped and caps length, for text that may reach a status or log. */
export function scrub(text: string, max = 300) {
  const t = text
    .replace(/xai-[A-Za-z0-9]{20,}/g, '[redacted]')
    .replace(/\b(Bearer|token|key|secret|cookie)\b[=: ]+\S+/gi, '$1 [redacted]')
    .replace(/[A-Za-z0-9+/_-]{48,}={0,2}/g, '[redacted]');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

type ExecResult = { stdout: string; stderr: string };
export type ExecFn = (
  file: string,
  args: string[],
  opts: { timeout: number; env: NodeJS.ProcessEnv; cwd: string },
) => Promise<ExecResult>;

const MAX_BUFFER = 8 * 1024 * 1024;

export const realExec: ExecFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    nodeExecFile(
      file,
      args,
      {
        shell: false,
        timeout: opts.timeout,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_BUFFER,
        env: opts.env,
        cwd: opts.cwd,
        windowsHide: true,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stdout, stderr }));
        else resolve({ stdout, stderr });
      },
    );
  });

/** Maps a failed child process to a typed error. stdout may hold the CLI's JSON failure document. */
export function classifyExecError(err: unknown): GrokBotCliError {
  const e = err as NodeJS.ErrnoException & {
    killed?: boolean;
    signal?: string | null;
    stdout?: string;
    code?: string | number;
  };
  if (e.code === 'ENOENT') return new GrokBotCliError('missing', 'The Grok Bot CLI was not found.');
  if (e.killed || e.signal === 'SIGKILL' || e.signal === 'SIGTERM')
    return new GrokBotCliError('timeout', 'The Grok Bot CLI did not answer in time.');
  if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
    return new GrokBotCliError('exit', 'The Grok Bot CLI returned too much output.');
  let detail = '';
  try {
    const doc = JSON.parse(e.stdout ?? '') as { error?: unknown };
    if (typeof doc.error === 'string') detail = doc.error;
  } catch {
    /* not JSON */
  }
  return new GrokBotCliError(
    'exit',
    scrub(`The Grok Bot CLI failed (exit ${String(e.code ?? '?')})${detail ? `: ${detail}` : '.'}`),
  );
}

export type CliInfo = { path: string; repo: string; commit: string; version: string };

export interface CliClient {
  /** Checks the path, the repo commit and the version. Must succeed before `json`. */
  verify(): Promise<CliInfo>;
  /** Runs one allowlisted command and parses its JSON output. */
  json(c: CliCommand): Promise<unknown>;
  /**
   * Runs `send` exactly once and returns the raw outcome without throwing on a CLI failure, so the
   * caller can report it word for word. Never retried here or anywhere else.
   */
  send(id: string, text: string): Promise<SendOutcome>;
}

export type SendOutcome = {
  ok: boolean;
  exitCode: number | string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  doc?: unknown;
};

/** A send can take longer than a read; a timeout means delivery is unknown. */
export const SEND_TIMEOUT_MS = 60_000;

/** Walks up from the CLI entry to the repo that owns it (package name grok-bot-cli with a .git). */
function findRepo(entry: string): string | undefined {
  let d = dirname(entry);
  for (let i = 0; i < 6; i++) {
    const pkg = join(d, 'package.json');
    if (existsSync(pkg) && existsSync(join(d, '.git'))) {
      try {
        if ((JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === 'grok-bot-cli')
          return d;
      } catch {
        /* keep walking */
      }
    }
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return undefined;
}

export function createCliClient(cfg: LiveControlConfig, exec: ExecFn = realExec): CliClient {
  let verified: CliInfo | undefined;
  const run = async (file: string, args: string[]) => {
    try {
      return (await exec(file, args, { timeout: cfg.timeoutMs, env: childEnv(), cwd: tmpdir() }))
        .stdout;
    } catch (err) {
      throw classifyExecError(err);
    }
  };
  const entryOk = () => {
    if (!cfg.cliPath || !isAbsolute(cfg.cliPath))
      throw new GrokBotCliError('missing', 'GROKBOT_CLI_PATH is not set to an absolute path.');
    if (!existsSync(cfg.cliPath) || !statSync(cfg.cliPath).isFile())
      throw new GrokBotCliError('missing', 'The Grok Bot CLI was not found at GROKBOT_CLI_PATH.');
    try {
      accessSync(cfg.cliPath, constants.X_OK);
    } catch {
      throw new GrokBotCliError('missing', 'GROKBOT_CLI_PATH is not an executable file.');
    }
    const real = realpathSync(cfg.cliPath);
    if (/\/_npx\/|\/lib\/node_modules\/grok-bot-cli\//.test(real))
      throw new GrokBotCliError(
        'unverified',
        'GROKBOT_CLI_PATH points at an npm-installed CLI; use the patched repo build.',
      );
    return real;
  };
  return {
    async verify() {
      const real = entryOk();
      const repo = findRepo(real);
      if (!repo)
        throw new GrokBotCliError('unverified', 'The CLI is not inside a grok-bot-cli git repo.');
      const commit = (await run(cfg.gitPath, ['-C', repo, 'rev-parse', 'HEAD'])).trim();
      const want = cfg.expectedCommit.toLowerCase();
      if (!/^[0-9a-f]{7,40}$/.test(commit) || !commit.startsWith(want))
        throw new GrokBotCliError(
          'unverified',
          `The CLI repo is at ${commit.slice(0, 7) || 'unknown'}, expected ${want.slice(0, 7)}.`,
        );
      const version = (
        await run(process.execPath, [real, ...buildArgs({ cmd: 'version' })])
      ).trim();
      if (!/^gbot \d+\.\d+\.\d+/.test(version))
        throw new GrokBotCliError('unverified', 'The CLI did not report a gbot version.');
      verified = { path: real, repo, commit: commit.slice(0, 7), version };
      return verified;
    },
    async json(c) {
      if (!verified) throw new GrokBotCliError('unverified', 'The CLI has not been verified.');
      // Re-checked on every call so a CLI removed mid-session is reported as missing.
      const real = entryOk();
      if (real !== verified.path)
        throw new GrokBotCliError('unverified', 'The CLI path changed since it was verified.');
      const out = await run(process.execPath, [real, ...buildArgs(c)]);
      try {
        return JSON.parse(out);
      } catch {
        throw new GrokBotCliError('parse', 'The Grok Bot CLI returned output that is not JSON.');
      }
    },
    async send(id, text) {
      if (!verified) throw new GrokBotCliError('unverified', 'The CLI has not been verified.');
      const real = entryOk();
      if (real !== verified.path)
        throw new GrokBotCliError('unverified', 'The CLI path changed since it was verified.');
      const args = [real, ...buildArgs({ cmd: 'send', id, text })];
      const parse = (s: string) => {
        try {
          return JSON.parse(s) as unknown;
        } catch {
          return undefined;
        }
      };
      try {
        const r = await exec(process.execPath, args, {
          timeout: Math.max(cfg.timeoutMs, SEND_TIMEOUT_MS),
          env: childEnv(),
          cwd: tmpdir(),
        });
        return { ok: true, exitCode: 0, timedOut: false, stdout: r.stdout, stderr: r.stderr, doc: parse(r.stdout) };
      } catch (err) {
        const e = err as { code?: number | string; killed?: boolean; signal?: string | null; stdout?: string; stderr?: string };
        const stdout = e.stdout ?? '';
        return {
          ok: false,
          exitCode: e.code ?? null,
          timedOut: !!e.killed || e.signal === 'SIGKILL',
          stdout,
          stderr: e.stderr ?? '',
          doc: parse(stdout),
        };
      }
    },
  };
}
