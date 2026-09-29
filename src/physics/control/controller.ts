// Per-robot humanoid controller, every control tick:
//   sense → skill (arms, torso, borrowed leg) → steps → gait (legs, COM plan) → balance
//   (pelvis target, gyro) → IK → velocity + gravity feed-forward → servo targets
import type { TargetZone } from '../../core/protocol';
import type { Vec3 } from '../../core/types';
import type { RobotRuntime, SimContext } from '../sim-context';
import { Balance } from './balance';
import { applyGravityFeedforward, jointInfo, VelocityFeedforward, type JointInfo } from './feedforward';
import { Gait, type StanceFrame, type StepTiming } from './gait';
import { humanoidGeometry, SIDES, type HumanoidGeometry, type Side } from './geometry';
import { GetUp, getUpTuning } from './getup';
import { GyroCore } from './gyro';
import { footLoads, reachablePelvisYaw, soleRoll } from './loads';
import { clamp, mulMM, mulMtV, readVec, rot2, rotationError, rotY, rotZ, sub, wrapAngle, yawPitchRoll, type Mat3 } from './math';
import { jointMap, newBodyCommand, solveBody, type BodyCommand, type JointMap } from './posture';
import { bodyIds, GRAVITY, robotMass, sense, views, type BodyIds, type Sense } from './sense';
import { SkillRunner } from './skills/runner';
import { opponentView, type OpponentView } from './skills/targets';
import { neutralPose, type SkillDef, type SkillEnv, type SkillPose } from './skills/types';
import { stanceFor, type StanceParams } from './stance';
import { adjustSwing, captureStep, HOLD_TOL, MOVE_TOL, planStep, skillCaptureStep } from './stepping';
import type { P2 } from './support';
import { Rise } from './rise';
import { rollKeysFor } from './roll-keys';
import { UpperBodyStrategy } from './strategies';
import { TacticRunner } from './tactics';
import { Walker } from './walk';

export const DEFAULT_TIMING: StepTiming = { shift: 1.2, shiftFraction: 1, swing: 0.3, lift: 0.05 };
const MASS_REFRESH_S = 0.25;
const DIP_TAU_S = 0.12;
// How far the pelvis yaw target may lead the measured yaw. The stance hip yaw servo reaches full
// torque within a few degrees, and a single sole's friction cannot resist that: a larger error
// spins the stance foot instead of the body. Two spread feet hold much more.
const YAW_LEAD_SINGLE_RAD = 0.06;
const YAW_LEAD_DOUBLE_RAD = 0.25;
const NO_TORQUE: Vec3 = [0, 0, 0];
const DOWN_BLEED_S = 0.3; // lying on the canvas, the gyro desaturates this fast (within its torque cap)
const RISE_OFFSET_TAU_S = 0.04; // unfolding out of the crouch, the pelvis chases the moving COM this fast
const RISE_SLOW_INSIDE_M = 0.02; // the rise slows once the capture point is this close to the soles' edge...
const RISE_PAUSE_OUTSIDE_M = 0.03; // ...and all but stops this far outside them
const RISE_MIN_RATE = 0.1;
const WALK_SPEED = 0.55; // m/s closing the distance, at aggression 0.5
const WALK_ASSIST_SHARE = 0.6; // share of the gyro's torque a walk may use to steer the COM
const WALK_ASSIST_SAT = 0.6; // ...tapering to none as its rotor fills to this
const SPRINT_FACTOR = 1.15;

export class HumanoidController {
  readonly geo: HumanoidGeometry;
  readonly ids: BodyIds;
  readonly jm: JointMap;
  readonly joints: JointInfo[];
  readonly stance: StanceParams;
  readonly gait: Gait;
  readonly balance = new Balance();
  readonly gyro: GyroCore | null;
  readonly cmd: BodyCommand = newBodyCommand();
  readonly q: Float64Array;
  readonly velFF: VelocityFeedforward;
  readonly skills: SkillRunner;
  readonly tactics: TacticRunner;
  readonly getUp: GetUp;
  readonly walker: Walker;
  /** false: the robot just holds its design stance (a training dummy on a gantry). */
  enabled = true;
  mass = 0;
  heading = 0; // stance heading (toward the opponent)
  /** Desired stance frame for footwork; null holds position while facing the opponent. */
  goal: StanceFrame | null = null;
  timing: StepTiming = { ...DEFAULT_TIMING };
  lastSense: Sense | null = null;
  opp: OpponentView | null = null;
  pose: SkillPose;
  comRef: P2 = [0, 0];
  plannedCop: P2 = [0, 0];
  private dip = 0;
  private massAge = 0;
  private lastStepSide: Side | null = null;
  private readonly qNow: Float64Array;
  private readonly rise: Rise;
  private readonly upperBody = new UpperBodyStrategy();
  /** Upper-body share of the mass × its height above the pelvis: how far a bend moves the COM. */
  private readonly upperLever: number;

