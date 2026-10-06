// The COM the posture tracks. Position servos in a closed chain (both feet down, stiff legs) move
// the body where the pelvis target is; feed-forward torque alone cannot choose how the load splits
// between the feet, so the centre of pressure cannot be commanded directly. The body is therefore
// driven along a COM reference that is itself an inverted pendulum under a pressure point the soles
// can deliver:
//   ξ_c = c_c + ċ_c/ω                                   the reference's own DCM
//   r   = r_ref + (1 + k_p/ω)(ξ_c − ξ_ref)              the DCM feedback law on the reference
//   COP = r clipped into the soles; the rest is the gyro's (within its reach)
//   c̈_c = ω²(c_c − COP − gyro share)                   so every planned COP is one the soles can make
// and leashed to the measured body (a push, a stumble: the reference re-plans from where the body
// is instead of dragging it back). While a leg swings, the body's velocity is the rest of the
// body's: the swinging leg's own momentum is internal and gone by touchdown, not a fall to react
// to. The pelvis target is the measured pelvis moved by the COM error, so a swinging leg's own
// share of the COM is taken up by the trunk, and the feed-forward carries the planned ground
// force: the servo springs only correct.
import type { Sense } from '../sense';
import { clampToPolygon, type P2 } from '../support';
import type { DcmSample } from './dcm';

/** Tunable (tools sweep it; the worker never changes it). */
export const COM_REF = {
  leashPosS: 0.25, // the reference position is pulled to the body with this time constant...
  leashVelS: 0.12, // ...and its velocity
  maxErrM: 0.06, // the reference never leads the body by more than this
  track: 1.0, // pelvis displacement per metre of COM error
  trackVel: 0.03, // ...and per m/s of COM velocity error (s)
  // The CMP never drives the body's own DCM away from the plan: once the body's DCM is this far from
  // the plan (m), the CMP is kept guardM behind it along the way it has to go (fully at +3 cm).
  guardFromM: 0.02,
  guardM: 0.01,
};

export class ComReference {
  readonly c: P2 = [0, 0];
  readonly v: P2 = [0, 0];
  readonly a: P2 = [0, 0];
  /** The reference's own DCM this tick. */
  readonly xi: P2 = [0, 0];
  primed = false;

  reset(s: Sense, vel: readonly number[] = s.comVel): void {
    this.c[0] = s.com[0];
    this.c[1] = s.com[1];
    this.v[0] = vel[0];
    this.v[1] = vel[1];
    this.a[0] = this.a[1] = 0;
    this.primed = true;
  }

  /**
   * One tick. `ref`: the plan's ξ_ref and r_ref. `gain`: 1 + k_p/ω. `support`: the soles (shrunk).
   * `gyroReach`: how far past the soles the gyro may carry the CMP right now (m). Writes the
   * commanded CMP, the COP and the gyro's share.
   */
  step(s: Sense, vel: P2, dt: number, ref: DcmSample, xiRef: P2, gain: number, support: P2[], gyroReach: number, cmp: P2, cop: P2, gyroShare: P2, xiBody?: P2): void {
    if (!this.primed) this.reset(s, vel);
    const w = s.omega0;
    // Leash to the body.
    const kc = Math.min(1, dt / COM_REF.leashPosS), kv = Math.min(1, dt / COM_REF.leashVelS);
    for (let i = 0; i < 2; i++) {
      this.c[i] += (s.com[i] - this.c[i]) * kc;
      this.v[i] += (vel[i] - this.v[i]) * kv;
      const e = this.c[i] - s.com[i];
      if (e > COM_REF.maxErrM) this.c[i] = s.com[i] + COM_REF.maxErrM;
      else if (e < -COM_REF.maxErrM) this.c[i] = s.com[i] - COM_REF.maxErrM;
      this.xi[i] = this.c[i] + this.v[i] / w;
      cmp[i] = ref.r[i] + gain * (this.xi[i] - xiRef[i]);
    }
    if (xiBody) guardCmp(cmp, xiBody, xiRef);
    const p = support.length >= 3 ? clampToPolygon(support, cmp) : cmp;
    cop[0] = p[0];
    cop[1] = p[1];
    let gx = cmp[0] - p[0], gy = cmp[1] - p[1];
    const n = Math.hypot(gx, gy);
    if (n > gyroReach) {
      gx *= gyroReach / n;
      gy *= gyroReach / n;
    }
    gyroShare[0] = gx;
    gyroShare[1] = gy;
    for (let i = 0; i < 2; i++) {
      this.a[i] = w * w * (this.c[i] - cop[i] - (i === 0 ? gx : gy));
      this.v[i] += this.a[i] * dt;
      this.c[i] += this.v[i] * dt;
    }
  }

  /** Horizontal pelvis target: the measured pelvis moved by the COM (and velocity) error. */
  pelvisTarget(s: Sense, vel: P2, out: P2): P2 {
    for (let i = 0; i < 2; i++) {
      out[i] = s.pelvisPos[i] + COM_REF.track * (this.c[i] - s.com[i]) + COM_REF.trackVel * (this.v[i] - vel[i]);
    }
    return out;
  }
}

/**
 * The reference model leads the body (its leash allows maxErrM), and its CMP is placed for its own
 * DCM. When the body's DCM lags the plan by more than a couple of centimetres, that CMP can land on
 * the far side of the body's DCM, and then it drives the body away from the plan (ξ̇ = ω(ξ − CMP))
 * while the reference waits for it: a stall that ends in a re-plan or a capture step. So the CMP is
 * held guardM behind the body's own DCM along the way the body has to go.
 */
function guardCmp(cmp: P2, xiBody: P2, xiRef: P2): void {
  const dx = xiRef[0] - xiBody[0], dy = xiRef[1] - xiBody[1];
  const d = Math.hypot(dx, dy);
  const k = Math.min(1, Math.max(0, (d - COM_REF.guardFromM) / 0.01));
  if (k <= 0) return;
  const ux = dx / d, uy = dy / d;
  const ahead = (cmp[0] - xiBody[0]) * ux + (cmp[1] - xiBody[1]) * uy + COM_REF.guardM;
  if (ahead <= 0) return;
  cmp[0] -= k * ahead * ux;
  cmp[1] -= k * ahead * uy;
}
