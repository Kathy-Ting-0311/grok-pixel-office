import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redact, type GrokConfig } from './config';
import type { AgentOutput, OutputType } from './grok';
import type { PlacedTask } from './tasks';

// Saved task results: data/results/<task_id>.json + index.json (+ files/<task_id>/).
// Every write is atomic (tmp file + rename). ':memory:' keeps everything in RAM for tests.

export type ResultStatus = 'done' | 'failed' | 'cancelled';
export type ResultFile = { name: string; size: number; type: string };
export type ResultRecord = {
  task_id: number;
  title: string;
  details: string;
  agent: string;
  created_at: string;
  finished_at: string;
  status: ResultStatus;
  output_type: OutputType;
  output: string;
  language?: string;
  summary?: string;
  error?: string;
  files: ResultFile[];
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  model: string;
  mock: boolean;
  /** Set only on results saved from a real Grok Bot Desktop reply (by an explicit "Save as Result"). */
  source?: DesktopSource;
};
/** Where a Grok Desktop result came from. No URLs or file paths: attachments are not reachable here. */
export type DesktopSource = {
  kind: 'grok-desktop';
  agentId: string;
  agentName: string;
  threadId: string;
  messageKey: string;
  entryId: string;
  timestamp: string;
  attribution: string;
  attachments: { name: string; type: string }[];
};
/** Desktop results use their own id range, so they can never collide with xAI task ids. */
export const DESKTOP_ID_BASE = 1_000_000_000;
export const isDesktopId = (id: number) => id >= DESKTOP_ID_BASE;
export type ResultEntry = {
  id: number;
  title: string;
  agent: string;
  time: string;
  status: ResultStatus;
  type: OutputType;
  cost: number;
  pinned: boolean;
  read: boolean;
  /** 'grok-desktop' for Desktop results; absent for xAI task results. */
  src?: 'grok-desktop';
};
type Index = { keep: number; results: ResultEntry[] };

export const LIMITS = { fileBytes: 200_000, outputChars: 200_000, files: 5, imageBytes: 8_000_000 };
const mime: Record<string, string> = {
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  html: 'text/plain; charset=utf-8', // never served as a page
  py: 'text/plain; charset=utf-8',
  js: 'text/plain; charset=utf-8',
  ts: 'text/plain; charset=utf-8',
  css: 'text/plain; charset=utf-8',
  sql: 'text/plain; charset=utf-8',
};
export const mimeOf = (name: string) =>
  mime[name.split('.').pop()!.toLowerCase()] ?? 'text/plain; charset=utf-8';
export const isImage = (name: string) => /\.(svg|png|jpe?g|webp)$/i.test(name);

