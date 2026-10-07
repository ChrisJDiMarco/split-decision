// Control module: balance, footwork, fighting skills, falls and get-ups for the humanoid designs.
// Jev (the brain) only ever sets r.intent; everything here turns that into servo targets.
import type { RobotRuntime, SimContext, SimSystem } from '../sim-context';
import { HumanoidController } from './controller';
import { isHumanoid } from './geometry';

export { availableSkills } from './abilities';
export { sparringIntent } from './sparring';
export { SKILLS, skillDef, type SkillDef, type SkillId } from './skills';
export type { HumanoidController } from './controller';

const CONTROL_DECIMATION = 2; // full controller update every N physics steps (500 Hz at 1 ms)

export function controllerOf(r: RobotRuntime): HumanoidController | null {
  return (r.mem.control as HumanoidController | undefined) ?? null;
}

function ensure(ctx: SimContext, r: RobotRuntime): HumanoidController | null {
  if (!isHumanoid(r.design)) return null;
  let c = controllerOf(r);
  if (!c) {
    c = new HumanoidController(ctx, r);
    r.mem.control = c;
  }
  return c;
}

export const controlSystem: SimSystem = {
  name: 'control',
  init(ctx) {
    for (const r of ctx.robots) ensure(ctx, r);
  },
  pre(ctx) {
    if (ctx.tick % CONTROL_DECIMATION !== 0) return;
    for (const r of ctx.robots) {
      const c = ensure(ctx, r);
      if (c) c.update(ctx, ctx.dt * CONTROL_DECIMATION);
      else r.joints.forEach((j, i) => { r.targets[i] = r.design.stance[j.name] ?? 0; });
    }
  },
  telemetry(_ctx, r, out) {
    const c = controllerOf(r);
    if (!c) return;
    out.balance = c.balanceMargin();
    out.committed = c.skills.committed();
    const combo = c.tactics.combo;
    if (combo) out.comboStep = combo.i;
  },
};
