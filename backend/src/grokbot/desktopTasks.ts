import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Grok Bot Desktop tasks the user tracks by hand ("Track as Task" on one of their own messages). Kept apart
 * from the xAI task queue. Only what the user chose is stored: the request's message key, a short title and
 * the explicit links to saved results. Completion is only ever set by the user ("Mark as Completed").
 * File: data/grok-desktop/tasks.json (git-ignored with data/), written atomically; ':memory:' for tests.
 */
export type DesktopTask = {
  id: string;
  agentId: string;
  agentName: string;
  /** The user's request message (`${threadId}:${entryId}`). */
  requestKey: string;
  title: string;
  requestedAt: string;
  createdAt: string;
  /** Saved Grok Desktop result ids the user linked to this task ("Result available"). */
  resultIds: number[];
  /** Set only by the user. */
  completedAt?: string;
};

export class DesktopTaskStore {
  private tasks: DesktopTask[] = [];

  constructor(private readonly file: string) {
    if (file === ':memory:') return;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as { tasks?: DesktopTask[] };
      this.tasks = Array.isArray(data.tasks) ? data.tasks : [];
    } catch {
      this.tasks = [];
    }
  }

  private save() {
    if (this.file === ':memory:') return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ tasks: this.tasks }, null, 1));
    renameSync(`${this.file}.tmp`, this.file);
  }

  list(agentId?: string) {
    return this.tasks.filter((t) => !agentId || t.agentId === agentId).map((t) => ({ ...t }));
  }

  /** Tracks a request once; tracking the same message again returns the existing task. */
  track(t: Omit<DesktopTask, 'id' | 'createdAt' | 'resultIds'>): {
    task: DesktopTask;
    duplicate: boolean;
  } {
    const existing = this.tasks.find((x) => x.requestKey === t.requestKey);
    if (existing) return { task: { ...existing }, duplicate: true };
    const task: DesktopTask = {
      ...t,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      resultIds: [],
    };
    this.tasks.push(task);
    this.save();
    return { task: { ...task }, duplicate: false };
  }

  update(id: string, p: { completed?: boolean; resultIds?: number[] }): DesktopTask | undefined {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return undefined;
    if (p.completed === true) t.completedAt ??= new Date().toISOString();
    if (p.completed === false) delete t.completedAt;
    if (p.resultIds) t.resultIds = [...new Set(p.resultIds)];
    this.save();
    return { ...t };
  }

  /** Drops links to results that no longer exist (e.g. deleted in Results). */
  forgetResults(exists: (id: number) => boolean) {
    let changed = false;
    for (const t of this.tasks) {
      const kept = t.resultIds.filter(exists);
      if (kept.length === t.resultIds.length) continue;
      t.resultIds = kept;
      changed = true;
    }
    if (changed) this.save();
  }

  remove(id: string) {
    const n = this.tasks.length;
    this.tasks = this.tasks.filter((x) => x.id !== id);
    if (this.tasks.length === n) return false;
    this.save();
    return true;
  }
}