/** A safe file name: no paths, only letters/digits/._-, an allowed extension (else .txt). */
export function safeName(raw: string) {
  const base = raw.split(/[\\/]/).pop() ?? '';
  let n =
    base
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 80) || 'file';
  const ext = n.includes('.') ? n.split('.').pop()!.toLowerCase() : '';
  if (!(ext in mime)) n += '.txt';
  return n;
}
/** Strips anything active from an SVG. It is also served with a sandbox CSP and shown only via <img>. */
export const cleanSvg = (svg: string) =>
  svg
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href\s*=\s*["']?)\s*javascript:[^"'\s>]*/gi, '$1#');

const today = () => new Date().toISOString();

export class ResultStore {
  private mem = new Map<string, Buffer>();
  private index: Index;

  constructor(
    private readonly dir: string,
    defaultKeep = 500,
  ) {
    try {
      const i = JSON.parse(this.read('index.json')!.toString('utf8')) as Index;
      this.index = {
        keep: i.keep ?? defaultKeep,
        results: Array.isArray(i.results) ? i.results : [],
      };
    } catch {
      this.index = { keep: defaultKeep, results: [] };
    }
  }

  // ---- tiny storage layer (disk or memory) ----
  private read(rel: string): Buffer | undefined {
    if (this.dir === ':memory:') return this.mem.get(rel);
    try {
      return readFileSync(join(this.dir, rel));
    } catch {
      return undefined;
    }
  }
  private write(rel: string, data: string | Buffer) {
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    if (this.dir === ':memory:') return void this.mem.set(rel, buf);
    const file = join(this.dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, buf);
    renameSync(`${file}.tmp`, file);
  }
  private remove(rel: string) {
    if (this.dir === ':memory:') {
      for (const k of [...this.mem.keys()])
        if (k === rel || k.startsWith(`${rel}/`)) this.mem.delete(k);
      return;
    }
    rmSync(join(this.dir, rel), { recursive: true, force: true });
  }
  private saveIndex() {
    this.write('index.json', JSON.stringify(this.index));
  }

  // ---- queries ----
  list() {
    return { keep: this.index.keep, results: [...this.index.results].sort((a, b) => b.id - a.id) };
  }
  get(id: number): ResultRecord | undefined {
    const b = this.read(`${id}.json`);
    return b ? (JSON.parse(b.toString('utf8')) as ResultRecord) : undefined;
  }
  file(id: number, name: string) {
    if (name !== safeName(name)) return undefined;
    const rec = this.get(id);
    if (!rec?.files.some((f) => f.name === name)) return undefined;
    return this.read(`files/${id}/${name}`);
  }

  // ---- writes ----
  /** Saves (or replaces, on retry) the record for a finished task and returns it. */
  save(
    t: PlacedTask,
    cfg: GrokConfig,
    output: AgentOutput | undefined,
    extraFiles: { name: string; data: Buffer }[] = [],
  ): ResultRecord {
    this.remove(`files/${t.id}`);
    const files: ResultFile[] = [];
    const add = (rawName: string, data: Buffer) => {
      if (files.length >= LIMITS.files) return;
      let name = safeName(rawName);
      while (files.some((f) => f.name === name)) name = `${files.length}-${name}`;
      const limit = isImage(name) && !name.endsWith('.svg') ? LIMITS.imageBytes : LIMITS.fileBytes;
      if (data.length > limit) return;
      this.write(
        `files/${t.id}/${name}`,
        name.endsWith('.svg') ? Buffer.from(cleanSvg(data.toString('utf8'))) : data,
      );
      files.push({ name, size: data.length, type: mimeOf(name) });
    };
    for (const f of extraFiles) add(f.name, f.data);
    if (output?.svg) add('drawing.svg', Buffer.from(output.svg));
    for (const f of output?.files ?? []) add(f.name, Buffer.from(f.content));

    const status: ResultStatus =
      t.status === 'done' ? 'done' : t.status === 'cancelled' ? 'cancelled' : 'failed';
    const rec: ResultRecord = {
      task_id: t.id,
      title: t.title,
      details: t.details,
      agent: t.agent,
      created_at: t.createdAt,
      finished_at: t.finishedAt ?? today(),
      status,
      output_type: status === 'done' ? (output?.type ?? 'text') : 'text',
      output: redact(
        cfg,
        (status === 'done' ? (output?.text ?? t.summary ?? '') : (t.error ?? 'Failed.')).slice(
          0,
          LIMITS.outputChars,
        ),
      ),
      ...(output?.language && { language: output.language }),
      ...(t.summary && { summary: redact(cfg, t.summary) }),
      ...(t.error && { error: redact(cfg, t.error) }),
      files,
      tokens_in: t.tokensIn,
      tokens_out: t.tokensOut,
      cost_usd: Number(t.costUsd.toFixed(6)),
      model: t.model ?? cfg.model,
      mock: t.mock,
    };
    this.write(`${t.id}.json`, JSON.stringify(rec, null, 1));
    const old = this.index.results.find((r) => r.id === t.id);
    this.index.results = this.index.results.filter((r) => r.id !== t.id);
    this.index.results.push({
      id: t.id,
      title: rec.title,
      agent: rec.agent,
      time: rec.finished_at,
      status,
      type: rec.output_type,
      cost: rec.cost_usd,
      pinned: old?.pinned ?? false,
      read: false,
    });
    this.prune();
    this.saveIndex();
    return rec;
  }

  /**
   * Keeps the newest `keep` unpinned results; pinned ones are never deleted automatically. xAI and Grok Desktop
   * results are counted separately, so Desktop ids (a higher range) never push xAI results out.
   */
  private prune() {
    for (const desktop of [false, true]) {
      const unpinned = this.index.results
        .filter((r) => !r.pinned && isDesktopId(r.id) === desktop)
        .sort((a, b) => b.id - a.id);
      for (const r of unpinned.slice(this.index.keep)) this.drop(r.id);
    }
  }

  /** The saved Desktop result for a message, if any (duplicate check). */
  findDesktop(messageKey: string): number | undefined {
    return this.index.results.find(
      (r) => r.src === 'grok-desktop' && this.get(r.id)?.source?.messageKey === messageKey,
    )?.id;
  }

  /**
   * Saves one real Grok Bot Desktop reply the user explicitly chose. Pinned by default. Returns the existing id
   * instead of saving twice. The record is written before the index, both atomically.
   */
  saveDesktop(input: {
    title: string;
    agent: string;
    outputType: 'text' | 'markdown';
    output: string;
    source: DesktopSource;
  }): { id: number; duplicate: boolean } {
    const existing = this.findDesktop(input.source.messageKey);
    if (existing !== undefined) return { id: existing, duplicate: true };
    let id = Math.max(DESKTOP_ID_BASE, ...this.index.results.map((r) => r.id).filter(isDesktopId)) + 1;
    while (this.index.results.some((r) => r.id === id) || this.read(`${id}.json`)) id++;
    const rec: ResultRecord = {
      task_id: id,
      title: input.title,
      details: `Saved from Grok Bot Desktop: ${input.source.agentName}, message ${input.source.entryId}.`,
      agent: input.agent,
      created_at: input.source.timestamp,
      finished_at: input.source.timestamp,
      status: 'done',
      output_type: input.outputType,
      output: input.output.slice(0, LIMITS.outputChars),
      files: [],
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
      model: 'Grok Desktop',
      mock: false,
      source: input.source,
    };
    this.write(`${id}.json`, JSON.stringify(rec, null, 1));
    this.index.results.push({
      id,
      title: rec.title,
      agent: rec.agent,
      time: rec.finished_at,
      status: 'done',
      type: rec.output_type,
      cost: 0,
      pinned: true,
      read: false,
      src: 'grok-desktop',
    });
    this.prune();
    this.saveIndex();
    return { id, duplicate: false };
  }
  private drop(id: number) {
    this.index.results = this.index.results.filter((r) => r.id !== id);
    this.remove(`${id}.json`);
    this.remove(`files/${id}`);
  }
  delete(id: number) {
    if (!this.index.results.some((r) => r.id === id)) return false;
    this.drop(id);
    this.saveIndex();
    return true;
  }
  patch(id: number, p: Partial<Pick<ResultEntry, 'pinned' | 'read'>>) {
    const r = this.index.results.find((x) => x.id === id);
    if (!r) return undefined;
    Object.assign(r, p);
    this.saveIndex();
    return r;
  }
  setKeep(keep: number) {
    this.index.keep = keep;
    this.prune();
    this.saveIndex();
    return this.index.keep;
  }

  // ---- export ----
  exportMarkdown() {
    const parts = this.list().results.map((e) => {
      const r = this.get(e.id);
      if (!r) return '';
      const body =
        r.output_type === 'code' ? `\`\`\`${r.language ?? ''}\n${r.output}\n\`\`\`` : r.output;
      return (
        `## #${r.task_id} ${r.title}\n\n` +
        `- Agent: ${r.agent}\n- Status: ${r.status}\n- Finished: ${r.finished_at}\n` +
        `- Tokens: ${r.tokens_in}/${r.tokens_out} · Cost: $${r.cost_usd} · Model: ${r.model}${r.mock ? ' (MOCK_MODE)' : ''}\n` +
        (r.files.length ? `- Files: ${r.files.map((f) => f.name).join(', ')}\n` : '') +
        `\n${body}\n`
      );
    });
    return `# Pixel Office results\n\nExported ${today()}\n\n${parts.join('\n---\n\n')}`;
  }
  exportZip() {
    const entries: { name: string; data: Buffer }[] = [
      { name: 'results.md', data: Buffer.from(this.exportMarkdown()) },
      { name: 'index.json', data: Buffer.from(JSON.stringify(this.list(), null, 1)) },
    ];
    for (const e of this.list().results) {
      const r = this.get(e.id);
      if (!r) continue;
      entries.push({ name: `${r.task_id}.json`, data: Buffer.from(JSON.stringify(r, null, 1)) });
      for (const f of r.files) {
        const d = this.read(`files/${r.task_id}/${f.name}`);
        if (d) entries.push({ name: `files/${r.task_id}/${f.name}`, data: d });
      }
    }
    return zip(entries);
  }
}

// ---- minimal ZIP writer (stored, no compression): no dependency needed ----
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
export function zip(entries: { name: string; data: Buffer }[]) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, e.data);
    centrals.push(central, name);
    offset += 30 + name.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/**
 * Optional real image generation (docs.x.ai/docs/guides/image-generations):
 * POST /v1/images/generations, flat price per image. Only when IMAGE_API=true and not in MOCK_MODE.
 */
export async function generateImage(
  cfg: GrokConfig,
  prompt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ data: Buffer; name: string }> {
  const res = await fetchImpl(`${cfg.baseUrl}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.imageModel, prompt: prompt.slice(0, 4000) }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!res.ok)
    throw new Error(
      redact(
        cfg,
        `xAI image API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`,
      ),
    );
  const body = (await res.json()) as { data?: { url?: string; b64_json?: string }[] };
  const first = body.data?.[0];
  if (first?.b64_json) return { data: Buffer.from(first.b64_json, 'base64'), name: 'image.png' };
  if (!first?.url || !/^https:\/\//.test(first.url))
    throw new Error('xAI image API returned no image.');
  const img = await fetchImpl(first.url, { signal: AbortSignal.timeout(cfg.timeoutMs) });
  const buf = Buffer.from(await img.arrayBuffer());
  if (buf.length > LIMITS.imageBytes) throw new Error('Generated image is too large to save.');
  const type = img.headers.get('content-type') ?? '';
  return {
    data: buf,
    name: type.includes('jpeg') ? 'image.jpg' : type.includes('webp') ? 'image.webp' : 'image.png',
  };
}
