// Standing up out of the get-up crouch. The feet are planted where the crouch left them and the
// balance controller runs as usual (the COM is steered over the soles through the pelvis); only
// the posture targets ease from the crouch to the fighting stance: pelvis height and attitude,
// waist and arms. Slow enough that a heavy torso unfolding does not throw the COM off the feet.
// Capture steps wait until the body is upright enough for a step to mean something.
import type { Vec3 } from '../../core/types';
import { SIDES, type Side } from './geometry';
import { clamp, lerp, minJerk, mix, slerpMat, type Mat3 } from './math';
import type { BodyCommand } from './posture';
import type { Sense } from './sense';
import type { SkillPose } from './skills/types';
import type { StanceParams } from './stance';

const STEP_FREE_AT = 0.7; // rise progress after which capture steps are allowed again

export class Rise {
  private t = 0;
  private dur: number;
  private drop0 = 0;
  private waist0 = 0;
  private rot0: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  private readonly fist0: Record<Side, Vec3> = { l: [0, 0, 0], r: [0, 0, 0] };
  active = false;

  /** `riseS`: seconds to stand up out of a full crouch (shallower starts take less). */
  constructor(private readonly riseS: number) {
    this.dur = riseS;
  }

  /** `fists`: where the fists are now, torso frame. */
  start(s: Sense, stance: StanceParams, waistPitch: number, fists: Record<Side, Vec3>): void {
    this.active = true;
    this.t = 0;
    this.drop0 = Math.max(0, stance.pelvisHeight - s.pelvisPos[2]);
    this.waist0 = waistPitch;
    this.rot0 = [...s.pelvisRot] as Mat3;
    for (const side of SIDES) this.fist0[side] = [...fists[side]] as Vec3;
    this.dur = this.riseS * (0.7 + 0.3 * clamp(this.drop0 / (0.4 * stance.pelvisHeight), 0, 1));
  }

  private progress(): number {
    return minJerk(this.t / this.dur);
  }

  /** Capture steps are held back while the body is still folded over its feet. */
  stepsAllowed(): boolean {
    return !this.active || this.t / this.dur >= STEP_FREE_AT;
  }

  /** Eases the posture toward the stance; the feet stay put until it is done. */
  apply(pose: SkillPose, cmd: BodyCommand, stance: StanceParams, dt: number): void {
    if (!this.active) return;
    this.t += dt;
    const k = this.progress();
    pose.pelvisDrop = this.drop0 * (1 - k);
    pose.waistPitch = lerp(this.waist0, stance.waistPitch, k);
    pose.holdFeet = true;
    for (const side of SIDES) cmd.arms[side].fist = mix(this.fist0[side], stance.guard[side].fist, k);
    if (this.t >= this.dur) this.active = false;
  }

  /** The pelvis attitude: from how the crouch left it to the stance attitude `target`. */
  rotation(target: Readonly<Mat3>): Mat3 {
    return this.active ? slerpMat(this.rot0, target, this.progress()) : [...target] as Mat3;
  }
}
