// Review probe (not a test): do body-run combination steps get pulled in their windup by the brain's
// next intent? Counts, per combo step the body starts (non-feint), how it ended: done/chained vs
// cancelled, split by last step vs earlier steps. --mind house (offline House Mind) or --mind jev (a fake
// Jev that answers after --lat seconds of sim time, preferring the combination when offered).
// usage: SD_BALANCE=dcm npx tsx tests/brain/review-combo-cancel.ts --mind jev --seeds 1,2 --seconds 40
import loadMujoco from '@mujoco/mujoco';
import { Brain } from '../../src/brain/brain';
import type { JevQuestion, JevResult } from '../../src/brain/jev-client';
import { JevLink } from '../../src/brain/link';
import type { Intent, SimEvent } from '../../src/core/protocol';
import type { Corner, MatchSetup } from '../../src/core/types';
import { controllerOf } from '../../src/physics/control';
import { buildContext } from '../../src/physics/runtime';
import { SYSTEMS } from '../../src/physics/systems';
import { buildTelemetry } from '../../src/physics/systems/telemetry';
import { compileWorld } from '../../src/physics/world';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const PAIRS = opt('pairs', 'savate:haymaker,firecracker:pylon,savate:pylon,haymaker:firecracker').split(',').map((p) => p.split(':') as [string, string]);
const SECONDS = Number(opt('seconds', '40'));
const SEEDS = opt('seeds', '1,2').split(',').map(Number);
const MIND = opt('mind', 'house');
const LAT = Number(opt('lat', '0.5'));
const FRAME_S = 1 / 60;
const REACTION_S = 0.3;

function answer(questions: Record<string, JevQuestion>, prefer: Record<string, string>): JevResult {
  const answers: JevResult['answers'] = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === 'choice') {
      const keys = Object.keys(q.criteria);
      const top = prefer[id] && keys.includes(prefer[id]) ? prefer[id] : keys[0];
      answers[id] = { type: 'choice', choice: top, confidence: 0.9, probabilities: Object.fromEntries(keys.map((k) => [k, k === top ? 0.97 : 0.03 / Math.max(1, keys.length - 1)])) };
    } else if (q.type === 'noul') answers[id] = { type: 'noul', noul: 0.2 };
    else answers[id] = { type: 'score', score: 3, confidence: 0.6, probabilities: Object.fromEntries(q.criteria.map((c) => [c, 1 / q.criteria.length])) };
  }
  return { answers, latencyMs: LAT * 1000, inputTokens: 1000, outputTokens: 25 };
}

interface T { last: number; lastCancelled: number; mid: number; midCancelled: number; resets: number; combos: number }
const total: T = { last: 0, lastCancelled: 0, mid: 0, midCancelled: 0, resets: 0, combos: 0 };

