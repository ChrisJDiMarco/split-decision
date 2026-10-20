// Polish run: a queue of moves through the worker pool, resumable (a checkpoint per move after every
// window), logging to tools/polish/.out/<run>/run.log, PIDs in tools/polish/.out/<run>/pids.txt.
//   nice -n 10 npx tsx tools/polish/run.ts --queue poc --workers 5 [--run poc1] [--only savate/cross.13_17.1024]
//     [--profile full|lite] [--jobs 3] [--no-measure]
//   queues: poc (the five proof-of-concept moves), backgetup (getup_back 140_08 / 140_09 on the modern designs)
// Stop a run only by the PIDs in its pids file (ps -p <pid> -o command= first); it resumes from the
// checkpoints when started again with the same --run.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { polishMove, type PolishOutcome } from './optimise';
import { Pool } from './pool';
import { storePolish } from './store';
import { measureMove } from './measure';
import { QUEUES } from './queues';
import { ROOT } from './world';


const arg = (name: string, def?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};

const queueName = arg('queue', 'poc')!;
const runName = arg('run', `${queueName}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`)!;
const workers = Math.max(1, Math.min(5, Number(arg('workers', '4'))));
const only = arg('only');
const concurrency = Number(arg('jobs', '3'));
const pilot = process.argv.includes('--pilot');
/** Search budgets: full (the PoC), lite (about a third: queues run while other builds load the Mac), pilot (smoke test). */
const BUDGETS = {
  full: { passAGens: 40, passBGens: 30, stall: 10, gainGens: 12 },
  lite: { passAGens: 20, passBGens: 12, stall: 6, gainGens: 6 },
  pilot: { passAGens: 12, passBGens: 8, stall: 5, gainGens: 3 },
} as const;
const profile = (arg('profile', 'full') as keyof typeof BUDGETS) in BUDGETS ? (arg('profile', 'full') as keyof typeof BUDGETS) : 'full';
const outDir = join(ROOT, 'tools', 'polish', '.out', runName);
mkdirSync(outDir, { recursive: true });
const logFile = join(outDir, 'run.log');
const pidFile = join(outDir, 'pids.txt');
writeFileSync(pidFile, `${process.pid} master ${process.argv.slice(2).join(' ')}\n`);
const log = (s: string) => {
  const line = `${new Date().toISOString().slice(11, 19)} ${s}`;
  appendFileSync(logFile, line + '\n');
  console.log(line);
};

const list = (QUEUES[queueName] ?? []).filter((m) => !only || only.split(',').includes(m.split('@')[0]));
if (!list.length) throw new Error(`empty queue '${queueName}'${only ? ` (only ${only})` : ''}`);
log(`run ${runName}: ${list.length} moves, ${workers} workers, ${concurrency} at a time, load ${loadavg()[0].toFixed(1)}${pilot ? ' (pilot)' : ''}`);
const pool = new Pool(workers, pidFile);
const summary: Array<{ move: string; outcome?: PolishOutcome; error?: string }> = [];

async function job(entry: string): Promise<void> {
  // An entry may carry its own budget: 'design/move@lite'.
  const [id, prof] = entry.split('@');
  const [design, moveId] = id.split('/');
  const t0 = Date.now();
  try {
    const b = BUDGETS[pilot ? 'pilot' : prof && prof in BUDGETS ? (prof as keyof typeof BUDGETS) : profile];
    const out = await polishMove(pool, design, moveId, {
      ...b,
      checkpoint: join(outDir, `${design}__${moveId}.ckpt`), log,
    });
    const json = storePolish(out, out.trace, out.traceN, out.impactErr >= 0 ? { tWall: -1, speed: +out.impactSpeed.toFixed(2), err: +out.impactErr.toFixed(3) } : null);
    log(`DONE ${id}: ${json.status}, rate ${json.rate}, wall ${json.wallS} s vs clip ${json.clipS} s, cpu ${json.cpuS} s, ${((Date.now() - t0) / 60000).toFixed(1)} min, replay ${out.replayExact ? 'exact' : 'NOT exact'}`);
    summary.push({ move: id, outcome: out });
    // Measure right away, on the same physics the polish ran on (other builds edit the robots).
    if (!process.argv.includes('--no-measure')) await measureMove(pool, design, moveId, 20, log);
  } catch (e) {
    log(`ERROR ${id}: ${e instanceof Error ? e.stack : String(e)}`);
    summary.push({ move: id, error: String(e) });
  }
}

const queue = [...list];
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
  while (queue.length) await job(queue.shift()!);
}));
log(`run ${runName} finished: ${summary.map((s) => `${s.move} ${s.outcome?.status ?? 'ERROR'}`).join('; ')}; total worker cpu ${(pool.cpuMs / 1000).toFixed(0)} s`);
pool.close();