  constructor(ctx: SimContext, readonly r: RobotRuntime) {
    this.geo = humanoidGeometry(r.design);
    this.ids = bodyIds(r);
    this.jm = jointMap(r);
    this.joints = jointInfo(r, ctx.model.dof_jntid);
    this.stance = stanceFor(this.geo);
    this.gait = new Gait(this.geo, this.stance);
    const subtreeMass = ctx.model.body_subtreemass;
    this.walker = new Walker(this.gait, this.geo, subtreeMass[this.ids.thigh.l] / subtreeMass[r.rootBody]);
    this.gyro = r.design.gyro ? new GyroCore(r.design.gyro) : null;
    this.q = new Float64Array(r.joints.length);
    this.velFF = new VelocityFeedforward(r.joints.length);
    this.skills = new SkillRunner(r, ctx.robots[r.corner === 0 ? 1 : 0]);
    this.tactics = new TacticRunner(this);
    this.qNow = new Float64Array(r.joints.length);
    const tuning = getUpTuning(r.design.id);
    const brace = Float64Array.from(r.joints, (j) => r.design.stance[j.name] ?? 0);
    this.getUp = new GetUp(this.geo, this.jm, this.stance, brace, tuning, rollKeysFor(r.design.id));
    this.rise = new Rise(tuning.riseS);
    this.pose = neutralPose(this.stance);
    const subtree = ctx.model.body_subtreemass;
    this.upperLever = (subtree[this.ids.torso] / subtree[r.rootBody]) * (this.geo.pelvisToTorso[2] + this.geo.torsoCenter[2]);
    this.mass = robotMass(views(ctx), this.ids);
  }

  /** Start a skill now (returns false if another is running or it cannot be used). */
  startSkill(def: SkillDef, zone: TargetZone = def.defaultZone, aggression = 0.6): boolean {
    return this.skills.start(def, zone, aggression);
  }

  update(ctx: SimContext, dt: number): void {
    if (!this.enabled) return this.passive(ctx);
    this.refreshMass(ctx, dt);
    const s = sense(ctx, this.r, this.geo, this.ids, this.mass);
    this.lastSense = s;
    this.opp = opponentView(ctx, ctx.robots[this.r.corner === 0 ? 1 : 0]);
    if (ctx.released && (this.getUp.active || this.r.koReason || this.checkFall(ctx, s, dt))) return this.down(ctx, s, dt);
    const bearing = Math.atan2(this.opp.com[1] - s.com[1], this.opp.com[0] - s.com[0]);
    if (!ctx.released) this.hang(s, bearing);
    else this.stand(ctx, s, dt, bearing);
    solveBody(this.cmd, this.geo, this.jm, this.q, { pos: s.pelvisPos, rot: s.pelvisRot, shin: { l: s.feet.l.shinRot, r: s.feet.r.shinRot } });
    for (const side of SIDES) this.velFF.hold[this.jm.leg[side].hipYaw] = this.gait.planted(side) ? 1 : 0;
    this.velFF.apply(this.r, this.q, dt);
    applyGravityFeedforward(views(ctx), this.r, this.joints, footLoads(this.geo, this.gait, s, this.plannedCop), this.mass, this.q);
    this.r.targets.set(this.q);
    this.report();
  }

  /** Still standing up out of the get-up crouch (balance owns the body, the feet stay put). */
  get rising(): boolean {
    return this.rise.active;
  }

  /** Standing: has the robot just gone down? Abandons whatever it was doing if so. */
  private checkFall(ctx: SimContext, s: Sense, dt: number): boolean {
    if (!this.getUp.detect(s, dt, this.rise.active)) return false;
    this.rise.active = false;
    this.upperBody.reset();
    this.skills.cancel(this.skillEnv(s), true);
    this.walker.cancel();
    this.gait.resetAir(this.gait.currentFrame());
    this.goal = null;
    this.gyro?.release(views(ctx).xfrc, this.ids.torso);
    this.r.down = true;
    ctx.events.push({ kind: 'fall', corner: this.r.corner });
    return true;
  }