async function fight(mj: Awaited<ReturnType<typeof loadMujoco>>, red: string, blue: string, seed: number) {
  const setup: MatchSetup = {
    fighters: [
      { design: red, skin: 'factory', plan: '', temperament: 1.2 },
      { design: blue, skin: 'neon', plan: '', temperament: 1.2 },
    ],
    seed, timestep: 0.001, reactionDelayS: REACTION_S,
  };
  const ctx = buildContext(mj, compileWorld(setup), setup);
  for (const s of SYSTEMS) s.init?.(ctx);
  const queue: Array<{ due: number; go: () => void }> = [];
  const link = MIND === 'jev'
    ? new JevLink({ now: () => ctx.time * 1000, ask: (_s, q) => new Promise((resolve) => { queue.push({ due: ctx.time + LAT, go: () => resolve(answer(q, { tactic: 'combo', opening_move: 'none', on_opening: 'nothing' })) }); }) })
    : new JevLink({ ask: () => Promise.reject(new Error('offline: House Mind')), retryMs: 1e9 });
  const meta = { nbody: 0, timestep: 0.001, robots: [0, 1].map((c) => ({ corner: c as Corner, design: setup.fighters[c].design, prefix: '', parts: [] })), props: [] };
  const t: T = { last: 0, lastCancelled: 0, mid: 0, midCancelled: 0, resets: 0, combos: 0 };
  const brains = ([0, 1] as Corner[]).map((corner) => new Brain({
    corner, meta, seed, link, source: MIND === 'jev' ? 'jev' : 'house', fighter: setup.fighters[corner],
    onIntent: (c: Corner, intent: Intent) => {
      ctx.robots[c].pendingIntents.push({ applyAtTick: ctx.tick + Math.round(REACTION_S / ctx.dt), intent });
      if (intent.tactic === 'combo' && intent.comboPlan?.step === undefined) t.combos++;
    },
    onDecision: (d) => { if (d.reason === 'combination thrown: reset while deciding') t.resets++; },
  }));
  for (let i = 0; i < 300; i++) { for (const s of SYSTEMS) s.pre?.(ctx); mj.mj_step(ctx.model, ctx.data); ctx.tick++; ctx.time += ctx.dt; for (const s of SYSTEMS) s.post?.(ctx); }
  for (const r of ctx.robots) ctx.setEqActive(ctx.eqIndex(r.compiled.gantryWeld), false);
  ctx.released = true;
  for (const b of brains) b.start();
  const tags = [new Map<unknown, 'last' | 'mid'>(), new Map<unknown, 'last' | 'mid'>()];
  const lastRun: unknown[] = [null, null];
  const perFrame = Math.round(FRAME_S / ctx.dt);
  let ended = false;
  for (let f = 0; f < SECONDS / FRAME_S && !ended; f++) {
    const frameEvents: SimEvent[] = [];
    for (let i = 0; i < perFrame; i++) {
      for (const s of SYSTEMS) s.pre?.(ctx);
      mj.mj_step(ctx.model, ctx.data);
      ctx.tick++;
      ctx.time += ctx.dt;
      for (const s of SYSTEMS) s.post?.(ctx);
      for (const e of ctx.events) { frameEvents.push(e); if (e.kind === 'ko') ended = true; }
      ctx.events.length = 0;
      for (const c of [0, 1]) {
        const ctl = controllerOf(ctx.robots[c]);
        if (!ctl) continue;
        const tr = ctl.tactics as unknown as { combo: { current: unknown; i: number; steps: unknown[] } | null; feintRun: unknown };
        const cb = tr.combo;
        const run = ctl.skills.run;
        if (cb && cb.current && cb.current === run && !tags[c].has(run) && tr.feintRun !== run && (run!.def.kind === 'arm' || run!.def.kind === 'leg')) {
          const kind = cb.i >= cb.steps.length ? 'last' : 'mid';
          tags[c].set(run, kind);
          if (kind === 'last') t.last++; else t.mid++;
        }
        if (run !== lastRun[c]) {
          const prev = lastRun[c];
          const tag = prev ? tags[c].get(prev) : undefined;
          if (tag && (ctl.skills as unknown as { lastEnd: string }).lastEnd === 'cancelled') {
            if (tag === 'last') t.lastCancelled++; else t.midCancelled++;
          }
          lastRun[c] = run;
        }
      }
    }
    for (let k = queue.length - 1; k >= 0; k--) if (queue[k].due <= ctx.time) { const q = queue.splice(k, 1)[0]; q.go(); }
    const telemetry = [buildTelemetry(ctx, ctx.robots[0], SYSTEMS), buildTelemetry(ctx, ctx.robots[1], SYSTEMS)] as [ReturnType<typeof buildTelemetry>, ReturnType<typeof buildTelemetry>];
    for (const b of brains) b.onFrame({ tick: ctx.tick, time: ctx.time, events: frameEvents, telemetry });
    await Promise.resolve();
    await Promise.resolve();
  }
  for (const k of Object.keys(total) as Array<keyof T>) total[k] += t[k];
  console.log(`${red} v ${blue} s${seed}: combos sent ${t.combos}, resets ${t.resets} | last steps ${t.last}, cancelled ${t.lastCancelled} | earlier steps ${t.mid}, cancelled ${t.midCancelled}`);
}

const mj = await loadMujoco();
for (const [red, blue] of PAIRS) for (const seed of SEEDS) await fight(mj, red, blue, seed);
console.log(`TOTAL mind ${MIND} | combos sent ${total.combos}, resets ${total.resets} | last steps ${total.last}, cancelled ${total.lastCancelled} (${((100 * total.lastCancelled) / Math.max(1, total.last)).toFixed(0)}%) | earlier steps ${total.mid}, cancelled ${total.midCancelled} (${((100 * total.midCancelled) / Math.max(1, total.mid)).toFixed(0)}%) | balance ${process.env.SD_BALANCE ?? 'default'}`);
