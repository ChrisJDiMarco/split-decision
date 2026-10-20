// Worker pool: N headless child processes (nice 10), one task each at a time. Window contexts are sent
// once per worker and cached there. Every PID goes into the run's pids file; workers are only ever
// stopped by their own PID (pool.close), never by pattern.
import { fork, type ChildProcess } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { loadavg, setPriority } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommitReply, EvalReply, FullReply, Reply, Task, WindowCtx } from './protocol';

const HERE = dirname(fileURLToPath(import.meta.url));

interface Slot {
  child: ChildProcess;
  busy: boolean;
  known: Set<string>;
  pending: Map<number, (r: Reply) => void>;
}

interface Job {
  task: Task;
  ctx?: WindowCtx;
  resolve: (r: Reply) => void;
}

export class Pool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private nextId = 1;
  cpuMs = 0;
  readonly cpuByKey = new Map<string, number>();

  constructor(readonly size: number, pidFile: string | null, readonly loadCap = 18) {
    for (let i = 0; i < size; i++) {
      const child = fork(join(HERE, 'worker.ts'), [], { execArgv: process.execArgv, serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      try {
        if (child.pid) setPriority(child.pid, 10);
      } catch {
        /* not permitted: keep default priority */
      }
      if (pidFile && child.pid) appendFileSync(pidFile, `${child.pid} worker\n`);
      const slot: Slot = { child, busy: false, known: new Set(), pending: new Map() };
      child.on('message', (m: { id: number; reply: Reply }) => {
        const cb = slot.pending.get(m.id);
        slot.pending.delete(m.id);
        slot.busy = false;
        cb?.(m.reply);
        this.pump();
      });
      child.on('exit', (code) => {
        for (const cb of slot.pending.values()) cb({ ok: false, error: `worker ${child.pid} exited (${code})` });
        slot.pending.clear();
      });
      this.slots.push(slot);
    }
  }

  /** Busy workers allowed now: all of them, fewer while the machine's 1-minute load is over the cap. */
  private allowed(): number {
    const load = loadavg()[0];
    if (load <= this.loadCap) return this.size;
    return Math.max(2, this.size - Math.ceil(load - this.loadCap));
  }

  private retry: ReturnType<typeof setTimeout> | null = null;

  private pump(): void {
    const busy = () => this.slots.filter((s) => s.busy).length;
    if (this.queue.length && busy() >= this.allowed()) {
      this.retry ??= setTimeout(() => {
        this.retry = null;
        this.pump();
      }, 2000);
      return;
    }
    while (this.queue.length && busy() < this.allowed()) {
      // Prefer a free worker that already holds the job's window.
      const job = this.queue[0];
      const key = job.ctx?.key;
      let slot = key ? this.slots.find((s) => !s.busy && s.known.has(key)) : undefined;
      slot ??= this.slots.find((s) => !s.busy);
      if (!slot) return;
      this.queue.shift();
      slot.busy = true;
      let task = job.task;
      if (job.ctx && (task.type === 'eval' || task.type === 'commit')) {
        if (!slot.known.has(job.ctx.key)) {
          task = { ...task, ctx: job.ctx };
          slot.known.add(job.ctx.key);
          if (slot.known.size > 20) slot.known.delete(slot.known.values().next().value!);
        }
      }
      const id = this.nextId++;
      slot.pending.set(id, job.resolve);
      slot.child.send({ id, task });
    }
  }

  private submit(task: Task, ctx?: WindowCtx, cpuKey?: string): Promise<Reply> {
    return new Promise((resolve) => {
      this.queue.push({
        task, ctx,
        resolve: (r) => {
          if (r.ok) {
            this.cpuMs += r.cpuMs;
            if (cpuKey) this.cpuByKey.set(cpuKey, (this.cpuByKey.get(cpuKey) ?? 0) + r.cpuMs);
          }
          resolve(r);
        },
      });
      this.pump();
    });
  }

  private static unwrap<T>(r: Reply): T {
    if (!r.ok) throw new Error(r.error);
    return r.data as T;
  }

  /** Evaluate candidates, one task per candidate (all its scenarios), spread over the workers. */
  async evaluate(ctx: WindowCtx, cands: Float64Array[], robust: boolean, cpuKey: string): Promise<EvalReply> {
    const parts = await Promise.all(cands.map((x) => this.submit({ type: 'eval', ctxKey: ctx.key, cands: [x], robust }, ctx, cpuKey).then((r) => Pool.unwrap<EvalReply>(r))));
    return { costs: parts.flatMap((p) => p.costs), fell: parts.flatMap((p) => p.fell) };
  }

  async commit(ctx: WindowCtx, x: Float64Array, snapAtTau: number | null, trace: boolean, cpuKey: string): Promise<CommitReply> {
    return Pool.unwrap<CommitReply>(await this.submit({ type: 'commit', ctxKey: ctx.key, x, snapAtTau, trace }, ctx, cpuKey));
  }

  async full(task: Extract<Task, { type: 'full' }>, cpuKey: string): Promise<FullReply> {
    return Pool.unwrap<FullReply>(await this.submit(task, undefined, cpuKey));
  }

  /** Run whole-move tasks split one perturbation per task. */
  async fullMany(task: Extract<Task, { type: 'full' }>, cpuKey: string): Promise<FullReply> {
    if (task.perturbs.length <= 1) return this.full(task, cpuKey);
    const parts = await Promise.all(task.perturbs.map((p) => this.full({ ...task, perturbs: [p] }, cpuKey)));
    return { runs: parts.flatMap((p) => p.runs) };
  }

  /** Stop every worker this pool started (by its own handle, i.e. its exact PID). */
  close(): void {
    for (const s of this.slots) {
      if (s.child.connected) s.child.disconnect();
      if (s.child.exitCode === null && s.child.pid) s.child.kill('SIGTERM');
    }
  }
}
