// Robot design → MJCF fragments. Pure function, no MuJoCo dependency, unit-testable.
import type { Corner, GeomDef, PartDef, Quat, RobotDesign, Vec3 } from '../core/types';
import { INTERNAL_FILL_KG_M3, MATERIALS, SOLID_FILL, WALL_MM, motor } from './catalog';

export const COLLIDE = { WORLD: 1, R0: 2, R1: 4, DEBRIS: 8 } as const;

export function robotContype(corner: Corner): number {
  return corner === 0 ? COLLIDE.R0 : COLLIDE.R1;
}
export function robotConaffinity(corner: Corner): number {
  return COLLIDE.WORLD | (corner === 0 ? COLLIDE.R1 : COLLIDE.R0) | COLLIDE.DEBRIS;
}
export const DEBRIS_CONTYPE = COLLIDE.DEBRIS;
export const DEBRIS_CONAFFINITY = COLLIDE.WORLD | COLLIDE.R0 | COLLIDE.R1 | COLLIDE.DEBRIS;

export interface CompiledJoint {
  name: string; // design-level name, e.g. 'knee_l'
  mjName: string; // prefixed name in the model
  part: string;
  motor: string;
  kp: number;
  kd: number;
  hydraulicCircuit?: string;
}

/** A fixed tendon and the drive on it (the grip of a dexterous hand). */
export interface CompiledTendon {
  id: string; // design-level id, e.g. 'grip_l'
  mjName: string;
  actuator: string; // actuator name in the model
  motor: string;
  joints: string[]; // prefixed passive joint names
}

export interface CompiledPart {
  id: string;
  body: string; // attached body name
  debrisBody: string | null;
  geomNames: string[];
  debrisGeomNames: string[];
  massKg: number;
}

export interface CompiledRobot {
  corner: Corner;
  prefix: string;
  design: RobotDesign;
  bodyXml: string; // robot tree, goes inside <worldbody>
  debrisXml: string; // parked detachable copies, go inside <worldbody>
  actuatorXml: string; // joint servos, then tendon drives
  /** Fixed tendons, go inside <tendon> (empty when the design has none). */
  tendonXml: string;
  equalityXml: string; // gantry + parking welds
  sensorXml: string;
  parts: CompiledPart[];
  joints: CompiledJoint[]; // servo joints only (passive tendon joints are in `tendons`)
  tendons: CompiledTendon[];
  totalMassKg: number;
  gantryWeld: string;
  parkingWelds: Record<string, string>; // part id → weld name
}

const f = (n: number) => Number(n.toFixed(5)).toString();
const v3 = (v: Vec3) => `${f(v[0])} ${f(v[1])} ${f(v[2])}`;
const q4 = (q: Quat) => `${f(q[0])} ${f(q[1])} ${f(q[2])} ${f(q[3])}`;

function len(a: Vec3, b: Vec3): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

export function geomVolume(g: GeomDef): number {
  const s = g.shape;
  switch (s.type) {
    case 'box': return 8 * s.halfSize[0] * s.halfSize[1] * s.halfSize[2];
    case 'sphere': return (4 / 3) * Math.PI * s.radius ** 3;
    case 'capsule': return Math.PI * s.radius ** 2 * len(s.from, s.to) + (4 / 3) * Math.PI * s.radius ** 3;
    case 'cylinder': return Math.PI * s.radius ** 2 * len(s.from, s.to);
  }
}

export function geomArea(g: GeomDef): number {
  const s = g.shape;
  switch (s.type) {
    case 'box': {
      const [x, y, z] = s.halfSize;
      return 8 * (x * y + y * z + x * z);
    }
    case 'sphere': return 4 * Math.PI * s.radius ** 2;
    case 'capsule': return 2 * Math.PI * s.radius * len(s.from, s.to) + 4 * Math.PI * s.radius ** 2;
    case 'cylinder': return 2 * Math.PI * s.radius * len(s.from, s.to) + 2 * Math.PI * s.radius ** 2;
  }
}

export function geomMass(g: GeomDef): number {
  if (g.massKg !== undefined) return g.massKg;
  const density = MATERIALS[g.material].densityKgM3;
  const solid = SOLID_FILL[g.role];
  if (solid !== undefined) return geomVolume(g) * density * solid;
  const wall = (WALL_MM[g.role] ?? 4) / 1000;
  return geomArea(g) * wall * density + geomVolume(g) * INTERNAL_FILL_KG_M3;
}

