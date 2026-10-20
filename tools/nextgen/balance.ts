// The one balance law every Phase 0 variant gets (holds and pivots): keep the whole-body COM's ground
// projection where the kinematic plan puts it over the support sole, by adding small corrections to
// a few support joints. The correction is a weighted damped least-squares step through the COM
// Jacobian (∂COM/∂q with the sole planted, from Kin), so it works the same for either hip layout.
// Errors are measured in the gravity frame (the support foot's heading, not its tilt), so a foot
// that starts to roll over shows up as error instead of hiding in the foot frame.
import { apply, sub, tr, type V3 } from './math3';
import { Kin, liveSole } from './kin';
import { setTargets, type VSim } from './sim';

export interface BalanceGains { kp: number; kd: number; ki: number }
export const DEFAULT_GAINS: BalanceGains = {
  kp: Number(process.env.NG_KP ?? 1.0), kd: Number(process.env.NG_KD ?? 0.25), ki: Number(process.env.NG_KI ?? 0.5),
};

/** COM ground offset from the support sole centre in the sole's heading frame (x forward, y left). */
export function liveComOffset(sim: VSim, support: 'l' | 'r'): V3 {
  const { sole, F } = liveSole(sim, support);
  const yaw = Math.atan2(F[3], F[0]);
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const H = [c, -s, 0, s, c, 0, 0, 0, 1];
  const rc = sim.r.rootBody * 3, sc = sim.ctx.data.subtree_com;
  return apply(tr(H), sub([sc[rc], sc[rc + 1], sc[rc + 2]], sole));
}

export class ComBalance {
  private integ: [number, number] = [0, 0];
  private prev: [number, number] | null = null;
  private eDot: [number, number] = [0, 0];
  constructor(private readonly sim: VSim, private readonly kin: Kin, readonly support: 'l' | 'r', readonly joints: string[], readonly weights: number[], readonly gains: BalanceGains = DEFAULT_GAINS) {}

  /** ∂(COM xy in the sole frame)/∂q for the balance joints, central differences at q. */
  jacobian(q: Record<string, number>): number[][] {
    const h = 1e-4;
    const J = [this.joints.map(() => 0), this.joints.map(() => 0)];
    this.joints.forEach((n, i) => {
      const a = this.kin.eval({ ...q, [n]: q[n] + h }).com, b = this.kin.eval({ ...q, [n]: q[n] - h }).com;
      J[0][i] = (a[0] - b[0]) / (2 * h);
      J[1][i] = (a[1] - b[1]) / (2 * h);
    });
    return J;
  }

  private dls(J: number[][], u: [number, number], lambda = 1e-4): number[] {
    const Winv = this.weights.map((w) => 1 / w);
    const A = [[0, 0], [0, 0]];
    for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) A[r][c] = J[r].reduce((s, _, i) => s + J[r][i] * Winv[i] * J[c][i], 0) + (r === c ? lambda : 0);
    const det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
    const y = [(A[1][1] * u[0] - A[0][1] * u[1]) / det, (-A[1][0] * u[0] + A[0][0] * u[1]) / det];
    return this.joints.map((_, i) => Winv[i] * (J[0][i] * y[0] + J[1][i] * y[1]));
  }

  /**
   * One control tick (call every `dtCtl` seconds): plan pose q (joint targets), its planned COM in the
   * sole frame, the Jacobian to use and a 0..1 gain. Writes q + correction to the servos.
   */
  tick(q: Record<string, number>, plannedCom: V3, J: number[][], gain: number, dtCtl: number, opts: { joints?: string[]; mirror?: Record<string, string>; integrate?: boolean } = {}): [number, number] {
    const com = liveComOffset(this.sim, this.support);
    const e: [number, number] = [com[0] - plannedCom[0], com[1] - plannedCom[1]];
    if (this.prev) this.eDot = [0.7 * this.eDot[0] + 0.3 * (e[0] - this.prev[0]) / dtCtl, 0.7 * this.eDot[1] + 0.3 * (e[1] - this.prev[1]) / dtCtl];
    this.prev = e;
    // The integrator only runs at full gain (single support), so the weight shift cannot wind it up.
    if (gain >= 1 && opts.integrate !== false) this.integ = [this.integ[0] + e[0] * dtCtl, this.integ[1] + e[1] * dtCtl];
    const g = this.gains;
    const u: [number, number] = [-(g.kp * e[0] + g.kd * this.eDot[0] + g.ki * this.integ[0]) * gain, -(g.kp * e[1] + g.kd * this.eDot[1] + g.ki * this.integ[1]) * gain];
    // A subset of the joints (e.g. ankles only in double support): zero the others' columns.
    const use = opts.joints ? this.joints.map((n) => opts.joints!.includes(n)) : this.joints.map(() => true);
    const Ju = J.map((row) => row.map((x, i) => (use[i] ? x : 0)));
    const dq = this.dls(Ju, u);
    const out = { ...q };
    this.joints.forEach((n, j) => {
      if (!use[j]) return;
      out[n] = (out[n] ?? 0) + dq[j];
      // Double support: the other ankle turns the same way, so both shins tilt as a parallelogram.
      const m = opts.mirror?.[n];
      if (m) out[m] = (out[m] ?? 0) + dq[j];
    });
    setTargets(this.sim.r, out);
    return e;
  }
}
