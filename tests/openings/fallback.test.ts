// TODO(control-build): until the control build performs the flashy moves, the current controller
// must run every new tactic as a safe fallback (tactics.ts) without crashing or freezing.
import { expect, test } from 'vitest';
import type { Intent, Tactic } from '../../src/core/protocol';
import { controllerOf } from '../../src/physics/control';
import { SYSTEMS } from '../../src/physics/systems';
import { buildTelemetry } from '../../src/physics/systems/telemetry';
import { isFinite, makeSim } from '../control/helpers';

test('the controller runs every new tactic (and a combo) as a fallback', async () => {
  const sim = await makeSim({ design: 'savate', x: -0.8, y: 0, yaw: 0 }, { design: 'haymaker', x: 0.8, y: 0, yaw: Math.PI }, { systems: SYSTEMS });
  sim.seconds(0.3);
  sim.release(0);
  sim.release(1);
  sim.seconds(0.5);
  const r0 = sim.ctx.robots[0];
  const c0 = controllerOf(r0)!;
  const tactics: Tactic[] = ['tornado_kick', 'spinning_back_kick', 'jump_kick', 'jumping_knee', 'superman_punch', 'spinning_backfist', 'switch_stance', 'pivot_left', 'pivot_right', 'feint_left', 'feint_right', 'combo'];
  const skillsSeen = new Set<string>();
  for (const tactic of tactics) {
    const intent: Intent = { tactic, target: 'head', aggression: 0.8, confidence: 0.8, source: 'jev', flourish: true, ...(tactic === 'combo' ? { combo: ['jab', 'cross', 'low_kick'] as Tactic[] } : {}) };
    r0.intent = intent;
    for (let i = 0; i < 60; i++) {
      sim.step(10);
      skillsSeen.add(r0.skill);
    }
    expect(isFinite(sim.ctx)).toBe(true);
    const t = buildTelemetry(sim.ctx, r0, SYSTEMS);
    expect(t.intent?.tactic).toBe(tactic);
  }
  // Strikes were actually thrown through the fallbacks.
  expect([...skillsSeen].some((s) => ['head_kick', 'front_kick', 'cross', 'hook', 'jab'].includes(s))).toBe(true);
  expect(c0.skills.stats.thrown).toBeGreaterThan(2);
  sim.dispose();
}, 120_000);
