/// <reference lib="webworker" />
// Physics worker: owns MuJoCo, steps at a fixed dt in real time (or scaled for slow-mo)
// and streams poses, events and telemetry to the main thread at display rate.
import loadMujoco from '@mujoco/mujoco';
import type { MainToWorker, WorkerToMain, WorldMeta } from '../core/protocol';
import type { MatchSetup } from '../core/types';
import { buildContext } from './runtime';
import type { SimContext } from './sim-context';
import { SYSTEMS } from './systems';
import { buildTelemetry } from './systems/telemetry';
import { compileWorld } from './world';

const FRAME_INTERVAL_MS = 1000 / 60;
const MAX_STEPS_PER_SLICE = 60; // don't spiral if the machine falls behind: drop time instead

let mj: Awaited<ReturnType<typeof loadMujoco>> | null = null;
let ctx: SimContext | null = null;
let setup: MatchSetup | null = null;
let paused = false;
let timescale = 1;
let simDebtS = 0;
let lastWall = 0;
let lastFrame = 0;
let stepMsAvg = 0;
let loopHandle: ReturnType<typeof setTimeout> | null = null;

const post = (msg: WorkerToMain, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

function meta(c: SimContext): WorldMeta {
  return {
    nbody: c.model.nbody,
    timestep: c.dt,
    robots: c.robots.map((r) => ({
      corner: r.corner,
      design: r.design.id,
      prefix: r.compiled.prefix,
      parts: [...r.parts.values()].map((p) => ({ id: p.id, body: p.body, debrisBody: p.debrisBody })),
    })),
    props: [],
  };
}

function stepOnce(c: SimContext) {
  for (const s of SYSTEMS) s.pre?.(c);
  c.mj.mj_step(c.model, c.data);
  c.tick++;
  c.time += c.dt;
  for (const s of SYSTEMS) s.post?.(c);
}

function sendFrame(c: SimContext) {
  const n = c.model.nbody;
  const poses = new Float32Array(n * 7);
  const xpos = c.data.xpos;
  const xquat = c.data.xquat;
  for (let b = 0; b < n; b++) {
    poses[b * 7] = xpos[b * 3];
    poses[b * 7 + 1] = xpos[b * 3 + 1];
    poses[b * 7 + 2] = xpos[b * 3 + 2];
    poses[b * 7 + 3] = xquat[b * 4];
    poses[b * 7 + 4] = xquat[b * 4 + 1];
    poses[b * 7 + 5] = xquat[b * 4 + 2];
    poses[b * 7 + 6] = xquat[b * 4 + 3];
  }
  const events = c.events;
  c.events = [];
  post({
    type: 'frame',
    tick: c.tick,
    time: c.time,
    poses,
    events,
    telemetry: [buildTelemetry(c, c.robots[0], SYSTEMS), buildTelemetry(c, c.robots[1], SYSTEMS)],
    stepMs: stepMsAvg,
  }, [poses.buffer]);
}

function loop() {
  if (!ctx) return;
  const now = performance.now();
  const wallS = (now - lastWall) / 1000;
  lastWall = now;
  if (!paused) {
    simDebtS += Math.min(wallS, 0.1) * timescale;
    let steps = 0;
    const t0 = performance.now();
    while (simDebtS >= ctx.dt && steps < MAX_STEPS_PER_SLICE) {
      stepOnce(ctx);
      simDebtS -= ctx.dt;
      steps++;
    }
    if (steps === MAX_STEPS_PER_SLICE) simDebtS = 0; // fell behind: slow down rather than spiral
    if (steps > 0) stepMsAvg = stepMsAvg * 0.9 + ((performance.now() - t0) / steps) * 0.1;
  }
  if (now - lastFrame >= FRAME_INTERVAL_MS) {
    lastFrame = now;
    sendFrame(ctx);
  }
  loopHandle = setTimeout(loop, 1);
}

async function init(s: MatchSetup) {
  mj ??= await loadMujoco();
  if (ctx) {
    ctx.data.delete();
    ctx.model.delete();
  }
  setup = s;
  const world = compileWorld(s);
  ctx = buildContext(mj, world, s);
  for (const sys of SYSTEMS) sys.init?.(ctx);
  post({ type: 'ready', meta: meta(ctx) });
  lastWall = performance.now();
  simDebtS = 0;
  if (loopHandle) clearTimeout(loopHandle);
  loop();
}

self.onmessage = async (e: MessageEvent<MainToWorker>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init':
        await init(msg.setup);
        break;
      case 'reset':
        if (setup) await init(setup);
        break;
      case 'release':
        if (!ctx) return;
        for (const r of ctx.robots) ctx.setEqActive(ctx.eqIndex(r.compiled.gantryWeld), false);
        ctx.released = true;
        break;
      case 'pause':
        paused = msg.paused;
        break;
      case 'timescale':
        timescale = Math.max(0.02, Math.min(2, msg.scale));
        break;
      case 'intent': {
        if (!ctx || !setup) return;
        const delayTicks = Math.round(setup.reactionDelayS / ctx.dt);
        const r = ctx.robots[msg.corner];
        r.pendingIntents.push({ applyAtTick: Math.max(ctx.tick, msg.issuedAtTick + delayTicks), intent: msg.intent });
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) });
  }
};
