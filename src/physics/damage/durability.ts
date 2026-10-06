// Per-design durability (docs/design/strike-power.md §4.1). Every number comes from the design's
// own build: its shell material and wall per zone, frame, mass and head mount, and each joint's drive
// train from the catalog. Nothing here is tuned per design: HAYMAKER shrugs off jabs because 17 mm of
// UHMW over its chest needs ~9.5 kN to yield, FIRECRACKER dents early because 2.5 mm of polycarbonate
// yields at ~0.6 kN, PYLON looks untouched until a hard shot cracks its carbon.
import type { GearType, GeomDef, MaterialId, MotorSpec, PartDef, RobotDesign, Vec3 } from '../../core/types';
import { WALL_MM } from '../../robots/catalog';
import { DAMAGE_TUNING } from './constants';
import { shellSurface, solidSurface, type Surface } from './shell';

export type ZoneId = 'torso_face' | 'torso_side' | 'head' | 'forearm' | 'shin' | 'frame' | 'fist' | 'foot' | 'other';

/**
 * A design's shell build. The modern four mirror the `shell` they pass buildHumanoid in
 * src/robots/designs/index.ts (tests/damage/durability.test.ts re-derives every shell geom's mass from
 * these numbers, so the two cannot drift apart). fill / torsoFill are only used by that check.
 */
export interface ShellBuild {
  armor: MaterialId;
  frame: MaterialId;
  armorMm: number; // torso sides, forearms, shins
  frameMm: number; // upper arms, thighs, pelvis
  headMm: number;
  /** Torso front and back faces, when thicker than the average shell (HAYMAKER's chest slabs). */
  torsoFaceMm?: number;
  fillKgM3?: number;
  torsoFillKgM3?: number;
  note?: string;
}

/** Shell builds by design id. Designs without one (the iron age) use the catalog's wall model. */
export const SHELL_BUILDS: Record<string, ShellBuild> = {
  firecracker: { armor: 'polycarb', frame: 'al6061', armorMm: 2.5, frameMm: 2, headMm: 2.5, fillKgM3: 100, torsoFillKgM3: 245 },
  savate: { armor: 'polycarb', frame: 'al7075', armorMm: 2.5, frameMm: 2.5, headMm: 3, fillKgM3: 110, torsoFillKgM3: 140 },
  haymaker: {
    armor: 'uhmw', frame: 'al7075', armorMm: 7, frameMm: 2.5, headMm: 8, torsoFaceMm: 17, fillKgM3: 100, torsoFillKgM3: 75,
    note: 'UHMW slabs are 15-20 mm on the chest faces and thinner elsewhere, 7 mm averaged over the shells (designs/index.ts): the faces take 17 mm',
  },
  pylon: { armor: 'carbon', frame: 'al7075', armorMm: 2.5, frameMm: 2.5, headMm: 3, fillKgM3: 110, torsoFillKgM3: 120 },
};

/**
 * NEXT GEN hook: register a design's shell build once its shells are specified
 * (docs/design/next-gen-chassis.md). Until then a design gets the catalog's wall model.
 */
export function registerShellBuild(designId: string, build: ShellBuild): void {
  SHELL_BUILDS[designId] = build;
  profiles.clear();
}

export interface DurabilityProfile {
  design: string;
  source: 'build' | 'catalog';
  build: ShellBuild;
  massKg: number;
  /** m·g·h of the standing centre of mass: what a fall puts into the canvas and the body. */
  fallEnergyJ: number;
  /** Head break impulse over (head mass × 10 m/s): headgear and mounts above 1, a slim neck below. */
  headMount: number;
  /** Shell surfaces by zone (shells of the design's armour; strikers and feet by their own geom). */
  zones: Record<Exclude<ZoneId, 'fist' | 'foot' | 'other'>, Surface>;
}

export interface ProfileInputs {
  massKg: number;
  headKg: number;
  comHeightM: number;
}

const profiles = new Map<string, DurabilityProfile>();

/** The design's armour and frame materials, read from its geoms (the torso shell and an upper arm). */
function materialsOf(design: RobotDesign): { armor: MaterialId; frame: MaterialId } {
  const torso = design.parts.find((p) => p.tags.includes('torso') || p.tags.includes('chassis'));
  const frame = design.parts.find((p) => p.tags.includes('upperarm') || p.tags.includes('thigh'));
  return {
    armor: torso?.geoms.find((g) => g.role === 'armor')?.material ?? torso?.geoms[0]?.material ?? 'al7075',
    frame: frame?.geoms.find((g) => g.role === 'structure')?.material ?? frame?.geoms[0]?.material ?? 'al7075',
  };
}

/** The build for a design: its registered shell, else the catalog wall model on its own materials. */
export function shellBuild(design: RobotDesign): { build: ShellBuild; source: 'build' | 'catalog' } {
  const known = SHELL_BUILDS[design.id];
  if (known) return { build: known, source: 'build' };
  const { armor, frame } = materialsOf(design);
  return { build: { armor, frame, armorMm: WALL_MM.armor, frameMm: WALL_MM.structure, headMm: WALL_MM.sensor }, source: 'catalog' };
}

