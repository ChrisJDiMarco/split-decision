// Control cost: the whole controller (sensing, balance, footwork, skills, IK, feed-forward, gyro)
// must stay under MAX_US_PER_ROBOT per physics step per robot, measured during a live spar.
// Timed in short blocks and judged on the median block, so a busy machine (other test files
// run in parallel) does not decide the verdict.
import { describe, expect, it } from 'vitest';
import { controlSystem, sparringIntent } from '../../src/physics/control';
import type { SimSystem } from '../../src/physics/sim-context';
import { intentSystem } from '../../src/physics/systems/intents';
import { motorSystem } from '../../src/physics/systems/motors';
import { makeSim } from './helpers';

const MAX_US_PER_ROBOT = 40;
const WARMUP_S = 3; // let the JIT settle and the fighters close in
const BLOCKS = 40;
const BLOCK_S = 0.25;
const INTENT_EVERY_S = 0.4;

describe('control cost', () => {
  it(`stays under ${MAX_US_PER_ROBOT} µs per physics step per robot`, async () => {
    let spentMs = 0;
    let measuring = false;
    const timed: SimSystem = {
      ...controlSystem,
      name: 'control-timed',
      pre(ctx) {
        const t0 = performance.now();
        controlSystem.pre!(ctx);
        if (measuring) spentMs += performance.now() - t0;
      },
    };
    const sim = await makeSim({ design: 'striker', x: -1, y: 0, yaw: 0 }, { design: 'bruiser', x: 1, y: 0, yaw: Math.PI }, { systems: [intentSystem, timed, motorSystem] });
    const { ctx } = sim;
    sim.seconds(0.5);
    sim.release(0);
    sim.release(1);
    let next = 0;
    const think = () => {
      if (ctx.time < next) return;
      next = ctx.time + INTENT_EVERY_S;
      for (const r of ctx.robots) r.intent = sparringIntent(ctx, r);
    };
    sim.seconds(WARMUP_S, think);
    measuring = true;
    const steps = Math.round(BLOCK_S / ctx.dt);
    const blocks: number[] = [];
    for (let b = 0; b < BLOCKS; b++) {
      spentMs = 0;
      sim.seconds(BLOCK_S, think);
      blocks.push((spentMs * 1000) / steps / ctx.robots.length);
    }
    blocks.sort((x, y) => x - y);
    const median = blocks[Math.floor(BLOCKS / 2)];
    console.log(`control: median ${median.toFixed(1)} µs per step per robot (best ${blocks[0].toFixed(1)}, worst ${blocks[BLOCKS - 1].toFixed(1)}) over ${BLOCKS} blocks of ${steps} steps`);
    expect(median).toBeLessThan(MAX_US_PER_ROBOT);
    sim.dispose();
  }, 300_000);
});
