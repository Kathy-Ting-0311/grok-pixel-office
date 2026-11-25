// Grok Bot Live Control types shared by the backend adapter and the frontend.

/**
 * How the sender of a live message is known (PLAN.md §0, as confirmed at the Phase 1 gate).
 * - verified: the entry carries author.id (not the owner).
 * - thread-target: 1:1 thread AND kind "send-message" AND no author AND role is not "user".
 * - owner: the owner ("me"): author.id = owner id, role "user", or the owner's own thread.
 * - unknown: anything else. Shown only in the Live Control view, never as a speech bubble.
 */
export type LiveAttribution = 'verified' | 'thread-target' | 'owner' | 'unknown';

/** The entry fields the attribution was derived from, kept for debugging. */
export type LiveRaw = {
  kind: string;
  role?: string;
  authorId?: string;
  authorName?: string;
  /** message.type, e.g. "text", "user-form", "widget". */
  messageType?: string;
};

export type LiveMessage = {
  /** `${threadId}:${entryId}` — the dedupe key. */
  key: string;
  threadId: string;
  isGroup: boolean;
  entryId: string;
  seq?: number;
  timestamp: string;
  /** Message text, or the placeholder label (e.g. "[form: Daily report]") for non-text entries. */
  text: string;
  /** Set for non-text entries (forms, widgets, attachments…). Their contents are never read. */
  placeholder?: { type: string };
  /** Real Grok Bot agent id of the sender, when attributed. */
  senderId?: string;
  attribution: LiveAttribution;
  /** The rule that decided the attribution, e.g. "author.id" or "1:1 send-message, no author". */
  basis: string;
  raw: LiveRaw;
};

/** Shown while GROKBOT_LIVE_SEND_ENABLED is off. */
export const SEND_BLOCKED_REASON =
  "Sending unavailable: Grok Bot Desktop rejects this CLI's send route for server-run bots (409).";

/** What a send request returns. `delivery` is the CLI's own word; nothing is ever retried. */
export type LiveSendResult = {
  ok: boolean;
  delivery: 'accepted' | 'rejected' | 'queued' | 'unknown' | 'refused';
  error?: string;
};

export type LiveState =
  'starting' | 'ok' | 'degraded' | 'paused' | 'off-error' | 'unavailable' | 'stopped';

export type LiveAgent = { id: string; name: string; owner: boolean };
export type LiveGroup = { id: string; name: string; memberIds: string[] };

export type LiveThreadStatus = {
  id: string;
  name: string;
  isGroup: boolean;
  lastPolledAt?: string;
  cursor?: string;
  messages: number;
  gapResets: number;
};

/** Real agent → existing office character. Unmapped agents are listed, never drawn. */
export type LiveMapping = {
  agentId: string;
  name: string;
  rosterId?: string;
  reason: string;
};

export type LiveStatus = {
  enabled: true;
  state: LiveState;
  reason?: string;
  paused: boolean;
  cli?: { version: string; commit: string };
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  consecutiveFailures: number;
  nextRunAt?: string;
  activeThreadId?: string;
  agents: LiveAgent[];
  groups: LiveGroup[];
  threads: LiveThreadStatus[];
  mapping?: LiveMapping[];
  /** Sending is a separate switch (GROKBOT_LIVE_SEND_ENABLED, default off). */
  send: { enabled: boolean; reason?: string };
  counters: {
    calls: number;
    failures: number;
    timeouts: number;
    duplicates: number;
    /** Entries that failed the schema (malformed); never shown. */
    malformed: number;
    unknown: number;
    /** Non-text entries by message type, shown as placeholders. */
    placeholders: Record<string, number>;
  };
};