  /** On the canvas: the scripted get-up owns the joints (a knocked-out robot just lies there). */
  private down(ctx: SimContext, s: Sense, dt: number): void {
    this.r.joints.forEach((j, i) => { this.qNow[i] = ctx.data.qpos[j.qadr] as number; });
    if (this.r.koReason) {
      this.gyro?.release(views(ctx).xfrc, this.ids.torso);
      this.skills.cancel(null, true);
      this.q.set(this.qNow); // out cold: no servo effort, only damping
      if (!this.r.down && this.getUp.detect(s, dt)) {
        this.r.down = true;
        ctx.events.push({ kind: 'fall', corner: this.r.corner });
      }
    } else {
      this.bleedGyro(ctx, s, dt);
      if (this.getUp.update(ctx, s, this.qNow, this.q, dt, this.fistsWorld(ctx))) {
        this.standFromCrouch(ctx, s);
        this.r.down = false;
        ctx.events.push({ kind: 'getup', corner: this.r.corner });
      }
    }
    this.r.targets.set(this.q);
    this.report();
  }

  /**
   * On the canvas the gyro dumps the momentum it soaked up fighting the fall back into the body
   * (the canvas takes it). Otherwise it starts the rise saturated, and its desaturation torque
   * shoves the rising body the way it just fell.
   */
  private bleedGyro(ctx: SimContext, s: Sense, dt: number): void {
    this.gyro?.update(this.r, s.torsoRot, NO_TORQUE, dt, views(ctx).xfrc, this.ids.torso, true, DOWN_BLEED_S);
  }

  private fistsWorld(ctx: SimContext): Record<Side, Vec3> {
    const v = views(ctx);
    return { l: readVec(v.xpos, this.ids.fist.l), r: readVec(v.xpos, this.ids.fist.r) };
  }

  /** Crouched over both feet: balance takes over and stands the robot up from here. */
  standFromCrouch(ctx: SimContext, s: Sense): void {
    this.r.joints.forEach((j, i) => { this.qNow[i] = ctx.data.qpos[j.qadr] as number; });
    this.gait.plantBoth(s);
    this.balance.reset();
    this.upperBody.reset();
    this.velFF.reset();
    const v = views(ctx);
    const toTorso = (b: number) => mulMtV(s.torsoRot, sub(readVec(v.xpos, b), s.torsoPos));
    this.rise.start(s, this.stance, this.qNow[this.jm.waistPitch], { l: toTorso(this.ids.fist.l), r: toTorso(this.ids.fist.r) });
  }

  private passive(ctx: SimContext): void {
    this.r.joints.forEach((j, i) => { this.r.targets[i] = this.r.design.stance[j.name] ?? 0; });
    this.gyro?.release(views(ctx).xfrc, this.ids.torso);
  }

  private refreshMass(ctx: SimContext, dt: number): void {
    this.massAge += dt;
    if (this.massAge < MASS_REFRESH_S) return;
    this.massAge = 0;
    this.mass = robotMass(views(ctx), this.ids); // parts can come off mid-fight
  }

  private setGuard(): void {
    for (const side of SIDES) {
      const arm = this.cmd.arms[side];
      arm.mode = 'fist';
      arm.fist = [...this.stance.guard[side].fist] as Vec3;
      arm.pole = [...this.stance.guard[side].pole] as Vec3;
    }
    this.cmd.neckYaw = -this.stance.pelvisYaw - this.stance.waistYaw;
  }

  /** On the gantry: hold the stance around a virtual pelvis at stance height. */
  private hang(s: Sense, bearing: number): void {
    const st = this.stance;
    this.heading = bearing;
    this.gait.resetAir({ x: s.pelvisPos[0], y: s.pelvisPos[1], heading: bearing });
    this.cmd.pelvisPos = [s.pelvisPos[0], s.pelvisPos[1], st.pelvisHeight];
    this.cmd.pelvisRot = rotZ(s.heading);
    for (const side of SIDES) this.gait.footCommand(side, this.gait.feet[side].place, 0, this.cmd.legs[side]);
    this.setGuard();
    this.cmd.waistYaw = st.waistYaw;
    this.cmd.waistPitch = st.waistPitch;
    this.balance.reset();
  }

