// The openings telemetry hook runs twice per rendered frame in the worker: keep it cheap.
import { expect, test } from 'vitest';
import { SYSTEMS } from '../../src/physics/systems';
import { buildTelemetry } from '../../src/physics/systems/telemetry';
import { openingsSystem } from '../../src/physics/openings';
import { makeSim } from '../control/helpers';

test('openings + risk for both fighters cost well under 0.1 ms per frame', async () => {
  const sim = await makeSim({ design: 'savate', x: -0.8, y: 0, yaw: 0 }, { design: 'haymaker', x: 0.8, y: 0, yaw: Math.PI }, { systems: SYSTEMS });
  sim.seconds(0.3); sim.release(0); sim.release(1); sim.seconds(0.5);
  const out = buildTelemetry(sim.ctx, sim.ctx.robots[0], SYSTEMS);
  const N = 2000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    sim.ctx.tick++; // a new frame each time: no snapshot reuse
    openingsSystem.telemetry!(sim.ctx, sim.ctx.robots[0], out);
    openingsSystem.telemetry!(sim.ctx, sim.ctx.robots[1], out);
  }
  const perFrameMs = (performance.now() - t0) / N;
  console.log(`openings telemetry: ${(perFrameMs * 1000).toFixed(1)} µs per frame (both fighters)`);
  expect(perFrameMs).toBeLessThan(0.1);
  sim.dispose();
}, 60_000);
