// What a recipe gets to work with: the part, its collision envelope, the design's style, and
// one frame builder per joint frame (see rig/joints.ts for the frame convention).
import * as THREE from 'three/webgpu';
import type { GeomDef, PartDef, RobotDesign } from '../../../core/types';
import { motor } from '../../../robots/catalog';
import type { BoltKind, FrameBuilder } from '../geom/part-builder';
import { designLook, type DesignLook, type LimbStyle } from '../look';
import type { KitAnimated, KitMaterials, PartDims } from '../types';

export type StyleId = 'industrial' | 'sleek' | 'titan' | 'pebble' | 'blade' | 'slab' | 'hivis';

export interface KitStyle {
  id: StyleId;
  round: boolean; // rounded plates instead of chamfered
  plate: number; // armor plate thickness, metres
  boltKind: BoltKind;
  boltSize: number; // fastener head radius, metres
  boltDensity: number; // 0..1
  hoses: boolean; // exposed hydraulic hoses and cylinders
  pauldron: number; // shoulder armor size factor, 0 = none
  exposed: number; // how much frame and cabling shows, 0..1
  accents: ReadonlySet<string>; // plate names that get the skin's accent pattern
  cable: string;
  hose: string;
  signal: string; // coloured signal cable
  limbs: LimbStyle; // 'iron' = the plated recipes; the rest dress limbs as modern electric shells
}

const NO_ACCENTS: ReadonlySet<string> = new Set();

const STYLES: Record<StyleId, KitStyle> = {
  industrial: {
    id: 'industrial', round: false, plate: 0.016, boltKind: 'hex', boltSize: 0.0085, boltDensity: 0.85,
    hoses: true, pauldron: 0.75, exposed: 0.7,
    accents: new Set(['chest.pec', 'arm.front', 'thigh.front', 'knee', 'fore.plate', 'foot.toe', 'head.cheek']),
    cable: '#141414', hose: '#9a4a1c', signal: '#b8321c', limbs: 'iron',
  },
  sleek: {
    id: 'sleek', round: true, plate: 0.009, boltKind: 'rivet', boltSize: 0.005, boltDensity: 0.25,
    hoses: false, pauldron: 0.45, exposed: 0.85,
    accents: new Set(['chest.pec', 'thigh.side', 'shin', 'fore.plate', 'head.cheek']),
    cable: '#101214', hose: '#1d2a30', signal: '#1aa6c4', limbs: 'iron',
  },
  titan: {
    id: 'titan', round: true, plate: 0.02, boltKind: 'rivet', boltSize: 0.0075, boltDensity: 1,
    hoses: true, pauldron: 1.25, exposed: 0.45,
    accents: new Set(['pauldron', 'fore.plate', 'shin', 'chest.pec', 'foot.toe']),
    cable: '#161412', hose: '#2a2622', signal: '#a8741a', limbs: 'iron',
  },
  // Modern electric fighters: moulded shells over exposed rotary actuators, no hoses.
  pebble: {
    id: 'pebble', round: true, plate: 0.008, boltKind: 'rivet', boltSize: 0.0038, boltDensity: 0.1,
    hoses: false, pauldron: 0, exposed: 0.5, accents: NO_ACCENTS,
    cable: '#151515', hose: '#1d1d1d', signal: '#e8641a', limbs: 'pebble',
  },
  blade: {
    id: 'blade', round: true, plate: 0.008, boltKind: 'rivet', boltSize: 0.0042, boltDensity: 0.15,
    hoses: false, pauldron: 0, exposed: 0.6, accents: NO_ACCENTS,
    cable: '#121214', hose: '#1d1d22', signal: '#9dffd6', limbs: 'blade',
  },
  slab: {
    id: 'slab', round: false, plate: 0.018, boltKind: 'rivet', boltSize: 0.0072, boltDensity: 0.8,
    hoses: false, pauldron: 0, exposed: 0.5, accents: NO_ACCENTS,
    cable: '#121212', hose: '#1b1b1b', signal: '#ff4d1a', limbs: 'slab',
  },
  hivis: {
    id: 'hivis', round: true, plate: 0.007, boltKind: 'rivet', boltSize: 0.0034, boltDensity: 0.1,
    hoses: false, pauldron: 0, exposed: 0.7, accents: NO_ACCENTS,
    cable: '#111214', hose: '#1a1b1e', signal: '#b58cff', limbs: 'hivis',
  },
};

