import type { LiveAttribution, LiveMessage, LiveRaw } from '../../../shared/liveControl';
import { scrub } from './cli';
import { entrySchema, type Entry } from './schemas';

/** Text of an entry, mirroring the CLI's own `entryText` (src/core/transcript.js). */
export function entryText(e: Entry): string {
  for (const v of [e.text, e.content]) {
    if (typeof v === 'string' && v) return v;
    if (Array.isArray(v))
      return v
        .map((p) =>
          typeof p === 'string'
            ? p
            : p && typeof p === 'object'
              ? String((p as { text?: unknown }).text ?? (p as { content?: unknown }).content ?? '')
              : '',
        )
        .filter(Boolean)
        .join('\n');
  }
  if (typeof e.message === 'string') return e.message;
  const m = e.message as { content?: unknown } | undefined;
  if (m && typeof m === 'object' && typeof m.content === 'string') return m.content;
  return '';
}

const messageType = (e: Entry) => {
  const t = (e.message as { type?: unknown } | undefined)?.type;
  return typeof e.message === 'object' && e.message && typeof t === 'string' ? t : undefined;
};

/**
 * Placeholder label for a non-text entry, or undefined for a text message. Only a form's title is
 * read (formRequest.title); fields, values, prompts, URLs and options are never touched.
 */
export function placeholderLabel(e: Entry, text: string): string | undefined {
  const type = messageType(e);
  if ((type === undefined || type === 'text') && text.trim()) return undefined;
  if (type === 'user-form') {
    const title = (e.message as { formRequest?: { title?: unknown } }).formRequest?.title;
    const clean =
      typeof title === 'string' ? scrub(title.replace(/\s+/g, ' ').trim(), 60) : undefined;
    return clean ? `[form: ${clean}]` : '[form]';
  }
  if (type === 'widget') return '[widget]';
  if (type === 'text' || (type === undefined && e.kind === 'send-message'))
    return '[empty message]';
  return `[${type ?? e.kind}]`;
}

export type AttributionContext = { threadId: string; isGroup: boolean; ownerId?: string };

/** Sender attribution exactly as confirmed at the Phase 1 gate. Never guesses from text or names. */
export function attribute(
  e: Entry,
  ctx: AttributionContext,
): { attribution: LiveAttribution; senderId?: string; basis: string } {
  const isOwner = (id: string) => !!ctx.ownerId && id === ctx.ownerId;
  if (e.author?.id) {
    if (isOwner(e.author.id))
      return { attribution: 'owner', senderId: e.author.id, basis: 'author.id = owner' };
    return { attribution: 'verified', senderId: e.author.id, basis: 'author.id' };
  }
  if (e.role === 'user') return { attribution: 'owner', basis: 'role:user' };
  // thread-target needs ALL of: 1:1 thread, kind "send-message", no author, role not "user".
  if (!ctx.isGroup && e.kind === 'send-message') {
    if (isOwner(ctx.threadId))
      return { attribution: 'owner', senderId: ctx.threadId, basis: "owner's own thread" };
    return {
      attribution: 'thread-target',
      senderId: ctx.threadId,
      basis: '1:1 send-message, no author',
    };
  }
  return {
    attribution: 'unknown',
    basis: ctx.isGroup
      ? 'group entry without author.id'
      : `no rule matches (kind=${e.kind}, role=${e.role ?? 'none'})`,
  };
}

const rawOf = (e: Entry): LiveRaw => ({
  kind: e.kind,
  ...(e.role !== undefined ? { role: e.role } : {}),
  ...(e.author?.id ? { authorId: e.author.id } : {}),
  ...(e.author?.name ? { authorName: e.author.name } : {}),
  ...(messageType(e) ? { messageType: messageType(e) } : {}),
});

/** Converts one parsed entry (with a known id) to a LiveMessage. */
export function toLiveMessage(
  e: Entry,
  entryId: string,
  ctx: AttributionContext,
  now = Date.now(),
): LiveMessage {
  const text = entryText(e);
  const label = placeholderLabel(e, text);
  const a = attribute(e, ctx);
  return {
    key: `${ctx.threadId}:${entryId}`,
    threadId: ctx.threadId,
    isGroup: ctx.isGroup,
    entryId,
    seq: e.seq,
    timestamp: new Date(e.timestampMs ?? now).toISOString(),
    text: label ?? text,
    ...(label ? { placeholder: { type: messageType(e) ?? e.kind } } : {}),
    senderId: a.senderId,
    attribution: a.attribution,
    basis: a.basis,
    raw: rawOf(e),
    ...(typeof e.requestId === 'string' ? { requestId: e.requestId } : {}),
    ...attachmentOf(e),
  };
}

