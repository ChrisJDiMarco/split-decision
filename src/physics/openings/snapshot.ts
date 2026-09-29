// A plain-data read of one robot's body for the openings and risk rules. Everything the rules
// need comes from MuJoCo state and the robot's own runtime (joints, gyro, battery) plus a read-only
// look at its controller (balance margin, the skill it is running, get-up progress). The rules
// themselves (detect.ts, risk.ts) are pure functions of these snapshots, so tests can feed them
// either a real MuJoCo state or a hand-built one.
import type { JointState } from '../../core/protocol';
import type { Vec3 } from '../../core/types';
import { controllerOf } from '../control';
import { readMat, readVec, yawOf } from '../control/math';
import { views } from '../control/sense';
import { MAX_SLOP_RAD } from '../damage/constants';
import type { RobotRuntime, SimContext } from '../sim-context';

export type SkillPhaseName = 'windup' | 'strike' | 'recover';

export interface SkillSnapshot {
  id: string; // control skill id ('cross', 'head_kick', 'guard', ...)
  kind: 'arm' | 'leg' | 'defense' | 'grapple';
  phase: SkillPhaseName;
  landed: boolean;
}

export interface JointSnapshot {
  name: string;
  health: number; // 0..1
  state: JointState;
  heat: number; // winding temperature as a fraction of the motor's max
  slop?: number; // gear backlash from damage, as a fraction of MAX_SLOP_RAD
}

export interface BodySnapshot {
  corner: 0 | 1;
  time: number;
  com: Vec3;
  comVel: Vec3;
  /** Shoulder-line heading: yaw of the torso's forward axis (what a viewer reads as "facing"). */
  torsoYaw: number;
  /** 0..1 balance margin from the controller (capture point inside the feet, gyro fresh). */
  balance: number;
  /** Mid-step (one foot swinging), when the balance margin dips by design. */
  stepping: boolean;
  /** Standing with both feet planted and no kick running: when stance and move risk are read. */
  planted: boolean;
  upright: number; // torso up-axis z
  gyro: { health: number; saturation: number } | null;
  battery: number;
  massKg: number;
  down: boolean;
  ko: boolean;
  /** Get-up in progress (past the settle on the canvas), or standing up out of the crouch. */
  rising: boolean;
  skill: SkillSnapshot | null;
  fistZ: { l: number; r: number } | null;
  /** Neck pivot height: the chin line a guard must stay above. null once the head is off. */
  chinZ: number | null;
  feet: { l: Vec3; r: Vec3 } | null;
  joints: JointSnapshot[];
  // Guard and weak-spot reads (optional: hand-built snapshots in tests leave them out).
  fists?: { l: Vec3; r: Vec3 } | null; // world positions of the fists
  headPos?: Vec3 | null; // neck pivot (the head body origin); null once the head is off
  torsoPos?: Vec3;
}

function bodyOf(r: RobotRuntime, id: string): number | null {
  const p = r.parts.get(id);
  return p && p.attached ? p.body : null;
}

function skillOf(r: RobotRuntime): SkillSnapshot | null {
  const run = controllerOf(r)?.skills.run;
  if (!run) return null;
  return { id: run.def.id, kind: run.def.kind, phase: run.phase, landed: run.landed };
}

export function snapshot(ctx: SimContext, r: RobotRuntime): BodySnapshot {
  const v = views(ctx);
  const c = controllerOf(r);
  const torso = bodyOf(r, 'torso') ?? r.rootBody;
  const T = readMat(v.xmat, torso);
  const fl = bodyOf(r, 'fist_l'), fr = bodyOf(r, 'fist_r');
  const head = bodyOf(r, 'head');
  const footL = bodyOf(r, 'foot_l'), footR = bodyOf(r, 'foot_r');
  const getUpPhase = c?.getUp.phase ?? 'up';
  const run = c?.skills.run;
  return {
    corner: r.corner,
    time: ctx.time,
    com: readVec(v.subtreeCom, r.rootBody),
    comVel: readVec(v.subtreeLinvel, r.rootBody),
    torsoYaw: yawOf(T),
    balance: c ? c.balanceMargin() : r.down ? 0 : 1,
    stepping: c?.gait.phase === 'single',
    planted: !r.down && (c ? c.gait.bothPlanted() && run?.def.kind !== 'leg' : true),
    upright: T[8],
    gyro: r.gyro ? { health: r.gyro.health, saturation: r.gyro.saturation } : null,
    battery: r.battery,
    massKg: ctx.model.body_subtreemass[r.rootBody] as number,
    down: r.down,
    ko: !!r.koReason,
    rising: !r.koReason && !!c && ((c.getUp.active && getUpPhase !== 'settle') || c.rising),
    skill: skillOf(r),
    fistZ: fl !== null && fr !== null ? { l: v.xpos[fl * 3 + 2], r: v.xpos[fr * 3 + 2] } : null,
    chinZ: head !== null ? v.xpos[head * 3 + 2] : null,
    feet: footL !== null && footR !== null ? { l: readVec(v.xpos, footL), r: readVec(v.xpos, footR) } : null,
    joints: r.joints.map((j) => ({ name: j.name, health: j.health, state: j.state, heat: j.tempC / j.motor.maxTempC, slop: j.slop / MAX_SLOP_RAD })),
    fists: fl !== null && fr !== null ? { l: readVec(v.xpos, fl), r: readVec(v.xpos, fr) } : null,
    headPos: head !== null ? readVec(v.xpos, head) : null,
    torsoPos: readVec(v.xpos, torso),
  };
}