function partMotorMass(p: PartDef): number {
  // A passive (tendon-driven) joint has no motor of its own: its drive is weighed with the design.
  return (p.joints ?? []).reduce((sum, j) => sum + (j.passive ? 0 : motor(j.motor).massKg), 0);
}

/** Smallest geom mass MuJoCo gets (a finger phalanx is ~20 g; every older geom is far above this). */
const MIN_GEOM_MASS_KG = 0.005;

function geomXml(name: string, g: GeomDef, mass: number, contype: number, conaffinity: number, offset?: { pos: Vec3; quat: Quat }): string {
  const s = g.shape;
  const mat = MATERIALS[g.material];
  const condim = g.role === 'foot' || g.role === 'wheel' ? 4 : 3;
  const common = `mass="${f(Math.max(mass, MIN_GEOM_MASS_KG))}" friction="${f(mat.friction)} 0.005 0.0001" condim="${condim}" contype="${contype}" conaffinity="${conaffinity}" solref="0.004 1" solimp="0.92 0.97 0.002"`;
  const tx = (p: Vec3): Vec3 => (offset ? addV(offset.pos, rotate(offset.quat, p)) : p);
  const quatAttr = (q?: Quat) => {
    const qq = offset ? (q ? mulQ(offset.quat, q) : offset.quat) : q;
    return qq ? ` quat="${q4(qq)}"` : '';
  };
  switch (s.type) {
    case 'box':
      return `<geom name="${name}" type="box" size="${v3(s.halfSize)}" pos="${v3(tx(g.pos ?? [0, 0, 0]))}"${quatAttr(g.quat)} ${common}/>`;
    case 'sphere':
      return `<geom name="${name}" type="sphere" size="${f(s.radius)}" pos="${v3(tx(g.pos ?? [0, 0, 0]))}" ${common}/>`;
    case 'capsule':
    case 'cylinder': {
      const a = tx(s.from);
      const b = tx(s.to);
      return `<geom name="${name}" type="${s.type}" fromto="${v3(a)} ${v3(b)}" size="${f(s.radius)}" ${common}/>`;
    }
  }
}

// ---------------------------------------------------------------- small math (no three.js in the worker)

