import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { botById, roster } from '../../shared/roster';
import type { BotEvent, BotEventType } from '../../shared/types';
import { estimateMaxCost, type GrokConfig } from './config';
import { runAgent as defaultRunAgent, type AgentOutput, type AgentResult } from './grok';

export type Priority = 'low' | 'normal' | 'high';
export type QueueStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type PlacedTask = {
  id: number;
  title: string;
  details: string;
  /** Bot id that runs it. */
  agent: string;
  requestedAgent: string;
  priority: Priority;
  maxCostUsd: number;
  status: QueueStatus;
  /** Increments on retry; the office event stream sees each attempt as its own task. */
  attempt: number;
  mock: boolean;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  model?: string;
};
export type NewTask = {
  title: string;
  details?: string;
  agent: string;
  priority: Priority;
  max_cost_usd?: number;
};
type Saved = { nextId: number; tasks: PlacedTask[]; budget: { date: string; spentUsd: number } };

const rank: Record<Priority, number> = { high: 0, normal: 1, low: 2 };
const today = () => new Date().toISOString().slice(0, 10);

export class TaskQueue {
  private data: Saved;
  private running = new Map<number, AbortController>();
  private seq = 0;
  private timer?: NodeJS.Timeout;

  constructor(
    readonly cfg: GrokConfig,
    private readonly publish: (e: BotEvent) => void,
    private readonly file: string,
    private readonly hooks: {
      hold?: (botId: string, on: boolean) => void;
      runAgent?: typeof defaultRunAgent;
      /** Async post-processing of a successful output (e.g. image generation); may charge the budget. */
      prepareOutput?: (
        t: PlacedTask,
        o: AgentOutput,
      ) => Promise<{
        output: AgentOutput;
        files: { name: string; data: Buffer }[];
        /** Extra spend (e.g. a generated image), already charged to the daily budget. */
        costUsd?: number;
      }>;
      /** Saves the result record; runs before task_completed/task_failed is published. */
      onFinish?: (
        t: PlacedTask,
        output?: AgentOutput,
        files?: { name: string; data: Buffer }[],
      ) => { output_type: string } | void;
    } = {},
  ) {
    this.data = this.load();
    // Tasks that were mid-run when the server stopped are not re-run automatically (that could spend twice).
    for (const t of this.data.tasks)
      if (t.status === 'running')
        Object.assign(t, {
          status: 'failed',
          error: 'Interrupted by a server restart. Use Retry to run it again.',
          finishedAt: new Date().toISOString(),
        });
    this.save();
  }

