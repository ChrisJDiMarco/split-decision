// Hip and waist strategies. The ankle strategy (balance.ts) can only move the centre of pressure
// within the soles; once the capture point runs out past them, the body bends at the hips and
// the waist toward the fall. Swinging the upper body that way is a change of angular momentum
// about the COM, and its reaction at the feet pushes the COM back the other way (a person
// tipping onto their toes jack-knifes at the hips). The gyro core does the same job without
// moving the body and does it better (measured: bending on top of a working gyro loses push
// recovery, the bend also loads the planted feet sideways), so the bend takes over only as the
// gyro is damaged or shot away, and eases off again once the capture point is back over the feet.
import { clamp } from './math';
import type { Sense } from './sense';
import { polygonDistance, type P2 } from './support';

const HIP_GAIN = 1.2; // rad of pelvis tilt per metre of capture point outside the support
const HIP_MAX_RAD = 0.15;
const WAIST_GAIN = 0.8; // rad of extra waist pitch per metre (sagittal only: the waist has no roll)
const WAIST_MAX_RAD = 0.1;
const ENGAGE_TAU_S = 0.06; // bend quickly: the angular momentum comes from the bend's speed
const RELEASE_TAU_S = 0.35; // straighten slowly: a quick unbend pushes the COM back out
const GYRO_HEALTH_FROM = 0.5; // gyro health below which the bend starts to take over...
const GYRO_HEALTH_TO = 0.1; // ... and at which it is fully engaged

export interface UpperBodyBend {
  pitch: number; // pelvis pitch, forward +
  roll: number; // pelvis roll about the forward axis (+ tilts toward the right)
  waist: number; // extra waist pitch, forward +
}

export class UpperBodyStrategy {
  readonly bend: UpperBodyBend = { pitch: 0, roll: 0, waist: 0 };

  reset(): void {
    this.bend.pitch = 0;
    this.bend.roll = 0;
    this.bend.waist = 0;
  }

  /**
   * `heading`: the body's facing (the bend is split into its forward and lateral parts).
   * `gyroHealth`: 1 with an intact gyro core, 0 with none left.
   */
  update(s: Sense, support: P2[], heading: number, gyroHealth: number, dt: number): UpperBodyBend {
    const engage = clamp((GYRO_HEALTH_FROM - gyroHealth) / (GYRO_HEALTH_FROM - GYRO_HEALTH_TO), 0, 1);
    let fwd = 0, lat = 0;
    if (support.length >= 3 && engage > 0) {
      const { d, closest } = polygonDistance(support, [s.capture[0], s.capture[1]]);
      if (d > 0) {
        const ex = s.capture[0] - closest[0], ey = s.capture[1] - closest[1];
        const c = Math.cos(heading), sn = Math.sin(heading);
        fwd = engage * (ex * c + ey * sn);
        lat = engage * (-ex * sn + ey * c);
      }
    }
    const b = this.bend;
    b.pitch = approach(b.pitch, clamp(HIP_GAIN * fwd, -HIP_MAX_RAD, HIP_MAX_RAD), dt);
    b.roll = approach(b.roll, clamp(-HIP_GAIN * lat, -HIP_MAX_RAD, HIP_MAX_RAD), dt);
    b.waist = approach(b.waist, clamp(WAIST_GAIN * fwd, -WAIST_MAX_RAD, WAIST_MAX_RAD), dt);
    return b;
  }
}

/** First-order move toward `target`: fast while the bend grows, slow while it relaxes. */
function approach(cur: number, target: number, dt: number): number {
  const growing = Math.abs(target) > Math.abs(cur) && Math.sign(target) !== -Math.sign(cur);
  const tau = growing ? ENGAGE_TAU_S : RELEASE_TAU_S;
  return cur + (target - cur) * Math.min(1, dt / tau);
}
