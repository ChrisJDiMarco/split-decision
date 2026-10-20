// Sanity checks for the Phase 0 variant builder (fast, one process):
//   npx tsx tools/nextgen/check.ts
//  · variant A compiles to SAVATE's exact MJCF, and SAVATE still matches the NEXT GEN lock fixture
//  · every variant compiles and loads in MuJoCo; total masses
//  · the hip forward kinematics in hipik.ts match MuJoCo's body frames for both layouts
//  · the tilted layout's right leg is the mirror image of its left
//  · the §4.2 closed-form hip IK (hipik.ts ikHip) round-trips through the FK, both layouts and sides
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { compileRobot } from '../../src/robots/compile-mjcf';
import { design } from '../../src/robots/designs';
import { fkHip, ikHip, type Side } from './hipik';
import { DEG, mul, rotAngle, tr, xmatAt, v3At } from './math3';
import { makeVSim, placeJoints, bodyId } from './sim';
import { buildVariant, VARIANTS } from './variants';

const xmlOf = (d: Parameters<typeof compileRobot>[0]) => {
  const c = compileRobot(d, 0, { pos: [-1.5, 0.25, 1.1], yaw: 0 });
  return { xml: [c.bodyXml, c.debrisXml, c.actuatorXml, c.tendonXml, c.equalityXml, c.sensorXml].join('\n'), mass: c.totalMassKg };
};
let fail = 0;
const ok = (cond: boolean, msg: string) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) fail++; };

const A = buildVariant('A');
const lock = JSON.parse(readFileSync(new URL('../../tests/nextgen/fixtures/modern-mjcf.json', import.meta.url), 'utf8'));
const sha = (x: string) => createHash('sha256').update(x).digest('hex');
ok(sha(xmlOf(A.design).xml) === lock.designs['savate/0'].sha256, 'variant A compiles to the locked SAVATE MJCF (tests/nextgen/fixtures/modern-mjcf.json)');
const live = sha(xmlOf(design('savate')).xml) === lock.designs['savate/0'].sha256;
console.log(`info live src/robots/designs SAVATE ${live ? 'still matches' : 'NO LONGER matches'} the lock (another build's deliberate change moves it; Phase 0 uses the frozen base)`);

for (const id of VARIANTS) {
  const v = buildVariant(id);
  const c = xmlOf(v.design);
  const sim = await makeVSim(v, { lift: 0.4 });
  const nb = sim.ctx.model.nbody;
  console.log(`     ${v.label.padEnd(3)} ${c.mass.toFixed(2)} kg, ${v.design.parts.length} parts, ${nb} bodies, layout ${v.layout}; ${v.notes.join('; ')}`);
  // FK check at random hip angles inside range, both sides.
  let worst = 0;
  for (let t = 0; t < 20; t++) {
    for (const s of ['l', 'r'] as Side[]) {
      const q = { p: (-60 + 100 * ((t * 37) % 11) / 10) * DEG, r: (-20 + 60 * ((t * 13) % 7) / 6) * DEG * (s === 'l' ? 1 : -1), y: (-30 + 80 * ((t * 7) % 5) / 4) * DEG * (s === 'l' ? 1 : -1) };
      placeJoints(sim, { [`hip_pitch_${s}`]: q.p, [`hip_roll_${s}`]: q.r, [`hip_yaw_${s}`]: q.y });
      sim.mj.mj_kinematics(sim.ctx.model, sim.ctx.data);
      const P = xmatAt(sim.ctx.data.xmat, bodyId(sim, 'pelvis'));
      const T = xmatAt(sim.ctx.data.xmat, bodyId(sim, `thigh_${s}`));
      worst = Math.max(worst, rotAngle(mul(tr(P), T), fkHip(v.layout, s, q)));
    }
  }
  ok(worst < 1e-6, `${v.label} hip FK matches MuJoCo (worst ${(worst / DEG).toExponential(2)}°)`);
  if (v.layout === 'tilted') {
    // Mirror: left (p, r, y) and right (p, −r, −y) put the feet at mirrored places.
    placeJoints(sim, { hip_pitch_l: -0.9, hip_roll_l: 0.5, hip_yaw_l: 0.4, knee_l: 0.7, hip_pitch_r: -0.9, hip_roll_r: -0.5, hip_yaw_r: -0.4, knee_r: 0.7 });
    sim.mj.mj_kinematics(sim.ctx.model, sim.ctx.data);
    const pel = v3At(sim.ctx.data.xpos, bodyId(sim, 'pelvis'));
    const fl = v3At(sim.ctx.data.xpos, bodyId(sim, 'foot_l'));
    const fr = v3At(sim.ctx.data.xpos, bodyId(sim, 'foot_r'));
    const err = Math.hypot(fl[0] - fr[0], (fl[1] - pel[1]) + (fr[1] - pel[1]), fl[2] - fr[2]);
    ok(err < 1e-9, `${v.label} tilted hip mirrors left/right (foot error ${err.toExponential(2)} m)`);
  }
  sim.dispose();
}
// §4.2 closed-form IK round trip (the Phase 1 gate check, run early): random hip angles inside the
// NEXT GEN ranges, kept 5° clear of the tilted roll-75° lock.
let seed = 1;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
for (const layout of ['stock', 'tilted'] as const) {
  for (const s of ['l', 'r'] as Side[]) {
    const sg = s === 'l' ? 1 : -1;
    let worstR = 0, worstQ = 0, n = 0;
    while (n < 5000) {
      const q = { p: (-150 + 210 * rnd()) * DEG, r: sg * (-30 + 100 * rnd()) * DEG, y: sg * (-80 + 160 * rnd()) * DEG };
      if (layout === 'tilted' && Math.abs(sg * q.r - 75 * DEG) < 5 * DEG) continue;
      const R = fkHip(layout, s, q);
      const k = ikHip(layout, s, R);
      worstR = Math.max(worstR, rotAngle(fkHip(layout, s, k), R));
      worstQ = Math.max(worstQ, Math.abs(k.p - q.p), Math.abs(k.r - q.r), Math.abs(k.y - q.y));
      n++;
    }
    ok(worstR < 1e-6 && worstQ < 1e-9, `${layout} ${s} closed-form hip IK round-trips (rotation ${worstR.toExponential(1)} rad, angles ${worstQ.toExponential(1)} rad)`);
  }
}
process.exit(fail ? 1 : 0);
