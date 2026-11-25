// Loads .env once (side effect of the existing config module), so this file follows the same rules.
import '../config';

/**
 * Grok Bot Live Control settings. Everything is off unless ENABLE_GROKBOT_LIVE_CONTROL is exactly "true".
 * Server-only: never serialise this object to a client.
 */
export type LiveControlConfig = {
  enabled: boolean;
  /** Absolute path to the patched CLI entry (dist/bin/gbot.mjs). Empty = not configured. */
  cliPath: string;
  /** The CLI repo must be at this commit (short or full hash prefix). */
  expectedCommit: string;
  gitPath: string;
  /** The owner's own agent ("me"); never mapped to a character. */
  ownerAgentId?: string;
  /** GROKBOT_AGENT_MAP override: "<realAgentId>:<rosterId>,…". */
  agentMap: string;
  /** Poll interval for the thread open in the UI. */
  pollActiveMs: number;
  /** Gap between round-robin polls of the other threads (one thread per gap). */
  pollIdleMs: number;
  discoveryMs: number;
  timeoutMs: number;
  maxFailures: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Entries read the first time a thread is synced (1–200). */
  initialLimit: number;
  /**
   * Phase 4 (D7): every server start begins paused; the UI toggle resumes in memory only.
   * `GROKBOT_START_PAUSED=false` exists for automated tests and is not documented for users.
   */
  startPaused: boolean;
  /**
   * GROKBOT_LIVE_SEND_ENABLED, default false. While false the server refuses every send request
   * before the CLI is called (Phase 3 is blocked: the gateway rejects this CLI's send route, 409).
   */
  sendEnabled: boolean;
};

const num = (v: string | undefined, d: number) =>
  v !== undefined && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.trunc(v)));

export function loadLiveControlConfig(env: NodeJS.ProcessEnv = process.env): LiveControlConfig {
  return {
    enabled: env.ENABLE_GROKBOT_LIVE_CONTROL?.trim().toLowerCase() === 'true',
    cliPath: env.GROKBOT_CLI_PATH?.trim() ?? '',
    expectedCommit: env.GROKBOT_CLI_COMMIT?.trim() || '9616503',
    gitPath: env.GROKBOT_GIT_PATH?.trim() || '/usr/bin/git',
    ownerAgentId: env.GROKBOT_OWNER_AGENT_ID?.trim() || undefined,
    agentMap: env.GROKBOT_AGENT_MAP?.trim() ?? '',
    pollActiveMs: clamp(num(env.GROKBOT_POLL_ACTIVE_MS, 10000), 3000, 600000),
    pollIdleMs: clamp(num(env.GROKBOT_POLL_IDLE_MS, 15000), 5000, 600000),
    discoveryMs: clamp(num(env.GROKBOT_DISCOVERY_MS, 300000), 30000, 3600000),
    timeoutMs: clamp(num(env.GROKBOT_CLI_TIMEOUT_MS, 15000), 2000, 120000),
    maxFailures: clamp(num(env.GROKBOT_MAX_FAILURES, 3), 1, 20),
    backoffBaseMs: 2000,
    backoffMaxMs: 120000,
    initialLimit: clamp(num(env.GROKBOT_INITIAL_LIMIT, 20), 1, 200),
    startPaused: env.GROKBOT_START_PAUSED?.trim().toLowerCase() !== 'false',
    sendEnabled: env.GROKBOT_LIVE_SEND_ENABLED?.trim().toLowerCase() === 'true',
  };
}
