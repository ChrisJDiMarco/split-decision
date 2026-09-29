// Grip of the dexterous hands (src/robots/hands.ts). Each hand has one tendon drive; this system
// sets its target from what the body is doing and leaves every other actuator alone:
//   fist      striking or guarding, whenever the opponent is in fighting range, and down or
//             getting up (the get-ups plant the knuckles; they were tuned on a fist)
//   grab      clinching: the fingers hook half-closed round an arm or the neck
//   spread    falling: the hand opens flat to brace
//   relaxed   on the gantry or far apart
//   slack     knocked out or the battery flat: the drive lets go and the springs open the hand
// Designs without a grip tendon are skipped, so stock fists behave exactly as before.
import type { RobotRuntime, SimContext, SimSystem } from '../sim-context';
import { fistTendonLength, gripTendon } from '../../robots/hands';

const UPDATE_EVERY_TICKS = 5;
const GRIP = { fist: 1, grab: 0.55, spread: 0, relaxed: 0.35, slack: 0 } as const;
const FIGHT_RANGE_M = 2.2;
const FALL_UPRIGHT = 0.6;
const DEAD_BATTERY = 0.02;
const NO_FIST_SKILLS = new Set(['stance', 'step', 'clinch', 'out', 'walk']);

interface HandState {
  act: [number, number]; // actuator ids of grip_l, grip_r
  fistLen: number;
  grip: [number, number];
  torso: number;
}

function stateOf(ctx: SimContext, r: RobotRuntime): HandState | null {
  const cached = r.mem.hands as HandState | null | undefined;
  if (cached !== undefined) return cached;
  const tendons = r.compiled.tendons.map((t) => t.id);
  const torso = r.parts.get('torso');
  if (!tendons.includes(gripTendon('l')) || !tendons.includes(gripTendon('r')) || !torso) {
    r.mem.hands = null;
    return null;
  }
  const act = (['l', 'r'] as const).map((s) => ctx.model.actuator(`${r.compiled.prefix}${gripTendon(s)}_m`).id as number) as [number, number];
  const st: HandState = { act, fistLen: fistTendonLength(), grip: [GRIP.relaxed, GRIP.relaxed], torso: torso.body };
  r.mem.hands = st;
  return st;
}

/** Grip for both hands, 0 open .. 1 fist. */
export function gripFor(ctx: SimContext, r: RobotRuntime, torsoUp: number, oppDist: number): number {
  if (r.koReason || r.battery <= DEAD_BATTERY) return GRIP.slack;
  // Falling: open to brace. Down and rising: the get-ups plant the knuckles (they were tuned on a
  // fist), so the hand closes into one; open fingers there cut the get-up rate roughly in half.
  if (r.down || r.skill.startsWith('getup')) return GRIP.fist;
  if (ctx.released && torsoUp < FALL_UPRIGHT) return GRIP.spread;
  if (!ctx.released) return GRIP.relaxed;
  if (r.skill === 'clinch' || r.intent?.tactic === 'clinch') return GRIP.grab;
  if (!NO_FIST_SKILLS.has(r.skill) || r.windup > 0 || r.intent?.tactic === 'guard') return GRIP.fist;
  return oppDist < FIGHT_RANGE_M ? GRIP.fist : GRIP.relaxed;
}

export const handsSystem: SimSystem = {
  name: 'hands',
  pre(ctx) {
    if (ctx.tick % UPDATE_EVERY_TICKS !== 0) return;
    const xpos = ctx.data.xpos as Float64Array;
    const xmat = ctx.data.xmat as Float64Array;
    for (const r of ctx.robots) {
      const st = stateOf(ctx, r);
      if (!st) continue;
      const opp = ctx.robots[r.corner === 0 ? 1 : 0];
      const a = r.rootBody * 3, b = opp.rootBody * 3;
      const dist = Math.hypot(xpos[a] - xpos[b], xpos[a + 1] - xpos[b + 1]);
      const g = gripFor(ctx, r, xmat[st.torso * 9 + 8], dist);
      st.grip[0] = g;
      st.grip[1] = g;
      ctx.data.ctrl[st.act[0]] = g * st.fistLen;
      ctx.data.ctrl[st.act[1]] = g * st.fistLen;
    }
  },
  telemetry(_ctx, r, out) {
    const st = r.mem.hands as HandState | null | undefined;
    if (st) out.grip = { l: st.grip[0], r: st.grip[1] };
  },
};
