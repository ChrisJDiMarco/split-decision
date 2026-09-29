// The analytic IK and FK must agree with MuJoCo's own kinematics for every humanoid design.
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/core/types';
import { humanoidGeometry, type Side } from '../../src/physics/control/geometry';
import { armFK, armIK, legFK, legIK, legIKPoint, newArmAngles, newLegAngles, type LegAngles } from '../../src/physics/control/ik';
import { mulMtM, mulMtV, readMat, readVec, sub } from '../../src/physics/control/math';
import { mulberry32 } from '../../src/physics/sim-context';
import { design } from '../../src/robots/designs';
import { makeSim } from './helpers';

const DESIGNS = ['bruiser', 'striker', 'goliath'];
// The MJCF compiler rounds geometry to 5 decimals, so FK vs MuJoCo agrees to ~1e-5 m.
const TOL = 1e-4;
const close = (a: Vec3, b: Vec3, tol: number) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < tol;

describe('limb kinematics match MuJoCo', () => {
  for (const id of DESIGNS) {
    it(`${id}: FK agrees with mj_kinematics and IK inverts FK`, async () => {
      const sim = await makeSim({ design: id, x: 0, y: 0, yaw: 0.3 }, { design: 'striker', x: 5, y: 0, yaw: 0 }, { systems: [] });
      const { ctx } = sim;
      const r = ctx.robots[0];
      const geo = humanoidGeometry(design(id));
      const rng = mulberry32(7);
      const rand = (lo: number, hi: number) => lo + (hi - lo) * rng();
      const setJ = (name: string, v: number) => { ctx.data.qpos[r.joints[r.jointIndex.get(name)!].qadr] = v; };
      for (let trial = 0; trial < 20; trial++) {
        const side: Side = trial % 2 ? 'l' : 'r';
        const leg: LegAngles = { hipYaw: rand(-0.5, 0.5), hipRoll: rand(-0.3, 0.3), hipPitch: rand(-1.2, 0.3), knee: rand(0.2, 1.8), anklePitch: rand(-0.6, 0.5), ankleRoll: rand(-0.4, 0.4) };
        const arm = { pitch: rand(-2, 0.5), roll: side === 'l' ? rand(0, 1.2) : rand(-1.2, 0), yaw: rand(-0.8, 0.8), elbow: rand(-2.2, -0.3) };
        setJ(`hip_yaw_${side}`, leg.hipYaw); setJ(`hip_roll_${side}`, leg.hipRoll); setJ(`hip_pitch_${side}`, leg.hipPitch);
        setJ(`knee_${side}`, leg.knee); setJ(`ankle_pitch_${side}`, leg.anklePitch); setJ(`ankle_roll_${side}`, leg.ankleRoll);
        setJ(`shoulder_pitch_${side}`, arm.pitch); setJ(`shoulder_roll_${side}`, arm.roll); setJ(`shoulder_yaw_${side}`, arm.yaw); setJ(`elbow_${side}`, arm.elbow);
        ctx.mj.mj_kinematics(ctx.model, ctx.data);
        const pel = r.parts.get('pelvis')!.body, foot = r.parts.get(`foot_${side}`)!.body;
        const torso = r.parts.get('torso')!.body, fist = r.parts.get(`fist_${side}`)!.body;
        const Rp = readMat(ctx.data.xmat, pel), Rt = readMat(ctx.data.xmat, torso);
        const ankleP = mulMtV(Rp, sub(readVec(ctx.data.xpos, foot), readVec(ctx.data.xpos, pel)));
        const footRotP = mulMtM(Rp, readMat(ctx.data.xmat, foot));
        const fistT = mulMtV(Rt, sub(readVec(ctx.data.xpos, fist), readVec(ctx.data.xpos, torso)));

        const fk = legFK(geo.legs[side], leg);
        expect(close(fk.ankle, ankleP, TOL)).toBe(true);
        for (let i = 0; i < 9; i++) expect(fk.footRot[i]).toBeCloseTo(footRotP[i], 4);
        expect(close(armFK(geo.arms[side], arm).fist, fistT, TOL)).toBe(true);

        const ik = legIK(geo.legs[side], ankleP, footRotP, newLegAngles());
        const back = legFK(geo.legs[side], ik);
        expect(close(back.ankle, ankleP, TOL)).toBe(true);
        for (let i = 0; i < 9; i++) expect(back.footRot[i]).toBeCloseTo(footRotP[i], 4);

        const knee = legFK(geo.legs[side], leg).knee;
        const pt = legIKPoint(geo.legs[side], ankleP, sub(knee, geo.legs[side].hip), newLegAngles());
        expect(close(legFK(geo.legs[side], { ...pt, anklePitch: 0, ankleRoll: 0 }).ankle, ankleP, TOL)).toBe(true);

        const elbowPos = armFK(geo.arms[side], arm).elbow;
        const a = newArmAngles();
        armIK(geo.arms[side], fistT, sub(elbowPos, geo.arms[side].shoulder), a);
        expect(close(armFK(geo.arms[side], a).fist, fistT, TOL)).toBe(true);
        expect(a.elbow).toBeCloseTo(arm.elbow, 3);
      }
      sim.dispose();
    });
  }
});
