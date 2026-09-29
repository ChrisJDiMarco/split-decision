// A sparring partner's brain: a small deterministic policy (all randomness from ctx.rng) that
// closes the distance, throws whatever reaches, covers up against big windups and moves off
// the line now and then. Used by tests and as a stand-in when no brain is attached.
import type { Intent, Tactic, TargetZone } from '../../core/protocol';
import type { RobotRuntime, SimContext } from '../sim-context';
import { availableSkills } from './abilities';
import { humanoidGeometry, isHumanoid } from './geometry';
import { SKILLS, isStrikeSkill, type SkillId } from './skills';

const FAR_M = 1.6;
const THREAT_WINDUP = 0.5;
const THREAT_M = 1.2;
const GUARD_CHANCE = 0.35;
const CIRCLE_CHANCE = 0.12;
const STRIKE_CHANCE = 0.85;
const PUNCH_WEIGHT = 2; // hands are thrown twice as often as kicks (a kick risks the kicker's balance)

/** Punch zones: mostly the head, sometimes the body. Kicks go where they are built to go. */
function zoneFor(id: SkillId, roll: number): TargetZone {
  if (id === 'low_kick') return roll < 0.5 ? 'left_leg' : 'right_leg';
  if (id === 'front_kick') return 'torso';
  if (id === 'head_kick' || id === 'uppercut') return 'head';
  return roll < 0.7 ? 'head' : 'torso';
}

function com(ctx: SimContext, r: RobotRuntime): [number, number] {
  const c = ctx.data.subtree_com;
  return [c[r.rootBody * 3], c[r.rootBody * 3 + 1]];
}

function weightedPick(pool: SkillId[], roll: number): SkillId {
  const weight = (id: SkillId) => (SKILLS[id]!.kind === 'arm' ? PUNCH_WEIGHT : 1);
  let left = roll * pool.reduce((sum, id) => sum + weight(id), 0);
  for (const id of pool) {
    left -= weight(id);
    if (left < 0) return id;
  }
  return pool[pool.length - 1];
}

export function sparringIntent(ctx: SimContext, robot: RobotRuntime): Intent {
  const rng = ctx.rng;
  const aggression = 0.5 + 0.4 * rng();
  const opp = ctx.robots[robot.corner === 0 ? 1 : 0];
  const intent = (tactic: Tactic, target: TargetZone = 'head', extra: Partial<Intent> = {}): Intent => ({
    tactic, target, aggression, confidence: 0.6, source: 'fallback', ...extra,
  });
  if (robot.down || !isHumanoid(robot.design)) return intent('guard', 'head', { settledLocally: true });
  const [ax, ay] = com(ctx, robot);
  const [bx, by] = com(ctx, opp);
  const dist = Math.hypot(bx - ax, by - ay);
  const strikes = availableSkills(robot).filter((id) => isStrikeSkill(SKILLS[id]!));
  const counterIfLunge: Tactic | undefined = rng() < 0.5 ? 'guard' : strikes.includes('jab') ? 'jab' : undefined;
  if (opp.down) return intent('hold_range', 'head', { settledLocally: true });
  if (dist > FAR_M || !strikes.length) return intent('close_distance', 'head', { counterIfLunge });
  if (opp.windup > THREAT_WINDUP && dist < THREAT_M && rng() < GUARD_CHANCE) return intent('guard');
  const roll = rng();
  if (roll < CIRCLE_CHANCE) return intent(rng() < 0.5 ? 'circle_left' : 'circle_right', 'head', { counterIfLunge });
  // The controller's own skills and geometry (a mocap fighter's ranges come from its clips).
  const c = robot.mem.control as { geo: ReturnType<typeof humanoidGeometry>; skillFor(id: SkillId): { range(g: unknown): [number, number] } | undefined } | undefined;
  const geo = c?.geo ?? humanoidGeometry(robot.design);
  const reach = strikes.filter((id) => {
    const [lo, hi] = (c?.skillFor(id) ?? SKILLS[id]!).range(geo);
    return dist >= lo && dist <= hi;
  });
  const pool = reach.length && roll < STRIKE_CHANCE ? reach : strikes;
  const pick = weightedPick(pool, rng());
  return intent(pick as Tactic, zoneFor(pick, rng()), { counterIfLunge });
}