export function durabilityProfile(design: RobotDesign, inputs: ProfileInputs): DurabilityProfile {
  const key = `${design.id}|${design.loadout?.hands ?? 'stock'}|${inputs.massKg.toFixed(2)}`;
  const hit = profiles.get(key);
  if (hit) return hit;
  const { build, source } = shellBuild(design);
  const head = design.parts.find((p) => p.tags.includes('head'));
  const headBreak = head?.detachable?.impulseNs ?? 0;
  const span = DAMAGE_TUNING.panelSpanM;
  const profile: DurabilityProfile = {
    design: design.id,
    source,
    build,
    massKg: inputs.massKg,
    fallEnergyJ: inputs.massKg * 9.81 * inputs.comHeightM,
    headMount: inputs.headKg > 0 ? headBreak / (inputs.headKg * 10) : 0,
    zones: {
      torso_face: shellSurface(build.armor, build.torsoFaceMm ?? build.armorMm, span),
      torso_side: shellSurface(build.armor, build.armorMm, span),
      head: shellSurface(build.armor, build.headMm, span),
      forearm: shellSurface(build.armor, build.armorMm, span),
      shin: shellSurface(build.armor, build.armorMm, span),
      frame: shellSurface(build.frame, build.frameMm, span),
    },
  };
  profiles.set(key, profile);
  return profile;
}

/** Which zone of a part a contact landed on. `localNormal` is the contact normal in the part's frame. */
export function zoneOf(part: PartDef, geom: GeomDef, localNormal: Vec3 | null): ZoneId {
  if (geom.role === 'striker' || part.tags.includes('fist') || part.tags.includes('finger')) return 'fist';
  if (geom.role === 'foot' || part.tags.includes('foot')) return 'foot';
  if (part.tags.includes('head')) return 'head';
  if (part.tags.includes('torso') || part.tags.includes('chassis')) {
    if (!localNormal) return 'torso_side';
    const [x, y, z] = localNormal.map(Math.abs);
    return x >= y && x >= z ? 'torso_face' : 'torso_side';
  }
  if (part.tags.includes('forearm')) return 'forearm';
  if (part.tags.includes('shin')) return 'shin';
  if (geom.role === 'structure') return 'frame';
  return 'other';
}

/** The surface a contact meets: the zone's shell in the geom's own material, or a solid / cushion. */
export function surfaceOf(profile: DurabilityProfile, zone: ZoneId, geom: GeomDef): Surface {
  if (zone === 'fist' || zone === 'foot') return solidSurface(geom.material);
  if (zone === 'other') return shellSurface(geom.material, profile.build.armorMm);
  const z = profile.zones[zone];
  return z.material === geom.material ? z : shellSurface(geom.material, z.thicknessM * 1000);
}

// ---------------------------------------------------------------- drive trains

/** A joint's drive-train ratings, resolved from its catalog motor with labelled fallbacks. */
export interface DriveRatings {
  motor: string;
  gearType: GearType;
  ratio: number;
  /** Reflected rotor inertia at the output, kg·m² (rotor × ratio², or as published). */
  reflectedKgM2: number;
  /** Gear-train shock rating at the output, N·m. */
  gearShockNm: number;
  bearingMomentNm: number;
  bearingRadialN: number;
  bearingAxialN: number;
  housingRadiusM: number;
  stallNm: number;
  /** True when any of the above is a default for a motor with no catalog drive-train fields. */
  defaulted: boolean;
}

const ratingsCache = new WeakMap<MotorSpec, DriveRatings>();

export function driveRatings(m: MotorSpec): DriveRatings {
  const hit = ratingsCache.get(m);
  if (hit) return hit;
  const t = DAMAGE_TUNING;
  const gearType: GearType = m.gearType ?? (m.kind === 'hydraulic' ? 'hydraulic' : m.kind === 'pneumatic' ? 'pneumatic' : 'qdd');
  const ratio = m.gearRatio ?? (gearType === 'hydraulic' || gearType === 'pneumatic' ? 1 : t.defaultRatio);
  const od = m.housingDiameterMm ?? 100 * Math.cbrt(Math.max(0.1, m.massKg) / 1.2);
  const radial = m.bearingRadialN ?? 40 * od;
  const r: DriveRatings = {
    motor: m.id,
    gearType,
    ratio,
    reflectedKgM2: m.reflectedInertiaKgM2 ?? (m.rotorInertiaKgM2 ?? t.defaultRotorKgM2) * ratio * ratio,
    gearShockNm: m.gearPeakTorqueNm ?? t.defaultGearShock * m.stallTorqueNm,
    bearingMomentNm: m.bearingMomentNm ?? (radial * 0.7 * od) / 2000,
    bearingRadialN: radial,
    bearingAxialN: m.bearingAxialN ?? 36 * od,
    housingRadiusM: od / 2000,
    stallNm: m.stallTorqueNm,
    defaulted: m.gearType === undefined || m.gearPeakTorqueNm === undefined || m.bearingMomentNm === undefined,
  };
  ratingsCache.set(m, r);
  return r;
}

/** Non-backdrivable drives: a cylinder (or a stiff gear train) carries the whole external torque. */
export function rigidDrive(r: DriveRatings): boolean {
  return r.gearType === 'hydraulic' || r.gearType === 'pneumatic';
}
