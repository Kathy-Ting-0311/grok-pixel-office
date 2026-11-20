import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { lstat, open, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { botEventSchema, classifySource } from '../../shared/events';
import type { BotEvent } from '../../shared/types';

/**
 * Provider A — Local Cache (read-only).
 *
 * Reads newline-delimited JSON event files (*.jsonl / *.ndjson) from ONE directory the user has
 * explicitly authorised. It does not recurse, does not follow symlinks, never opens files whose
 * names look like credentials, and never writes. It makes no assumption that Grok Bot itself writes
 * such files: it is an adapter for an exporter/log you control. A record is classified REAL only if
 * it says `"source":"real"` explicitly; otherwise UNKNOWN (or SIMULATED if it says so).
 */

export type LocalCacheStatus = {
  state: 'disabled' | 'watching' | 'error';
  dir?: string;
  authorizedAt?: string;
  files: number;
  accepted: number;
  rejected: number;
  unmatchedBots: number;
  duplicates: number;
  lastEventAt?: string;
  lastScanAt?: string;
  lastError?: string;
};

const SENSITIVE_NAME =
  /(credential|token|cookie|secret|password|passwd|session|auth|key|keychain|\.pem$)/i;
const EVENT_FILE = /\.(jsonl|ndjson)$/i;
const MAX_READ = 4 * 1024 * 1024;

/** Directories that are refused outright (credentials and OS-protected stores). */
export function refusedDirectory(dir: string): string | undefined {
  const home = homedir();
  const p = resolve(dir);
  const blocked = [
    join(home, '.ssh'),
    join(home, 'Library', 'Keychains'),
    join(home, 'Library', 'Cookies'),
    join(home, '.grokbot'),
    join(home, '.aws'),
    join(home, '.gnupg'),
  ];
  for (const b of blocked)
    if (p === b || p.startsWith(b + '/'))
      return `${b} holds credentials or private application state; it is not read. Export events to a separate folder instead.`;
  if (p === '/' || p === home)
    return 'Choose a specific folder, not the whole disk or home directory.';
  return undefined;
}

type FileCursor = { ino: number; offset: number; partial: string };

export class LocalCacheProvider {
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private debounce?: NodeJS.Timeout;
  private cursors = new Map<string, FileCursor>();
  private scanning = false;
  status: LocalCacheStatus = {
    state: 'disabled',
    files: 0,
    accepted: 0,
    rejected: 0,
    unmatchedBots: 0,
    duplicates: 0,
  };

  constructor(
    private readonly knownBots: Set<string>,
    private readonly emit: (e: BotEvent) => boolean,
    private readonly pollMs = 3000,
  ) {}

  async start(dir: string, authorizedAt: string) {
    this.stop();
    if (!isAbsolute(dir)) throw new Error('Use an absolute folder path.');
    const refused = refusedDirectory(dir);
    if (refused) throw new Error(refused);
    const info = await stat(dir).catch(() => undefined);
    if (!info?.isDirectory()) throw new Error('That folder does not exist or is not a directory.');
    this.status = {
      state: 'watching',
      dir,
      authorizedAt,
      files: 0,
      accepted: 0,
      rejected: 0,
      unmatchedBots: 0,
      duplicates: 0,
    };
    this.cursors.clear();
    try {
      this.watcher = watch(dir, { persistent: false }, () => this.schedule());
      this.watcher.on('error', (err) => this.fail(err));
    } catch (err) {
      this.fail(err); // polling still works
      this.status.state = 'watching';
    }
    this.timer = setInterval(() => void this.scan(), this.pollMs);
    await this.scan();
  }

  stop() {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = undefined;
    this.status = {
      state: 'disabled',
      files: 0,
      accepted: 0,
      rejected: 0,
      unmatchedBots: 0,
      duplicates: 0,
    };
  }

  private schedule() {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.scan(), 200);
  }

  private fail(err: unknown) {
    this.status.lastError = err instanceof Error ? err.message : String(err);
  }

  async scan() {
    const dir = this.status.dir;
    if (!dir || this.scanning) return;
    this.scanning = true;
    try {
      const names = (await readdir(dir)).filter(
        (n) => EVENT_FILE.test(n) && !SENSITIVE_NAME.test(n),
      );
      this.status.files = names.length;
      for (const name of names) await this.readFile(join(dir, name));
      this.status.lastScanAt = new Date().toISOString();
      if (this.status.state === 'error') this.status.state = 'watching';
    } catch (err) {
      this.fail(err);
      this.status.state = 'error';
    } finally {
      this.scanning = false;
    }
  }

  private async readFile(path: string) {
    const l = await lstat(path);
    if (!l.isFile()) return; // skip symlinks, sockets, directories
    let cur = this.cursors.get(path);
    // Rotation / truncation: new inode or shrunk file → start from the beginning (dedupe protects us).
    if (!cur || cur.ino !== l.ino || l.size < cur.offset)
      cur = { ino: l.ino, offset: 0, partial: '' };
    if (l.size === cur.offset) {
      this.cursors.set(path, cur);
      return;
    }
    const length = Math.min(MAX_READ, l.size - cur.offset);
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, cur.offset);
      cur.offset += bytesRead;
      const text = cur.partial + buf.subarray(0, bytesRead).toString('utf8');
      const lines = text.split('\n');
      cur.partial = lines.pop() ?? '';
      if (cur.partial.length > 1_000_000) cur.partial = ''; // runaway line guard
      lines.forEach((line, i) => this.ingest(line, path, cur!.offset, i));
    } finally {
      await fh.close();
      this.cursors.set(path, cur);
    }
  }

  private ingest(line: string, path: string, offset: number, i: number) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      this.status.rejected++;
      return;
    }
    const id =
      typeof raw.id === 'string' && raw.id
        ? raw.id
        : `local-${createHash('sha1').update(`${path}\n${trimmed}`).digest('hex').slice(0, 20)}`;
    void offset;
    void i;
    const candidate = {
      ...raw,
      id: `local:${id}`,
      source: classifySource(raw.source, true),
      payload: typeof raw.payload === 'object' && raw.payload ? raw.payload : {},
    };
    const parsed = botEventSchema.safeParse(candidate);
    if (!parsed.success) {
      this.status.rejected++;
      return;
    }
    if (!this.knownBots.has(parsed.data.botId)) {
      this.status.unmatchedBots++;
      return;
    }
    if (this.emit(parsed.data as BotEvent)) {
      this.status.accepted++;
      if (!this.status.lastEventAt || this.status.lastEventAt < parsed.data.timestamp)
        this.status.lastEventAt = parsed.data.timestamp;
    } else this.status.duplicates++;
  }
}
