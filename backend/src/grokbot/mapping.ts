import type { LiveAgent, LiveMapping } from '../../../shared/liveControl';
import type { Bot } from '../../../shared/types';
import { UUID } from './cli';

/** GROKBOT_AGENT_MAP="<realAgentId>:<rosterId>,…" → Map. Malformed pairs are ignored. */
export function parseAgentMap(v?: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of (v ?? '').split(',')) {
    const [real, rosterId] = pair.split(':').map((x) => x?.trim());
    if (real && rosterId && UUID.test(real)) out.set(real, rosterId);
  }
  return out;
}

/** "Coz · Chief" → "Coz": the display name before the first " · ". */
export const baseName = (name: string) => name.split(' · ')[0].trim();

/**
 * Maps real Grok Bot agents onto the EXISTING office characters. Character definitions are never
 * changed: an agent either points at a roster id or is listed as unmapped. The owner is never mapped.
 * Default rule: exact base-name match; GROKBOT_AGENT_MAP overrides it. Ambiguous matches are refused.
 */
export function mapAgents(
  agents: LiveAgent[],
  roster: Bot[],
  overrides = new Map<string, string>(),
): LiveMapping[] {
  const rosterIds = new Set(roster.map((b) => b.id));
  const proposal = new Map<string, { rosterId: string; reason: string }>();
  const out = new Map<string, LiveMapping>();
  for (const a of agents) {
    if (a.owner) {
      out.set(a.id, { agentId: a.id, name: a.name, reason: 'owner (you): never a character' });
      continue;
    }
    const o = overrides.get(a.id);
    if (o) {
      if (rosterIds.has(o)) proposal.set(a.id, { rosterId: o, reason: 'GROKBOT_AGENT_MAP' });
      else
        out.set(a.id, {
          agentId: a.id,
          name: a.name,
          reason: `GROKBOT_AGENT_MAP names unknown character ${o}`,
        });
      continue;
    }
    const hit = roster.find((b) => b.name === baseName(a.name));
    if (hit) proposal.set(a.id, { rosterId: hit.id, reason: `name match "${hit.name}"` });
    else
      out.set(a.id, {
        agentId: a.id,
        name: a.name,
        reason: `no office character named "${baseName(a.name)}"`,
      });
  }
  // One character per real agent: if two agents claim the same character, neither is mapped.
  const claims = new Map<string, string[]>();
  for (const [id, p] of proposal) claims.set(p.rosterId, [...(claims.get(p.rosterId) ?? []), id]);
  for (const [id, p] of proposal) {
    const a = agents.find((x) => x.id === id)!;
    const n = claims.get(p.rosterId)!.length;
    out.set(
      id,
      n === 1
        ? { agentId: id, name: a.name, rosterId: p.rosterId, reason: p.reason }
        : { agentId: id, name: a.name, reason: `ambiguous: ${n} agents match ${p.rosterId}` },
    );
  }
  return agents.map((a) => out.get(a.id)!);
}
