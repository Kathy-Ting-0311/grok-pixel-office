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

/**
 * Feeds live messages into the existing event stream through `broadcast` (SSE only, NOT stored: D4).
 * The existing frontend `ingest` turns them into conversation lines and speech bubbles.
 */
export function bridgeToOffice(
  live: GrokBotGatewayAdapter,
  broadcast: (e: BotEvent) => void,
  overrides: Map<string, string>,
) {
  const mapping = (): LiveMapping[] => mapAgents(live.status().agents, roster, overrides);
  const off = live.onMessages((ms) => {
    const to = new Map(mapping().flatMap((m) => (m.rosterId ? [[m.agentId, m.rosterId]] : [])));
    for (const m of ms) {
      const rosterId = m.senderId ? to.get(m.senderId) : undefined;
      if (rosterId && officeEligible(m)) broadcast(toOfficeEvent(m, rosterId));
    }
  });
  return { mapping, stop: off };
}
