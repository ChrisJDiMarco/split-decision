// The fight-clean pass's pure pieces, without MuJoCo: the trunk style filter keeps a fast clip's dip and
// tilt inside what loaded feet can carry and lets a slow one through untouched; a catch step's
// never-cross rule works in the pelvis's frame, so a sole that has spun cannot turn "behind the body"
// into "in front of it".
import { describe, expect, it } from 'vitest';
import { constrainFrom } from '../../src/physics/control/balance/footsteps';
import { TRUNK_LIMIT, TrunkLimiter, type TrunkStyle } from '../../src/physics/control/balance/trunk-limit';
import { humanoidGeometry } from '../../src/physics/control/geometry';
import { design } from '../../src/robots/designs';

const DT = 0.002;
const G = 9.81;

function run(lim: TrunkLimiter, target: (t: number) => TrunkStyle, seconds: number): Array<{ t: number; out: TrunkStyle; want: TrunkStyle }> {
  const rows: Array<{ t: number; out: TrunkStyle; want: TrunkStyle }> = [];
  for (let t = 0; t <= seconds; t += DT) {
    const want = target(t);
    const out = { ...want };
    lim.apply(out, DT, false);
    rows.push({ t, out, want });
  }
  return rows;
}

describe('trunk style limiter', () => {
  const lim = () => new TrunkLimiter(85, 10.8, 5.4); // SAVATE's mass and upper-body inertias

  it('keeps a 2.5x clip dip inside the vertical acceleration loaded feet allow', () => {
    // A 6 cm dip and back in 0.12 s (an actor's 0.3 s dip played 2.5x): 33 m/s² as asked.
    const dip = (t: number) => (t < 0.06 ? 0.06 * Math.sin((Math.PI * t) / 0.12) : t < 0.12 ? 0.06 * Math.sin((Math.PI * t) / 0.12) : 0);
    const rows = run(lim(), (t) => ({ pelvisDrop: dip(t), pelvisPitch: 0, pelvisRoll: 0, waistBend: 0 }), 0.6);
    const cap = TRUNK_LIMIT.vertAccelG * G;
    for (let i = 2; i < rows.length; i++) {
      const a = (rows[i].out.pelvisDrop - 2 * rows[i - 1].out.pelvisDrop + rows[i - 2].out.pelvisDrop) / (DT * DT);
      expect(Math.abs(a)).toBeLessThanOrEqual(cap * 1.02);
    }
    // ...and the dip comes out shallower than asked, but it is still there (style kept, rate-limited).
    const peak = Math.max(...rows.map((r) => r.out.pelvisDrop));
    expect(peak).toBeLessThan(0.06);
    expect(peak).toBeGreaterThan(0.002);
  });

  it('lets a slow trunk motion through with little lag', () => {
    // A 3 cm dip over 1 s and a 0.05 rad tilt over 1.2 s: well inside the caps.
    const rows = run(lim(), (t) => ({ pelvisDrop: 0.015 * (1 - Math.cos((2 * Math.PI * t) / 1)), pelvisPitch: 0.025 * (1 - Math.cos((2 * Math.PI * t) / 1.2)), pelvisRoll: 0, waistBend: 0 }), 2);
    for (const r of rows.slice(50)) {
      expect(Math.abs(r.out.pelvisDrop - r.want.pelvisDrop)).toBeLessThan(0.002);
      expect(Math.abs(r.out.pelvisPitch - r.want.pelvisPitch)).toBeLessThan(0.004);
    }
  });

  it('caps the tilt acceleration at the COP budget over the upper body inertia', () => {
    const l = lim();
    const rows = run(l, (t) => ({ pelvisDrop: 0, pelvisPitch: t > 0.05 ? 0.15 : 0, pelvisRoll: 0, waistBend: t > 0.05 ? 0.2 : 0 }), 1);
    const capHip = (85 * G * TRUNK_LIMIT.tiltCopM) / 10.8, capWaist = (85 * G * TRUNK_LIMIT.tiltCopM) / 5.4;
    for (let i = 2; i < rows.length; i++) {
      const ap = (rows[i].out.pelvisPitch - 2 * rows[i - 1].out.pelvisPitch + rows[i - 2].out.pelvisPitch) / (DT * DT);
      const aw = (rows[i].out.waistBend - 2 * rows[i - 1].out.waistBend + rows[i - 2].out.waistBend) / (DT * DT);
      expect(Math.abs(ap)).toBeLessThanOrEqual(capHip * 1.02);
      expect(Math.abs(aw)).toBeLessThanOrEqual(capWaist * 1.02);
    }
    // It still gets there.
    expect(rows[rows.length - 1].out.pelvisPitch).toBeCloseTo(0.15, 2);
    expect(rows[rows.length - 1].out.waistBend).toBeCloseTo(0.2, 2);
  });

  it('passes a brace or the rise straight through', () => {
    const l = lim();
    const st: TrunkStyle = { pelvisDrop: 0, pelvisPitch: 0, pelvisRoll: 0, waistBend: 0 };
    l.apply(st, DT, false);
    const brace: TrunkStyle = { pelvisDrop: 0.25, pelvisPitch: 0.3, pelvisRoll: -0.2, waistBend: 0.5 };
    l.apply(brace, DT, true);
    expect(brace).toEqual({ pelvisDrop: 0.25, pelvisPitch: 0.3, pelvisRoll: -0.2, waistBend: 0.5 });
  });
});

describe('catch step never-cross frame', () => {
  const geo = humanoidGeometry(design('savate'));
  const L = geo.legLength;

  it('keeps the old behaviour in the stance foot frame by default', () => {
    const st = { x: 0, y: 0, yaw: 0 };
    // The right foot asked to land 0.3 m behind the left one, in line: pushed out to the right by the gap.
    const p = constrainFrom(geo, st, 'r', { x: -0.3, y: 0, yaw: 0 }, 0.7 * L);
    expect(p.x).toBeCloseTo(-0.3, 6);
    expect(p.y).toBeLessThan(0);
  });

  it('plans a catch step behind a body falling backward even off a sole spun 90°', () => {
    // The pelvis faces +x; the left (stance) sole has spun to face +y. The body falls backward (−x): the
    // right foot is wanted 0.3 m behind the stance foot. In the sole's own frame "behind the body" is "to
    // the sole's right", and the gap rule moved the landing to the far side; in the pelvis's frame it stays behind.
    const st = { x: 0, y: 0.1, yaw: Math.PI / 2 };
    const want = { x: -0.3, y: 0.0, yaw: 0 };
    const pelvis = constrainFrom(geo, st, 'r', want, 0.7 * L, 0);
    expect(pelvis.x).toBeLessThan(-0.25);
    expect(pelvis.y).toBeLessThan(st.y); // right of the stance foot, in the pelvis's frame
  });
});