  private skillEnv(s: Sense): SkillEnv {
    const T = s.torsoRot, tp = s.torsoPos;
    return {
      s, geo: this.geo, stance: this.stance, opp: this.opp!, zone: 'head', aggression: 0.6,
      heading: this.heading, cmd: this.cmd, pose: this.pose, gait: this.gait,
      toTorso: (p: Vec3) => mulMtV(T, sub(p, tp)),
      joint: (name: string) => {
        const i = this.r.jointIndex.get(name);
        return i === undefined ? undefined : this.r.joints[i];
      },
    };
  }

  private stand(ctx: SimContext, s: Sense, dt: number, bearing: number): void {
    const st = this.stance;
    this.heading = bearing;
    this.pose = neutralPose(st);
    this.setGuard();
    const env = this.skillEnv(s);
    if (this.rise.active) this.rise.apply(this.pose, this.cmd, st, dt, this.riseRate(s));
    else {
      this.tactics.update(ctx, s, env);
      this.skills.update(ctx, env, dt);
    }
    this.decideSteps(s, env, dt);
    const [wf, wl] = this.pose.weightShift;
    const shift = rot2(wf, wl, this.heading);
    const plan = this.gait.update(dt, s, this.cmd.legs, shift);
    this.comRef = plan.pos;
    // Integral trim while both feet bear weight (in single support the COP has too little room).
    const settled = (this.gait.phase === 'double' || this.gait.phase === 'shift') && this.gait.bothPlanted();
    const support = this.gait.supportPolygon();
    const [px, py] = this.balance.pelvisTarget(s, plan, dt, settled, this.rise.active ? RISE_OFFSET_TAU_S : undefined);
    this.plannedCop = this.balance.plannedCop(s, plan, support, this.gyro?.bleeding);
    this.dip += (this.gait.stepDip() - this.dip) * Math.min(1, dt / DIP_TAU_S);
    // Walking squares the hips up to the way it goes (a bladed pelvis walks crabwise).
    const blade = this.walker.active ? 0 : st.pelvisYaw;
    const yaw = this.yawTarget(s, reachablePelvisYaw(this.geo, this.gait, bearing + blade + this.pose.pelvisYaw));
    // Hip and waist strategy: bend toward the fall, hips back so the bend itself does not carry
    // the COM out with it (only its angular momentum acts).
    const bend = this.upperBody.update(s, support, s.heading, this.gyroHealth(), dt);
    const [bx, by] = rot2(-this.upperLever * (bend.pitch + bend.waist), this.upperLever * bend.roll, s.heading);
    this.cmd.pelvisPos = [px + bx, py + by, st.pelvisHeight - this.dip - this.pose.pelvisDrop];
    this.cmd.pelvisRot = this.rise.rotation(yawPitchRoll(yaw, this.pose.pelvisPitch + bend.pitch, bend.roll));
    // The gyro holds the torso to the unbent attitude: its momentum is for the fall, not the bend.
    const unbent = mulMM(mulMM(this.rise.rotation(yawPitchRoll(yaw, this.pose.pelvisPitch, 0)), rotZ(this.pose.waistYaw)), rotY(this.pose.waistPitch));
    this.cmd.waistYaw = this.pose.waistYaw;
    this.cmd.waistPitch = this.pose.waistPitch + bend.waist;
    const capRef: P2 = [plan.pos[0] + plan.vel[0] / s.omega0, plan.pos[1] + plan.vel[1] / s.omega0];
    this.driveGyro(ctx, s, dt, capRef, this.gait.catchSupport(), unbent);
  }

  /** Rise pacing: full speed with the capture point over the feet, near pause once it wanders off. */
  private riseRate(s: Sense): number {
    const out = this.gait.supportDistance([s.capture[0], s.capture[1]]);
    if (!Number.isFinite(out)) return 1;
    return clamp(1 - (out + RISE_SLOW_INSIDE_M) / (RISE_SLOW_INSIDE_M + RISE_PAUSE_OUTSIDE_M), RISE_MIN_RATE, 1);
  }

  /** 1 = an intact gyro core, 0 = destroyed or absent. */
  private gyroHealth(): number {
    return this.gyro ? clamp(this.r.gyro?.health ?? 0, 0, 1) : 0;
  }

  private yawTarget(s: Sense, want: number): number {
    const lead = this.gait.bothPlanted() ? YAW_LEAD_DOUBLE_RAD : YAW_LEAD_SINGLE_RAD;
    return s.heading + clamp(wrapAngle(want - s.heading), -lead, lead);
  }

