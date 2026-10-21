// Actuator variants of the modern designs, for A/B runs (docs/research/08-modern-roster.md: a joint
// whose real motor is the bottleneck may get a stronger catalogued module). A variant rebuilds the
// design from its builder spec with some joint groups on other catalog motors and puts it in the
// roster for this process only: every sim made afterwards (tests/control/helpers.ts makeSim, the
// centroid tables) compiles the variant. The game never reads this.
//
//   'savate.elbow=qdd.rs06x2,savate.waistYaw=qdd.ake90x2,haymaker.hipPitch=qdd.ake90x3'
//   keys: leg knee arm elbow waist neck shoulderPitch waistYaw hipPitch hipYaw hipRoll ankle ankleRoll
//   (HumanoidSpec.motors)
//
// Run directly, it is the gantry A/B (docs/design/robot-realism-pass.md): each design hung on its
// gantry, controller off, joint targets stepped at full power, servo damping as built (1) and at the
// strike drive's burst (0.15, src/physics/control/strike-drive.ts BURST.damp). Peak speed of the
// striking surface (the tip part's geom centre: glove or knuckle block, foot box, mid-shin), the
// time to it, each moving joint's peak speed against its motor's no-load speed, and for the snaps
// (elbow, knee) the time to 90% of the extension. A static row per design gives the compiled masses,
// the standing COM height and the joint-space inertia (MuJoCo's mass matrix diagonal, armature
// included) of the main joints in the stance pose.
//
//   npx tsx tools/motor-variants.ts --gantry [--designs firecracker,savate,haymaker,pylon]
//     [--motors 'firecracker.hipPitch=qdd.rs04,firecracker.hipRoll=qdd.rs04'] [--damp 1,0.15]
//     [--throws 'knee snap,front snap'] [--label name] [--out file.json]
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { motor } from '../src/robots/catalog';
import { DESIGNS, MODERN_SPECS } from '../src/robots/designs';
import { buildHumanoid, type HumanoidSpec } from '../src/robots/humanoid';

type MotorKey = keyof HumanoidSpec['motors'];
const KEYS: readonly MotorKey[] = ['leg', 'knee', 'arm', 'elbow', 'waist', 'neck', 'shoulderPitch', 'waistYaw', 'hipPitch', 'hipYaw', 'hipRoll', 'ankle', 'ankleRoll'];

/** Parse a variant string into per-design motor overrides. */
export function parseMotorVariants(spec: string): Record<string, Partial<HumanoidSpec['motors']>> {
  const out: Record<string, Partial<HumanoidSpec['motors']>> = {};
  for (const item of spec.split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^([a-z]+)\.([A-Za-z]+)=([\w.]+)$/.exec(item);
    if (!m) throw new Error(`motor variant: cannot parse '${item}' (want design.key=motor)`);
    const [, id, key, motorId] = m;
    if (!MODERN_SPECS[id]) throw new Error(`motor variant: '${id}' is not a modern design`);
    if (!KEYS.includes(key as MotorKey)) throw new Error(`motor variant: unknown joint group '${key}'`);
    motor(motorId); // throws on an unknown motor
    (out[id] ??= {})[key as MotorKey] = motorId;
  }
  return out;
}

/** Put the variants in the roster (this process). Returns the designs it rebuilt. */
export function applyMotorVariants(spec: string | undefined): string[] {
  if (!spec) return [];
  const v = parseMotorVariants(spec);
  for (const [id, motors] of Object.entries(v)) {
    const base = MODERN_SPECS[id];
    DESIGNS[id] = buildHumanoid({ ...base, motors: { ...base.motors, ...motors } });
  }
  return Object.keys(v);
}

// ---------------------------------------------------------------- gantry A/B (CLI)

interface Throw {
  name: string;
  tip: string;
  start: Record<string, number>;
  end: Record<string, number>;
  /** A snap: report the time this joint takes to cover 90% of its step. */
  snap?: string;
}