export function mulQ(a: Quat, b: Quat): Quat {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
export function rotate(q: Quat, v: Vec3): Vec3 {
  const [w, x, y, z] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}
export function addV(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

// ---------------------------------------------------------------- compiler

export interface Placement {
  pos: Vec3; // root spawn position
  yaw: number; // heading, radians
}

export function compileRobot(design: RobotDesign, corner: Corner, placement: Placement): CompiledRobot {
  validate(design);
  const prefix = corner === 0 ? 'r0_' : 'r1_';
  const contype = robotContype(corner);
  const conaff = robotConaffinity(corner);
  const byId = new Map(design.parts.map((p) => [p.id, p]));
  const children = new Map<string, PartDef[]>();
  for (const p of design.parts) {
    if (!p.parent) continue;
    const list = children.get(p.parent) ?? [];
    list.push(p);
    children.set(p.parent, list);
  }

  const compiledParts: CompiledPart[] = [];
  const joints: CompiledJoint[] = [];
  const actuators: string[] = [];
  const sensors: string[] = [];
  let totalMass = 0;

  const emitPart = (p: PartDef, depth: number): string => {
    const pad = '  '.repeat(depth);
    const bodyName = `${prefix}${p.id}`;
    const geomMasses = p.geoms.map(geomMass);
    const geomTotal = geomMasses.reduce((a, b) => a + b, 0);
    const motorMass = partMotorMass(p);
    const gyroMass = design.gyro && design.gyro.part === p.id ? design.gyro.massKg : 0;
    const extra = motorMass + gyroMass;
    const partMass = geomTotal + extra;
    totalMass += partMass;
    const geomNames: string[] = [];
    const geomXmls = p.geoms.map((g, i) => {
      const name = `${bodyName}_g${i}`;
      geomNames.push(name);
      const mass = geomMasses[i] + (geomTotal > 0 ? (extra * geomMasses[i]) / geomTotal : extra / p.geoms.length);
      return geomXml(name, g, mass, contype, conaff);
    });
    const jointXmls = (p.joints ?? []).map((j) => {
      const mjName = `${prefix}${j.name}`;
      if (j.passive) {
        // Tendon-driven: no servo; a return spring holds it at springRef when the tendon is slack.
        const ref = j.passive.springRefDeg !== undefined ? ` springref="${f(j.passive.springRefDeg)}"` : '';
        return `<joint name="${mjName}" type="${j.type}" axis="${v3(j.axis)}" range="${f(j.rangeDeg[0])} ${f(j.rangeDeg[1])}" limited="true" armature="${f(j.armature ?? 0.02)}" damping="${f(j.damping ?? 0.5)}" frictionloss="${f(j.frictionloss ?? 0.1)}" stiffness="${f(j.passive.stiffness)}"${ref}/>`;
      }
      const spec = motor(j.motor);
      const torque = spec.stallTorqueNm * (j.gear ?? 1);
      joints.push({ name: j.name, mjName, part: p.id, motor: j.motor, kp: j.kp, kd: j.kd, hydraulicCircuit: j.hydraulicCircuit });
      // Native position servo: MuJoCo integrates kv implicitly (implicitfast), which keeps
      // stiff gains stable on light links. The motor model rewrites forcerange at runtime
      // (torque-speed curve, heat, damage, hydraulic pressure).
      actuators.push(`<position name="${mjName}_m" joint="${mjName}" kp="${f(j.kp)}" kv="${f(j.kd)}" forcelimited="true" forcerange="${f(-torque)} ${f(torque)}"/>`);
      return `<joint name="${mjName}" type="${j.type}" axis="${v3(j.axis)}" range="${f(j.rangeDeg[0])} ${f(j.rangeDeg[1])}" limited="true" armature="${f(j.armature ?? 0.02)}" damping="${f(j.damping ?? 0.5)}" frictionloss="${f(j.frictionloss ?? 0.1)}"/>`;
    });
    if (p.tags.includes('head')) sensors.push(`<framepos name="${bodyName}_pos" objtype="body" objname="${bodyName}"/>`);
    compiledParts.push({ id: p.id, body: bodyName, debrisBody: p.detachable ? `${bodyName}_debris` : null, geomNames, debrisGeomNames: [], massKg: partMass });

    const isRoot = !p.parent;
    const posAttr = isRoot ? v3(placement.pos) : v3(p.pos);
    const quat: Quat | undefined = isRoot ? [Math.cos(placement.yaw / 2), 0, 0, Math.sin(placement.yaw / 2)] : p.quat;
    const quatAttr = quat ? ` quat="${q4(quat)}"` : '';
    const kids = (children.get(p.id) ?? []).map((c) => emitPart(c, depth + 1)).join('\n');
    return [
      `${pad}<body name="${bodyName}" pos="${posAttr}"${quatAttr}>`,
      isRoot ? `${pad}  <freejoint name="${prefix}root"/>` : '',
      ...jointXmls.map((x) => `${pad}  ${x}`),
      ...geomXmls.map((x) => `${pad}  ${x}`),
      `${pad}  <site name="${bodyName}_site" pos="0 0 0" size="0.01"/>`,
      kids,
      `${pad}</body>`,
    ].filter(Boolean).join('\n');
  };

  const root = design.parts[0];
  const bodyXml = emitPart(root, 2);

  // Parked debris copies: one rigid body per detachable part, merging its rigid descendants.
  const parkingWelds: Record<string, string> = {};
  const debrisXml: string[] = [];
  let parkIndex = 0;
  for (const p of design.parts) {
    if (!p.detachable) continue;
    const cp = compiledParts.find((c) => c.id === p.id)!;
    const debrisName = `${prefix}${p.id}_debris`;
    const merged: Array<{ g: GeomDef; pos: Vec3; quat: Quat }> = [];
    const collect = (part: PartDef, pos: Vec3, quat: Quat) => {
      for (const g of part.geoms) merged.push({ g, pos, quat });
      for (const c of children.get(part.id) ?? []) {
        const cq = c.quat ? mulQ(quat, c.quat) : quat;
        collect(c, addV(pos, rotate(quat, c.pos)), cq);
      }
    };
    collect(p, [0, 0, 0], [1, 0, 0, 0]);
    const geoms = merged.map(({ g, pos, quat }, i) => {
      const name = `${debrisName}_g${i}`;
      cp.debrisGeomNames.push(name);
      return geomXml(name, g, geomMass(g) + (i === 0 ? partMotorMass(p) : 0), 0, 0, { pos, quat });
    });
    const parkPos: Vec3 = [40 + corner * 10 + parkIndex * 1.5, 40, 2];
    parkIndex++;
    debrisXml.push([
      `    <body name="${debrisName}" pos="${v3(parkPos)}">`,
      `      <freejoint name="${debrisName}_free"/>`,
      ...geoms.map((x) => `      ${x}`),
      `    </body>`,
    ].join('\n'));
    parkingWelds[p.id] = `${debrisName}_park`;
    void byId;
  }

  // Tendon drives go after every joint servo, so the servo actuator ids never move.
  const tendons: CompiledTendon[] = [];
  const tendonXml: string[] = [];
  for (const t of design.tendons ?? []) {
    const mjName = `${prefix}${t.id}`;
    const spec = motor(t.motor);
    const lo = t.pullOnly ? 0 : -spec.stallTorqueNm;
    tendonXml.push([
      `<fixed name="${mjName}">`,
      ...t.joints.map((j) => `  <joint joint="${prefix}${j.joint}" coef="${f(j.coef)}"/>`),
      `</fixed>`,
    ].join('\n    '));
    actuators.push(`<position name="${mjName}_m" tendon="${mjName}" kp="${f(t.kp)}" kv="${f(t.kd)}" forcelimited="true" forcerange="${f(lo)} ${f(spec.stallTorqueNm)}" ctrllimited="true" ctrlrange="${f(t.lengthRange[0])} ${f(t.lengthRange[1])}"/>`);
    tendons.push({ id: t.id, mjName, actuator: `${mjName}_m`, motor: t.motor, joints: t.joints.map((j) => `${prefix}${j.joint}`) });
  }

  const gantryWeld = `${prefix}gantry`;
  const equalities = [
    `<weld name="${gantryWeld}" body1="${prefix}${root.id}" solref="0.02 1"/>`,
    ...Object.entries(parkingWelds).map(([id, weld]) => `<weld name="${weld}" body1="${prefix}${id}_debris"/>`),
  ];

  return {
    corner,
    prefix,
    design,
    bodyXml,
    debrisXml: debrisXml.join('\n'),
    actuatorXml: actuators.join('\n    '),
    tendonXml: tendonXml.join('\n    '),
    equalityXml: equalities.join('\n    '),
    sensorXml: sensors.join('\n    '),
    parts: compiledParts,
    joints,
    tendons,
    totalMassKg: totalMass,
    gantryWeld,
    parkingWelds,
  };
}

function validate(design: RobotDesign): void {
  const ids = new Set<string>();
  for (const [i, p] of design.parts.entries()) {
    if (ids.has(p.id)) throw new Error(`${design.id}: duplicate part id '${p.id}'`);
    ids.add(p.id);
    if (i === 0 && p.parent) throw new Error(`${design.id}: parts[0] must be the root`);
    if (i > 0 && (!p.parent || !ids.has(p.parent))) throw new Error(`${design.id}: part '${p.id}' has unknown or later parent '${p.parent}'`);
    if (p.geoms.length === 0) throw new Error(`${design.id}: part '${p.id}' has no geoms`);
  }
  const passive = new Set(design.parts.flatMap((p) => (p.joints ?? []).filter((j) => j.passive).map((j) => j.name)));
  for (const t of design.tendons ?? []) {
    for (const j of t.joints) if (!passive.has(j.joint)) throw new Error(`${design.id}: tendon '${t.id}' routes over '${j.joint}', which is not a passive joint`);
  }
  // A detached part becomes one rigid body, so its descendants must be rigid.
  for (const p of design.parts) {
    if (!p.detachable) continue;
    const stack = design.parts.filter((c) => c.parent === p.id);
    while (stack.length) {
      const c = stack.pop()!;
      if (c.joints?.length) throw new Error(`${design.id}: detachable '${p.id}' has jointed descendant '${c.id}'`);
      stack.push(...design.parts.filter((x) => x.parent === c.id));
    }
  }
}
