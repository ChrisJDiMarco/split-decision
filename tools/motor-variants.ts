// Actuator variants of the modern designs, for A/B runs (docs/research/08-modern-roster.md: a joint
// whose real motor is the bottleneck may get a stronger catalogued module). A variant rebuilds the
// design from its builder spec with some joint groups on other catalog motors and puts it in the
// roster for this process only: every sim made afterwards (tests/control/helpers.ts makeSim, the
// centroid tables) compiles the variant. The game never reads this.
//
//   'savate.elbow=qdd.rs06x2,savate.waistYaw=qdd.ake90x2,haymaker.hipPitch=qdd.ake90x3'
//   keys: leg knee arm elbow waist neck shoulderPitch waistYaw hipPitch hipYaw (HumanoidSpec.motors)
import { motor } from '../src/robots/catalog';
import { DESIGNS, MODERN_SPECS } from '../src/robots/designs';
import { buildHumanoid, type HumanoidSpec } from '../src/robots/humanoid';

type MotorKey = keyof HumanoidSpec['motors'];
const KEYS: readonly MotorKey[] = ['leg', 'knee', 'arm', 'elbow', 'waist', 'neck', 'shoulderPitch', 'waistYaw', 'hipPitch', 'hipYaw'];

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