/** Name and type of an attachment entry; the URL and source path are deliberately dropped. */
function attachmentOf(e: Entry): { attachment?: { name: string; type: string } } {
  if (messageType(e) !== 'attachment') return {};
  const m = e.message as { file_name?: unknown; url?: unknown };
  const raw = typeof m.file_name === 'string' ? m.file_name : typeof m.url === 'string' ? m.url : '';
  const name = scrub(raw.split(/[\\/]/).pop() ?? '', 120) || 'attachment';
  return { attachment: { name, type: fileKind(name) } };
}

const kinds: [RegExp, string][] = [
  [/\.(png|jpe?g|gif|webp|svg|heic)$/i, 'image'],
  [/\.(mp4|mov|webm|m4v)$/i, 'video'],
  [/\.(mp3|wav|m4a|aac|ogg)$/i, 'audio'],
  [/\.(pdf|docx?|pptx?|xlsx?|md|txt|csv|rtf)$/i, 'document'],
  [/\.(zip|tar|gz|tgz|7z|rar)$/i, 'archive'],
];
/** A coarse kind from the file name (no content is read). */
export const fileKind = (name: string) => kinds.find(([re]) => re.test(name))?.[1] ?? 'file';

/** Per-thread incremental state: cursor for `--after`, bounded dedupe set, message buffer. */
export class ThreadSync {
  cursor?: string;
  lastPolledAt?: string;
  gapResets = 0;
  readonly messages: LiveMessage[] = [];
  private seen = new Set<string>();
  private order: string[] = [];

  constructor(
    readonly id: string,
    public name: string,
    public isGroup: boolean,
    private readonly keep = 200,
    private readonly seenCap = 4000,
  ) {}

  /**
   * Applies one `thread` result. Returns the new messages (never ones seen before).
   * A streaming entry stops processing so it is read again, complete, next time.
   * Nothing is dropped silently: non-text entries become placeholders, malformed ones are counted.
   */
  apply(
    rawEntries: unknown[],
    ctx: { ownerId?: string },
    meta: { cursor?: string; gapReset?: boolean },
  ): { fresh: LiveMessage[]; duplicates: number; malformed: number } {
    if (meta.gapReset) this.gapResets++;
    const fresh: LiveMessage[] = [];
    let duplicates = 0;
    let malformed = 0;
    let lastId: string | undefined;
    let stoppedEarly = false;
    for (const raw of rawEntries) {
      const p = entrySchema.safeParse(raw);
      if (!p.success) {
        malformed++;
        continue;
      }
      const e = p.data;
      if (e.isStreaming === true) {
        stoppedEarly = true;
        break;
      }
      const entryId = e.id ?? (e.seq !== undefined ? `seq${e.seq}` : undefined);
      if (!entryId) {
        malformed++;
        continue;
      }
      if (e.id) lastId = e.id;
      const key = `${this.id}:${entryId}`;
      if (this.seen.has(key)) {
        duplicates++;
        continue;
      }
      this.remember(key);
      fresh.push(
        toLiveMessage(e, entryId, {
          threadId: this.id,
          isGroup: this.isGroup,
          ownerId: ctx.ownerId,
        }),
      );
    }
    // Advance only past fully processed entries; the CLI's own cursor is used when nothing was cut.
    const next = stoppedEarly ? lastId : (meta.cursor ?? lastId);
    if (next) this.cursor = next;
    this.lastPolledAt = new Date().toISOString();
    this.messages.push(...fresh);
    if (this.messages.length > this.keep) this.messages.splice(0, this.messages.length - this.keep);
    return { fresh, duplicates, malformed };
  }

  private remember(key: string) {
    this.seen.add(key);
    this.order.push(key);
    if (this.order.length > this.seenCap) this.seen.delete(this.order.shift()!);
  }
}