  private load(): Saved {
    try {
      const d = JSON.parse(readFileSync(this.file, 'utf8')) as Saved;
      if (Array.isArray(d.tasks) && typeof d.nextId === 'number')
        return { ...d, budget: d.budget ?? { date: today(), spentUsd: 0 } };
    } catch {
      /* first run */
    }
    return { nextId: 1, tasks: [], budget: { date: today(), spentUsd: 0 } };
  }
  private save() {
    if (this.file === ':memory:') return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 1));
    renameSync(`${this.file}.tmp`, this.file);
  }

  budget() {
    if (this.data.budget.date !== today()) this.data.budget = { date: today(), spentUsd: 0 };
    const { spentUsd } = this.data.budget;
    return {
      date: this.data.budget.date,
      spentUsd,
      dailyBudgetUsd: this.cfg.dailyBudgetUsd,
      remainingUsd: Math.max(0, this.cfg.dailyBudgetUsd - spentUsd),
      exhausted: !this.cfg.mockMode && spentUsd >= this.cfg.dailyBudgetUsd,
    };
  }
  /** Safe to send to the browser: no key, only flags and limits. */
  /** Adds spend that did not come from a placed task (e.g. chat replies) to today's budget. */
  charge(usd: number) {
    if (usd <= 0) return;
    this.budget();
    this.data.budget.spentUsd += usd;
    this.save();
  }
  info() {
    return {
      mock: this.cfg.mockMode,
      model: this.cfg.model,
      maxTokensPerTask: this.cfg.maxTokensPerTask,
      estimateMaxCostUsd: Number(estimateMaxCost(this.cfg).toFixed(4)),
      concurrency: this.cfg.concurrency,
      agents: roster.map((b) => ({ id: b.id, name: b.name, role: b.role })),
      tokenRequired: !!this.cfg.officeToken,
    };
  }
  list() {
    return [...this.data.tasks].sort((a, b) => b.id - a.id);
  }
  get(id: number) {
    return this.data.tasks.find((t) => t.id === id);
  }

  /** "auto": an idle agent (nothing running or queued), else the one with the shortest queue. */
  pickAgent() {
    const load = (id: string) =>
      this.data.tasks.filter(
        (t) => t.agent === id && (t.status === 'queued' || t.status === 'running'),
      ).length;
    return [...roster].sort(
      (a, b) => load(a.id) - load(b.id) || Number(!!a.isChief) - Number(!!b.isChief),
    )[0].id;
  }

  create(input: NewTask): PlacedTask | { error: string } {
    if (this.budget().exhausted)
      return {
        error:
          'The daily budget is used up. New tasks can run again tomorrow, or raise DAILY_BUDGET_USD in .env.',
      };
    const agent = input.agent === 'auto' ? this.pickAgent() : input.agent;
    const t: PlacedTask = {
      id: this.data.nextId++,
      title: input.title.trim(),
      details: (input.details ?? '').trim(),
      agent,
      requestedAgent: input.agent,
      priority: input.priority,
      maxCostUsd: input.max_cost_usd ?? Number(estimateMaxCost(this.cfg).toFixed(4)),
      status: 'queued',
      attempt: 1,
      mock: this.cfg.mockMode,
      createdAt: new Date().toISOString(),
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    };
    this.data.tasks.push(t);
    this.save();
    this.emit(t, 'task_created', { title: t.title, status: 'queued', priority: t.priority });
    this.schedule();
    return t;
  }

  cancel(id: number) {
    const t = this.get(id);
    if (!t || (t.status !== 'queued' && t.status !== 'running'))
      return { error: 'Only queued or running tasks can be cancelled.' };
    if (t.status === 'running') this.running.get(id)?.abort(new Error('cancelled'));
    else this.finish(t, 'cancelled', { error: 'Cancelled before it started.' });
    return t;
  }

  retry(id: number) {
    const t = this.get(id);
    if (!t || (t.status !== 'failed' && t.status !== 'cancelled'))
      return { error: 'Only failed or cancelled tasks can be retried.' };
    if (this.budget().exhausted) return { error: 'The daily budget is used up.' };
    Object.assign(t, {
      status: 'queued',
      attempt: t.attempt + 1,
      mock: this.cfg.mockMode,
      error: undefined,
      summary: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    });
    this.save();
    this.emit(t, 'task_created', {
      title: t.title,
      status: 'queued',
      priority: t.priority,
      retry: t.attempt,
    });
    this.schedule();
    return t;
  }

  private emit(t: PlacedTask, type: BotEventType, payload: Record<string, unknown>) {
    this.publish({
      id: `placed-${t.id}.${t.attempt}-${Date.now().toString(36)}-${(this.seq++).toString(36)}`,
      botId: t.agent,
      taskId: `placed-${t.id}.${t.attempt}`,
      timestamp: new Date().toISOString(),
      type,
      // Live Grok output is real work; MOCK_MODE output is labelled simulated.
      source: t.mock ? 'simulated' : 'real',
      payload: { ...payload, placedTaskId: t.id, title: t.title },
    });
  }

  private finish(
    t: PlacedTask,
    status: 'done' | 'failed' | 'cancelled',
    extra: Partial<PlacedTask>,
    payload: Record<string, unknown> = {},
    output?: AgentOutput,
    files?: { name: string; data: Buffer }[],
  ) {
    Object.assign(t, extra, { status, finishedAt: new Date().toISOString() });
    this.save();
    try {
      const rec = this.hooks.onFinish?.(t, output, files);
      if (rec) payload = { ...payload, result_id: t.id, output_type: rec.output_type };
    } catch (err) {
      console.error('Could not save the result record:', err instanceof Error ? err.message : err);
    }
    if (status === 'done') this.emit(t, 'task_completed', { summary: t.summary, ...payload });
    else
      this.emit(t, 'task_failed', {
        status,
        reason: payload.reason ?? status,
        error: t.error,
        ...payload,
      });
    if (status === 'done' && t.summary)
      this.emit(t, 'message', { text: t.summary, kind: 'result' });
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.pump(), 0);
  }

  /** Starts queued tasks: highest priority first, oldest first, at most cfg.concurrency at once, one per agent. */
  pump() {
    const busy = new Set(this.data.tasks.filter((t) => t.status === 'running').map((t) => t.agent));
    const queued = this.data.tasks
      .filter((t) => t.status === 'queued')
      .sort((a, b) => rank[a.priority] - rank[b.priority] || a.id - b.id);
    for (const t of queued) {
      if (this.running.size >= this.cfg.concurrency) break;
      if (busy.has(t.agent)) continue;
      if (this.budget().exhausted) {
        this.finish(
          t,
          'failed',
          { error: 'Not started: the daily budget is used up.' },
          { reason: 'budget_exhausted' },
        );
        continue;
      }
      busy.add(t.agent);
      void this.run(t);
    }
  }

  private async run(t: PlacedTask) {
    const bot = botById(t.agent)!;
    const ctl = new AbortController();
    this.running.set(t.id, ctl);
    Object.assign(t, {
      status: 'running',
      startedAt: new Date().toISOString(),
      model: this.cfg.model,
    });
    this.save();
    this.hooks.hold?.(t.agent, true);
    this.emit(t, 'task_started', { status: 'running', model: this.cfg.model, mock: t.mock });
    let charged = 0;
    let result: AgentResult;
    try {
      result = await (this.hooks.runAgent ?? defaultRunAgent)(
        { id: t.id, title: t.title, details: t.details },
        bot,
        {
          cfg: this.cfg,
          signal: ctl.signal,
          emit: (type, payload) => this.emit(t, type, payload),
          onUsage: (u) => {
            // Charge the daily budget as tokens are used, then enforce this task's own cap.
            this.data.budget.spentUsd += u.costUsd - charged;
            charged = u.costUsd;
            Object.assign(t, { tokensIn: u.tokensIn, tokensOut: u.tokensOut, costUsd: u.costUsd });
            this.save();
            return u.costUsd <= t.maxCostUsd;
          },
        },
      );
    } catch (err) {
      result = {
        ok: false,
        reason: 'api_error',
        error: err instanceof Error ? err.message : String(err),
        tokensIn: t.tokensIn,
        tokensOut: t.tokensOut,
        costUsd: t.costUsd,
        model: this.cfg.model,
      };
    }
    let output = result.ok ? result.output : undefined;
    let files: { name: string; data: Buffer }[] = [];
    let extraCost = 0;
    if (result.ok && output && this.hooks.prepareOutput && !ctl.signal.aborted) {
      try {
        const prepared = await this.hooks.prepareOutput(t, output);
        ({ output, files } = prepared);
        extraCost = prepared.costUsd ?? 0;
      } catch (err) {
        output = {
          ...output,
          text: `${output.text}\n\n(Image generation failed: ${err instanceof Error ? err.message : err})`,
        };
      }
    }
    this.running.delete(t.id);
    this.hooks.hold?.(t.agent, false);
    const usage = {
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUsd: result.costUsd + extraCost,
    };
    const usagePayload = {
      tokens_in: result.tokensIn,
      tokens_out: result.tokensOut,
      model: result.model,
      cost_usd: Number((result.costUsd + extraCost).toFixed(6)),
    };
    if (result.ok)
      this.finish(t, 'done', { ...usage, summary: result.summary }, usagePayload, output, files);
    else if (result.reason === 'cancelled')
      this.finish(t, 'cancelled', { ...usage, error: 'Cancelled while running.' }, usagePayload);
    else
      this.finish(
        t,
        'failed',
        { ...usage, error: result.error },
        {
          ...usagePayload,
          reason: result.reason === 'max_cost' ? 'max_cost_exceeded' : result.reason,
        },
      );
    this.schedule();
  }

  stop() {
    clearTimeout(this.timer);
    for (const c of this.running.values()) c.abort(new Error('server stopping'));
  }
}
