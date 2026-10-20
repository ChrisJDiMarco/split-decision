// One move on one robot: the rollout world, its reference, the player, and the start of the move
// (the clip's first frame placed on the canvas, then a settle holding it before the clock starts).
import type { Mat3 } from '../../src/physics/control/math';
import { PolishedPlayer, CONTROL_DT, type Placement, type PolishPlan } from '../../src/robots/motions/polish/player';
import { moveSpec, setArmChannels, SETTLE_S, type MoveSpec } from './plan';
import { buildReference, poseQpos, referenceTrack, type Reference } from './reference';
import { applyStartPerturb, run, type RunOpts, type RunResult } from './rollout';
import { lowestGeomZ, makeWorld, physicsStep, readSense, restore, snapshot, type PolishWorld, type Snapshot } from './world';
import { ARENA } from '../../src/core/arena-spec';

export interface ClockState {
  tau: number;
  rate: number;
  ticks: number;
}

export interface StartPoint {
  snap: Snapshot;
  clock: ClockState;
}

export class MoveSession {
  readonly player: PolishedPlayer;
  /** The feedback's reference track for this move (move frame, quantized as stored). */
  track: Float64Array = new Float64Array(0);

  private constructor(readonly w: PolishWorld, readonly spec: MoveSpec, readonly ref: Reference, readonly place: Placement, plan: PolishPlan) {
    this.player = new PolishedPlayer(w.joints, w.lib.mirror, spec.move, plan);
  }

  static async create(design: string, moveId: string, full = false): Promise<MoveSession> {
    const w = await makeWorld(design, full);
    setArmChannels(w.lib.joints);
    const move = w.lib.move(moveId);
    const spec = moveSpec(w, move);
    // The rollout world plays at the origin; the full world at robot 0's spawn spot.
    const place: Placement = full ? { x: -ARENA.SPAWN_OFFSET_M, y: 0, yaw: 0 } : { x: 0, y: 0, yaw: 0 };
    const ref = buildReference(w, move, place);
    const blank = new Float64Array((spec.segments + 3) * spec.nLib);
    const plan: PolishPlan = {
      knotS: 0.1, segments: spec.segments, tailS: 0.5, rates: spec.baseRates, dq: blank, libJoints: spec.nLib, gyroFF: null,
      fb: { ankleD: 0, ankleV: 0, hipTilt: 0, gyroD: 0, gyroV: 0, gyroL: 0, clamp: 0.15 }, deadband: { com: 0, comVel: 0, L: 0, tilt: 0 },
      nominal: null, nominalSamples: 0, track: null, trackFrames: 0,
    };
    const ses = new MoveSession(w, spec, ref, place, plan);
    // The feedback's reference always comes from the origin placement (the move frame).
    ses.track = full ? referenceTrack(buildReference(w, move, { x: 0, y: 0, yaw: 0 })) : referenceTrack(ref);
    return ses;
  }

  /** The clip's first frame on the canvas (lowest geom 1 mm up), at rest: the state before the settle. */
  placed(): Snapshot {
    const { w } = this;
    const { mj, ctx } = w;
    mj.mj_resetData(ctx.model, ctx.data);
    // The motor model left the last run's limits and gains in the model: the first step's actuator force
    // (and so the first heat increment) must not depend on what ran before.
    (ctx.model.actuator_forcerange as Float64Array).set(w.pristine.forcerange);
    (ctx.model.actuator_gainprm as Float64Array).set(w.pristine.gainprm);
    (ctx.model.actuator_biasprm as Float64Array).set(w.pristine.biasprm);
    // Keep the gantry released (resetData restores eq_active from the model) and the opponent's welded.
    ctx.setEqActive(ctx.eqIndex(w.r.compiled.gantryWeld), false);
    const qpos = ctx.data.qpos as Float64Array;
    if (w.full) {
      // The parked opponent keeps its compiled spawn pose (resetData put it back there).
    }
    poseQpos(w, this.spec.move, 0, this.place, qpos);
    (ctx.data.qvel as Float64Array).fill(0);
    mj.mj_forward(ctx.model, ctx.data);
    const gx = ctx.data.geom_xpos as Float64Array, gm = ctx.data.geom_xmat as Float64Array;
    let low = Infinity;
    for (const g of w.robotGeoms) low = Math.min(low, lowestGeomZ(w, g, gx, gm));
    qpos[w.r.rootQadr + 2] += 0.001 - low;
    mj.mj_forward(ctx.model, ctx.data);
    // Fresh motor state: cold windings, healthy joints, full battery, empty gyro.
    for (const j of w.r.joints) {
      j.tempC = 30;
      j.health = 1;
      j.state = 'ok';
      j.slop = 0;
      j.availableTorque = j.motor.stallTorqueNm;
      j.seizedAt = undefined;
      j.slopOffset = undefined;
      j.slopGoal = undefined;
      j.slopTimer = undefined;
    }
    w.r.battery = 1;
    if (w.r.gyro) {
      w.r.gyro.health = 1;
      w.r.gyro.saturation = 0;
    }
    if (w.gyro) {
      w.gyro.h[0] = w.gyro.h[1] = 0;
      w.gyro.applied.fill(0);
      w.gyro.bleeding.fill(0);
      w.gyro.saturation = 0;
      w.gyro.powerW = 0;
      w.gyro.impulseDelivered = 0;
    }
    (ctx.data.xfrc_applied as Float64Array).fill(0);
    w.rng.s = 1;
    ctx.tick = 0;
    ctx.time = 0;
    return snapshot(w);
  }

  /** Hold the plan's first frame for SETTLE_S, then the clock starts: the move's start point. */
  settle(plan: PolishPlan, from: Snapshot = this.placed()): StartPoint {
    const { w } = this;
    restore(w, from);
    const pl = this.player;
    pl.plan = plan;
    pl.start(this.place, false);
    const steps = Math.round(SETTLE_S / w.ctx.dt);
    for (let i = 0; i < steps; i++) {
      if (w.ctx.tick % 2 === 0) {
        const s = readSense(w);
        w.r.targets.set(pl.hold());
        if (w.gyro) w.gyro.update(w.r, s.torsoRot as unknown as Mat3, [0, 0, 0], CONTROL_DT, w.ctx.data.xfrc_applied as Float64Array, w.ids.torso, true);
      }
      physicsStep(w);
    }
    pl.start(this.place, false);
    return { snap: snapshot(w), clock: { tau: 0, rate: 0, ticks: 0 } };
  }

  /** Roll the move from a start point (or a window snapshot) with a plan. */
  roll(from: StartPoint, plan: PolishPlan, opts: RunOpts): RunResult {
    const { w } = this;
    restore(w, from.snap);
    const pl = this.player;
    pl.plan = plan;
    pl.start(this.place, false);
    pl.tau = from.clock.tau;
    pl.rate = from.clock.rate;
    pl.ticks = from.clock.ticks;
    applyStartPerturb(w, opts.perturb);
    return run(w, pl, this.ref, opts);
  }
}
