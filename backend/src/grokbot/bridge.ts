import type { LiveMapping, LiveMessage } from '../../../shared/liveControl';
import { roster } from '../../../shared/roster';
import type { BotEvent } from '../../../shared/types';
import type { GrokBotGatewayAdapter } from './adapter';
import { mapAgents } from './mapping';

/** Only these reach the office (conversation panels and speech bubbles). Everything else stays in the Live view. */
export function officeEligible(m: LiveMessage) {
  return (
    (m.attribution === 'verified' || m.attribution === 'thread-target') &&
    !m.placeholder &&
    !!m.senderId &&
    !!m.text.trim()
  );
}

/** A live message as an existing `message` event. No meetingId: no meeting, nobody moves (D5). */
export function toOfficeEvent(m: LiveMessage, rosterId: string): BotEvent {
  return {
    id: `grokbot-live:${m.key}`,
    botId: rosterId,
    timestamp: m.timestamp,
    type: 'message',
    source: 'real',
    payload: {
      text: m.text,
      kind: 'grokbot-live',
      threadId: m.threadId,
      isGroup: m.isGroup,
      agentId: m.senderId,
      attribution: m.attribution,
      basis: m.basis,
      raw: m.raw,
    },
  };
}

/** Live office events kept per thread so a reloaded page gets them back in its SSE snapshot. */
export const LIVE_BUFFER_PER_THREAD = 100;

/**
 * Feeds live messages into the existing event stream through `broadcast` (SSE only, NOT stored: D4).
 * The existing frontend `ingest` turns them into conversation lines and speech bubbles.
 * The last LIVE_BUFFER_PER_THREAD broadcast events per thread are also kept IN MEMORY ONLY (cleared on
 * restart, never written to any database) and returned by `snapshot()` for newly connected pages.
 */
export function bridgeToOffice(
  live: GrokBotGatewayAdapter,
  broadcast: (e: BotEvent) => void,
  overrides: Map<string, string>,
  perThread = LIVE_BUFFER_PER_THREAD,
) {
  const mapping = (): LiveMapping[] => mapAgents(live.status().agents, roster, overrides);
  const buffer = new Map<string, BotEvent[]>();
  const keep = (threadId: string, e: BotEvent) => {
    const list = buffer.get(threadId) ?? [];
    list.push(e);
    if (list.length > perThread) list.splice(0, list.length - perThread);
    buffer.set(threadId, list);
  };
  const off = live.onMessages((ms) => {
    const to = new Map(mapping().flatMap((m) => (m.rosterId ? [[m.agentId, m.rosterId]] : [])));
    for (const m of ms) {
      const rosterId = m.senderId ? to.get(m.senderId) : undefined;
      if (!rosterId || !officeEligible(m)) continue;
      const e = toOfficeEvent(m, rosterId);
      keep(m.threadId, e);
      broadcast(e);
    }
  });
  /** Stored events plus the buffered live ones, in time order (stable for equal timestamps). */
  const snapshot = (stored: BotEvent[]): BotEvent[] => {
    const extra = [...buffer.values()].flat();
    if (!extra.length) return stored;
    return [...stored, ...extra]
      .map((e, i) => ({ e, i, t: Date.parse(e.timestamp) || 0 }))
      .sort((a, b) => a.t - b.t || a.i - b.i)
      .map((x) => x.e);
  };
  return {
    mapping,
    snapshot,
    buffered: () => [...buffer.values()].reduce((n, l) => n + l.length, 0),
    stop: () => {
      off();
      buffer.clear();
    },
  };
}