const DESIGN_STYLE: Record<string, StyleId> = {
  bruiser: 'industrial',
  striker: 'sleek',
  goliath: 'titan',
  anvil: 'industrial',
  jackal: 'industrial',
  buzzsaw: 'industrial',
};

export function styleFor(design: RobotDesign): KitStyle {
  const limbs = designLook(design).limbs;
  if (limbs !== 'iron') return STYLES[limbs];
  return STYLES[DESIGN_STYLE[design.id] ?? 'industrial'];
}

/** A piston or hose the view builder creates once every part group exists. */
export type LinkageRequest =
  | { kind: 'piston'; parent: string; child: string; anchorParent: THREE.Vector3; anchorChild: THREE.Vector3; radius: number; barrelLength: number }
  | { kind: 'hose'; parent: string; child: string; a: THREE.Vector3; aDir: THREE.Vector3; b: THREE.Vector3; bDir: THREE.Vector3; radius: number; color: string; slack: number };

export interface RecipeContext {
  part: PartDef;
  design: RobotDesign;
  style: KitStyle;
  dims: PartDims;
  parentDims: PartDims | null;
  params: Record<string, number | string | boolean>;
  side: 1 | -1 | 0; // +1 left (y+), -1 right
  /** frames[j] holds the stator of joint j; the last frame is the part's own body frame. */
  frames: FrameBuilder[];
  own: FrameBuilder;
  mats: KitMaterials;
  linkages: LinkageRequest[];
  rotors: Array<{ object: THREE.Object3D; axis: THREE.Vector3; speed: number }>;
  rams: KitAnimated['rams'];
  rand: () => number;
  look: DesignLook;
}

export type KitRecipe = (ctx: RecipeContext) => void;

// ---------------------------------------------------------------- collision envelope

function geomBox(g: GeomDef, box: THREE.Box3): void {
  const s = g.shape;
  const pos = new THREE.Vector3(...(g.pos ?? [0, 0, 0]));
  switch (s.type) {
    case 'box': {
      const half = new THREE.Vector3(...s.halfSize);
      if (g.quat) {
        const q = new THREE.Quaternion(g.quat[1], g.quat[2], g.quat[3], g.quat[0]);
        const b = new THREE.Box3(half.clone().negate(), half).applyMatrix4(new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1)));
        box.union(b);
      } else {
        box.expandByPoint(pos.clone().sub(half)).expandByPoint(pos.clone().add(half));
      }
      break;
    }
    case 'sphere':
      box.expandByPoint(pos.clone().subScalar(s.radius)).expandByPoint(pos.clone().addScalar(s.radius));
      break;
    case 'capsule':
    case 'cylinder': {
      const r = s.radius;
      for (const p of [s.from, s.to]) {
        const v = new THREE.Vector3(...p);
        box.expandByPoint(v.clone().subScalar(r)).expandByPoint(v.clone().addScalar(r));
      }
      break;
    }
  }
}

export function partDims(part: PartDef): PartDims {
  const box = new THREE.Box3();
  for (const g of part.geoms) geomBox(g, box);
  const limb = part.geoms.find((g) => g.shape.type === 'capsule' || g.shape.type === 'cylinder');
  let length = 0;
  let radius = 0;
  if (limb && (limb.shape.type === 'capsule' || limb.shape.type === 'cylinder')) {
    length = new THREE.Vector3(...limb.shape.from).distanceTo(new THREE.Vector3(...limb.shape.to));
    radius = limb.shape.radius;
  }
  return { min: box.min, max: box.max, size: box.getSize(new THREE.Vector3()), center: box.getCenter(new THREE.Vector3()), length, radius };
}

// ---------------------------------------------------------------- actuator sizing

const HOUSING_K = 0.043; // housing radius per cube-root kilogram of motor
const NECK_MIN_R = 0.03;

/** Housing radius for joint j from the real motor mass (bigger motors, bigger drums). */
export function housingRadius(part: PartDef, j: number, bulk = 1): number {
  const jd = part.joints?.[j];
  if (!jd) return NECK_MIN_R;
  const m = motor(jd.motor).massKg * (jd.gear ?? 1);
  return Math.max(NECK_MIN_R, HOUSING_K * Math.cbrt(m) * Math.sqrt(bulk));
}

export function isHydraulic(part: PartDef, j = 0): boolean {
  const jd = part.joints?.[j];
  return !!jd && motor(jd.motor).kind === 'hydraulic';
}
