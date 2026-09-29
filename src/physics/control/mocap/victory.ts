// The winner's celebration after a knockout: one of the design's library victory clips (feet on
// the canvas in every one) played on the arms, neck and a little of the chest, feet planted and
// balance running as usual. Plays, pauses, picks again, for as long as the sim runs on.
import type { Move } from '../../../robots/motions';
import { SIDES, type Side } from '../geometry';
import { armIK, newArmAngles, type ArmAngles } from '../ik';
import { clamp, minJerk } from '../math';
import type { SkillEnv } from '../skills/types';
import type { MocapSet } from './library';
import type { MotionPlayer } from './player';
import { lerpArm, readArm } from './strikes';

const BLEND_S = 0.3; // into and out of each clip, from and back to the guard
const PAUSE_S = 0.8; // between clips
const WAIST_PITCH_MAX = 0.2; // rad of the clip's waist bend kept (the feet stay planted)

export class Victory {
  private move: Move | null = null;
  private t = 0;
  private wait = 0;
  private wp0 = 0;
  private readonly guard: Record<Side, ArmAngles> = { l: newArmAngles(), r: newArmAngles() };
  private readonly clipArm = newArmAngles();

  constructor(private readonly set: MocapSet, private readonly player: MotionPlayer) {}

  /** The design's library has a victory clip. */
  get available(): boolean {
    return (this.set.byLabel.get('victory')?.length ?? 0) > 0;
  }

  reset(): void {
    if (this.move) this.player.stop();
    this.move = null;
    this.wait = 0;
  }

  /** One control update: writes arm, neck and waist commands over the stance pose. */
  update(env: SkillEnv, dt: number): void {
    const p = this.player;
    if (!this.move) {
      this.wait -= dt;
      if (this.wait > 0) return;
      const moves = this.set.byLabel.get('victory') ?? [];
      if (!moves.length) return;
      this.move = moves[Math.min(moves.length - 1, Math.floor(env.rng() * moves.length))];
      p.play(this.move, { speed: 1, mask: 'upper', mirror: env.rng() < 0.5 });
      this.wp0 = p.q[env.jm.waistPitch];
      for (const side of SIDES) armIK(env.geo.arms[side], env.stance.guard[side].fist, env.stance.guard[side].pole, this.guard[side]);
      this.t = 0;
    }
    p.step(dt);
    this.t += dt;
    const m = this.move;
    const w = Math.min(minJerk(this.t / BLEND_S), minJerk((m.duration - p.tau) / BLEND_S));
    for (const side of SIDES) {
      const arm = env.cmd.arms[side];
      arm.mode = 'joints';
      lerpArm(this.guard[side], readArm(env, p.q, side, this.clipArm), w, arm.angles);
    }
    env.cmd.neckYaw += (p.q[env.jm.neckYaw] - env.cmd.neckYaw) * w;
    env.pose.waistPitch = env.stance.waistPitch + clamp(p.q[env.jm.waistPitch] - this.wp0, -WAIST_PITCH_MAX, WAIST_PITCH_MAX) * w;
    if (p.done) {
      this.move = null;
      this.wait = PAUSE_S;
    }
  }
}