/** Right-side throws (roll and yaw signs as the right side's mirrored ranges). */
const THROWS: Throw[] = [
  { name: 'straight arm', tip: 'fist_r', start: {}, end: { shoulder_pitch_r: -1.6, elbow_r: -0.15, shoulder_yaw_r: 0 } },
  { name: 'straight arm + waist', tip: 'fist_r', start: { waist_yaw: -0.25 }, end: { shoulder_pitch_r: -1.6, elbow_r: -0.15, shoulder_yaw_r: 0, waist_yaw: 0.6 } },
  { name: 'hook arm + waist', tip: 'fist_r', start: { shoulder_pitch_r: -1.3, shoulder_roll_r: -1.2, elbow_r: -1.5, waist_yaw: -0.3 }, end: { shoulder_pitch_r: -1.5, shoulder_roll_r: -1.2, elbow_r: -1.5, shoulder_yaw_r: 0.9, waist_yaw: 0.7 } },
  { name: 'elbow snap', tip: 'fist_r', start: { shoulder_pitch_r: -1.5, elbow_r: -2.0 }, end: { shoulder_pitch_r: -1.5, elbow_r: -0.1 }, snap: 'elbow_r' },
  { name: 'front snap', tip: 'foot_r', start: { hip_pitch_r: -1.4, knee_r: 2.0 }, end: { hip_pitch_r: -1.6, knee_r: 0.1 } },
  { name: 'leg swing', tip: 'shin_r', start: { hip_pitch_r: 0.25, knee_r: 1.2 }, end: { hip_pitch_r: -1.5, knee_r: 0.15 } },
  { name: 'knee snap', tip: 'foot_r', start: { hip_pitch_r: -1.57, knee_r: 1.57, ankle_pitch_r: 0 }, end: { hip_pitch_r: -1.57, knee_r: 0, ankle_pitch_r: 0 }, snap: 'knee_r' },
  { name: 'hip roll lift', tip: 'foot_r', start: { knee_r: 0.1, ankle_pitch_r: 0 }, end: { hip_roll_r: -1.0, knee_r: 0.1, ankle_pitch_r: 0 } },
  { name: 'hip yaw turn', tip: 'foot_r', start: { hip_pitch_r: -1.2, knee_r: 1.4, hip_yaw_r: 0.5 }, end: { hip_pitch_r: -1.2, knee_r: 1.4, hip_yaw_r: -0.6 } },
];

const STATIC_JOINTS = ['hip_pitch_r', 'hip_roll_r', 'hip_yaw_r', 'knee_r', 'ankle_pitch_r', 'ankle_roll_r', 'waist_yaw', 'waist_pitch', 'shoulder_pitch_r', 'elbow_r'];

