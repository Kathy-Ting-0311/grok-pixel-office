import { existsSync } from 'node:fs';

// Load .env once (Node's built-in loader; no dependency). Values already in the
// environment win, so tests and shells can override anything.
if (existsSync('.env')) {
  const before = { ...process.env };
  process.loadEnvFile('.env');
  Object.assign(process.env, before);
}

const num = (v: string | undefined, d: number) =>
  v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d;

/** USD per 1M tokens [input, output] (docs.x.ai/docs/models, Nov 2026). Unknown models use the most expensive listed rate. */
const prices: Record<string, [number, number]> = {
  'grok-4.3': [1.25, 2.5],
  'grok-4.3-latest': [1.25, 2.5],
  'grok-4.20-0309-reasoning': [1.25, 2.5],
  'grok-4.20-0309-non-reasoning': [1.25, 2.5],
  'grok-4.5': [2, 6],
  'grok-4.6': [2, 6],
  'grok-4.7': [2, 6],
};
export const priceOf = (model: string): [number, number] => prices[model] ?? [2, 6];
export const costOf = (model: string, tokensIn: number, tokensOut: number) => {
  const [pi, po] = priceOf(model);
  return (tokensIn * pi + tokensOut * po) / 1e6;
};

export type GrokConfig = {
  /** Server-only. Never serialise this object to a client or a log. */
  apiKey?: string;
  baseUrl: string;
  model: string;
  maxTokensPerTask: number;
  dailyBudgetUsd: number;
  mockMode: boolean;
  concurrency: number;
  maxTurns: number;
  timeoutMs: number;
  officeToken?: string;
  /** Real image generation for image tasks (paid per image). Off unless IMAGE_API=true. */
  imageApi: boolean;
  imageModel: string;
  imagePriceUsd: number;
  /** Results kept on disk by default (pinned ones are never removed). */
  resultsKeep: number;
};

export function loadGrokConfig(env: NodeJS.ProcessEnv = process.env): GrokConfig {
  const apiKey = env.XAI_API_KEY?.trim() || undefined;
  return {
    apiKey,
    baseUrl: (env.XAI_BASE_URL?.trim() || 'https://api.x.ai/v1').replace(/\/+$/, ''),
    model: env.DEFAULT_MODEL?.trim() || 'grok-4.3',
    maxTokensPerTask: Math.max(500, num(env.MAX_TOKENS_PER_TASK, 20000)),
    dailyBudgetUsd: Math.max(0, num(env.DAILY_BUDGET_USD, 1)),
    // Mock unless explicitly turned off AND a key exists: a missing key can never trigger a paid call.
    mockMode: env.MOCK_MODE?.trim().toLowerCase() !== 'false' || !apiKey,
    concurrency: Math.min(6, Math.max(1, num(env.TASK_CONCURRENCY, 2))),
    maxTurns: Math.min(12, Math.max(1, num(env.MAX_TURNS, 6))),
    timeoutMs: Math.max(5000, num(env.XAI_TIMEOUT_MS, 120000)),
    officeToken: env.OFFICE_TOKEN?.trim() || undefined,
    imageApi: env.IMAGE_API?.trim().toLowerCase() === 'true',
    imageModel: env.IMAGE_MODEL?.trim() || 'grok-imagine-image-2.0',
    imagePriceUsd: Math.max(0, num(env.IMAGE_PRICE_USD, 0.04)),
    resultsKeep: Math.min(100000, Math.max(10, num(env.RESULTS_KEEP, 500))),
  };
}

/** Upper bound for one task: every allowed token billed at the output rate. */
export const estimateMaxCost = (cfg: GrokConfig) =>
  (cfg.maxTokensPerTask * priceOf(cfg.model)[1]) / 1e6;

/** Removes the key from any text that might reach a log, an event or the browser. */
export const redact = (cfg: GrokConfig, text: string) =>
  (cfg.apiKey ? text.split(cfg.apiKey).join('[redacted]') : text).replace(
    /xai-[A-Za-z0-9]{20,}/g,
    '[redacted]',
  );