  private decideSteps(s: Sense, env: SkillEnv, dt: number): void {
    const gait = this.gait;
    if (gait.airborne()) return;
    // A walk plans every step on the capture point itself: its steps are not capture steps.
    if (!gait.walking && this.rise.stepsAllowed() && captureStep(gait, this.geo, s)) {
      this.walker.cancel();
      gait.captureSteps++;
      return;
    }
    if (skillCaptureStep(gait, this.geo, s)) {
      gait.captureSteps++;
      this.skills.cancel(env, true);
      return;
    }
    if (!gait.walking) adjustSwing(gait, this.geo, s);
    // Feet stay planted while a skill runs (kicks borrow a leg through the gait).
    if (this.skills.active() || this.pose.holdFeet) {
      if (this.walker.active) this.walker.cancel();
      return;
    }
    // Covering ground: walk (the COM keeps travelling) until close, then square up in stance.
    if (this.walker.active || this.walker.wants(s, this.goal, s.heading - this.stance.pelvisYaw)) {
      if (this.walker.update(s, this.goal, this.walker.params(this.walkSpeed(), this.gyroAssistM(s)), dt)) return;
    }
    const cur = gait.bothPlanted() ? gait.currentFrame() : null;
    if (!cur) return;
    const want = this.goal ?? { x: cur.x, y: cur.y, heading: this.heading };
    const side = planStep(gait, this.geo, want, this.timing, this.lastStepSide, this.goal ? MOVE_TOL : HOLD_TOL);
    if (side) this.lastStepSide = side;
  }

  /**
   * How far the gyro core can shift the pressure point for a walk right now: its torque over m·g,
   * scaled back as its rotor fills (it must keep momentum in hand for a real fall).
   */
  private gyroAssistM(s: Sense): number {
    if (!this.gyro) return 0;
    const free = clamp(1 - this.gyro.saturation / WALK_ASSIST_SAT, 0, 1);
    return (WALK_ASSIST_SHARE * this.gyro.spec.maxTorqueNm * this.gyroHealth() * free) / (s.mass * GRAVITY);
  }

  /** Walking pace: brisker with aggression, faster still for a sprinter's legs. */
  private walkSpeed(): number {
    const a = this.r.intent?.aggression ?? 0.5;
    return WALK_SPEED * (0.8 + 0.4 * a) * (this.r.design.abilities.includes('sprint') ? SPRINT_FACTOR : 1);
  }

  private driveGyro(ctx: SimContext, s: Sense, dt: number, capRef: P2, support: P2[], desiredTorso: Mat3): void {
    if (!this.gyro) return;
    const tilt = rotationError(s.torsoRot, desiredTorso);
    const roll = soleRoll(this.gait, s, footLoads(this.geo, this.gait, s, this.plannedCop));
    const demand = this.balance.gyroDemand(s, capRef, support, tilt, roll);
    if (this.gait.walking) {
      // The walk's pressure point beyond the sole: COP shift Δ ⇒ torque m·g·(Δy, −Δx, 0).
      const mg = s.mass * GRAVITY;
      demand[0] += mg * this.walker.assist[1];
      demand[1] -= mg * this.walker.assist[0];
    }
    this.gyro.update(this.r, s.torsoRot, demand, dt, views(ctx).xfrc, this.ids.torso, true);
  }

  /** Publish what the body is doing for telemetry and the opponent's reflexes. */
  private report(): void {
    const run = this.skills.run;
    if (this.r.koReason) this.r.skill = 'out';
    else if (this.getUp.active) this.r.skill = `getup_${this.getUp.phase}`;
    else if (this.rise.active) this.r.skill = 'getup_rise';
    else this.r.skill = run ? run.def.id : this.gait.phase === 'double' ? 'stance' : 'step';
    this.r.skillPhase = this.skills.progress();
    this.r.windup = this.skills.windup();
  }

  /** 1 = capture point well inside the feet and the gyro fresh; 0 = falling or down. */
  balanceMargin(): number {
    const s = this.lastSense;
    if (!s || this.r.down || this.getUp.active) return 0;
    const out = this.gait.supportDistance([s.capture[0], s.capture[1]]);
    const cp = Number.isFinite(out) ? clamp(0.5 - out / 0.2, 0, 1) : 0.3;
    return clamp(cp - 0.4 * (this.gyro?.saturation ?? 0), 0, 1);
  }
}