function cliArg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function gantryCli(): Promise<void> {
  // Heavy imports only here, so the tools that import the variant helpers stay light.
  const { makeSim, comPos } = await import('../tests/control/helpers');
  const { motorSystem } = await import('../src/physics/systems/motors');
  type Sim = Awaited<ReturnType<typeof makeSim>>;
  const variants = cliArg('motors', '');
  applyMotorVariants(variants);
  const designs = cliArg('designs', Object.keys(MODERN_SPECS).join(',')).split(',');
  const damps = cliArg('damp', '1,0.15').split(',').map(Number);
  const pick = cliArg('throws', '').split(',').map((s) => s.trim()).filter(Boolean);
  const throws = pick.length ? THROWS.filter((t) => pick.includes(t.name)) : THROWS;
  const label = cliArg('label', variants || 'as built');
  const rows: Array<Record<string, unknown>> = [];
  const lines: string[] = [`gantry A/B (${label})`];

  const stanceOf = (sim: Sim) => {
    const r = sim.ctx.robots[0];
    return Float64Array.from(r.joints, (j) => r.design.stance[j.name] ?? 0);
  };
  const setNamed = (sim: Sim, arr: Float64Array, o: Record<string, number>) => {
    const r = sim.ctx.robots[0];
    for (const [k, v] of Object.entries(o)) {
      const i = r.jointIndex.get(k);
      if (i !== undefined) arr[i] = v;
    }
  };
  const newSim = (design: string) => makeSim({ design, x: 0, y: 0, yaw: 0 }, { design, x: 8, y: 0, yaw: Math.PI }, { systems: [motorSystem] });

  for (const design of designs) {
    // ---- static: masses, standing COM, joint-space inertia in the stance pose
    {
      const sim = await newSim(design);
      const { ctx } = sim;
      const r = ctx.robots[0];
      for (const rr of ctx.robots) rr.targets.set(Float64Array.from(rr.joints, (j) => rr.design.stance[j.name] ?? 0));
      sim.seconds(1.0);
      const m = ctx.model, d = ctx.data;
      const nv = m.nv as number;
      const full = new ctx.mj.DoubleBuffer(nv * nv);
      ctx.mj.mj_fullM(m, d, full);
      const M = full.GetView() as Float64Array;
      const inertia: Record<string, number> = {};
      const armature: Record<string, number> = {};
      for (const name of STATIC_JOINTS) {
        const i = r.jointIndex.get(name);
        if (i === undefined) continue;
        const dof = r.joints[i].dadr;
        inertia[name] = +M[dof * nv + dof].toFixed(4);
        armature[name] = +(m.dof_armature[dof] as number).toFixed(4);
      }
      full.delete();
      // Standing COM height above the soles (the stance pose keeps the feet parallel to the pelvis).
      const gz = d.geom_xpos as Float64Array;
      const soles = ['foot_l', 'foot_r'].map((p) => {
        const part = r.compiled.parts.find((x) => x.id === p)!;
        const g = m.geom(part.geomNames[0]).id as number;
        return gz[g * 3 + 2] - (m.geom_size[g * 3 + 2] as number);
      });
      const comZ = comPos(ctx, r)[2] - Math.min(...soles);
      const parts = Object.fromEntries(r.compiled.parts.map((p) => [p.id, +p.massKg.toFixed(2)]));
      const row = { mode: 'static', design, massKg: +r.compiled.totalMassKg.toFixed(2), comZ: +comZ.toFixed(3), parts, inertia, armature };
      rows.push(row);
      lines.push(`${design}: ${row.massKg} kg, standing COM ${row.comZ} m; parts ${Object.entries(parts).filter(([k]) => !k.endsWith('_l')).map(([k, v]) => `${k.replace(/_r$/, '')} ${v}`).join(', ')}`);
      lines.push(`  M diag (kg·m², armature in brackets): ${Object.entries(inertia).map(([k, v]) => `${k} ${v} (${armature[k]})`).join(', ')}`);
      sim.dispose();
    }
    // ---- throws
    for (const th of throws) {
      const parts: string[] = [];
      for (const damp of damps) {
        const sim = await newSim(design);
        const { ctx } = sim;
        const r = ctx.robots[0];
        for (const rr of ctx.robots) rr.targets.set(Float64Array.from(rr.joints, (j) => rr.design.stance[j.name] ?? 0));
        const startT = stanceOf(sim);
        setNamed(sim, startT, th.start);
        r.targets.set(startT);
        sim.seconds(1.2);
        const moving = Object.keys(th.end).map((k) => r.jointIndex.get(k)).filter((i): i is number => i !== undefined);
        const ds = new Float64Array(r.joints.length).fill(1);
        for (const i of moving) ds[i] = damp;
        r.mem.dampScale = ds;
        const goal = Float64Array.from(startT);
        setNamed(sim, goal, th.end);
        r.targets.set(goal);
        const part = r.compiled.parts.find((p) => p.id === th.tip)!;
        const g = ctx.model.geom(part.geomNames[0]).id as number;
        // A fresh view every read: a view held across steps goes stale if the WASM heap grows.
        const tipPos = () => { const gx = ctx.data.geom_xpos as Float64Array; return [gx[g * 3], gx[g * 3 + 1], gx[g * 3 + 2]]; };
        let prev = tipPos();
        let vPk = 0, tPk = 0;
        const frac: Record<string, number> = {};
        const snapI = th.snap ? r.jointIndex.get(th.snap) : undefined;
        const q0 = snapI !== undefined ? (ctx.data.qpos[r.joints[snapI].qadr] as number) : 0;
        const qGoal = snapI !== undefined ? goal[snapI] : 0;
        let t90 = NaN, snapPk = 0;
        const t0 = ctx.time;
        for (let k = 0; k < 600; k++) {
          sim.step();
          const p = tipPos();
          const v = Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]) / ctx.dt;
          prev = p;
          if (v > vPk) { vPk = v; tPk = ctx.time - t0; }
          for (const i of moving) {
            const j = r.joints[i];
            frac[j.name] = Math.max(frac[j.name] ?? 0, Math.abs(ctx.data.qvel[j.dadr] as number) / j.motor.noLoadSpeedRadS);
          }
          if (snapI !== undefined) {
            const j = r.joints[snapI];
            snapPk = Math.max(snapPk, Math.abs(ctx.data.qvel[j.dadr] as number));
            const q = ctx.data.qpos[j.qadr] as number;
            if (Number.isNaN(t90) && Math.abs(q - qGoal) <= 0.1 * Math.abs(q0 - qGoal)) t90 = ctx.time - t0;
          }
        }
        const row: Record<string, unknown> = {
          mode: 'gantry', design, throw: th.name, tip: th.tip, servoDamping: damp, vPeak: +vPk.toFixed(2), tPeakS: +tPk.toFixed(3),
          jointPeakFracNoLoad: Object.fromEntries(Object.entries(frac).map(([k, v]) => [k, +v.toFixed(2)])),
        };
        if (snapI !== undefined) Object.assign(row, { snapJoint: th.snap, t90S: Number.isNaN(t90) ? null : +t90.toFixed(3), snapPeakRadS: +snapPk.toFixed(1), snapNoLoadRadS: +r.joints[snapI].motor.noLoadSpeedRadS.toFixed(1) });
        rows.push(row);
        parts.push(`d${damp} ${vPk.toFixed(2)} m/s @${(tPk * 1000).toFixed(0)} ms${snapI !== undefined ? ` (t90 ${Number.isNaN(t90) ? '-' : (t90 * 1000).toFixed(0)} ms, ${snapPk.toFixed(1)} rad/s)` : ''}`);
        sim.dispose();
      }
      lines.push(`  ${th.name.padEnd(21)} ${parts.join('   ')}`);
    }
  }
  console.log(lines.join('\n'));
  const out = cliArg('out', '');
  if (out) writeFileSync(out, JSON.stringify({ tool: 'motor-variants --gantry', label, variants, designs, damps, rows }, null, 1));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes('--gantry')) await gantryCli();
