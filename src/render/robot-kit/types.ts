// Robot kit: shared types. The kit turns a RobotDesign into detailed hard-surface meshes
// that follow the physics body poses (see src/render/robot-view.ts for the contract).
import type * as THREE from 'three/webgpu';
import type { PartDef, RobotDesign, SkinId } from '../../core/types';
import type { KitObjState } from './geom/part-builder';
import type { JointChain } from './rig/joints';

/**
 * Material slots. Each part frame merges its geometry into one mesh per slot. `trim` is the
 * second paint colour (the livery accent: shin guards, joint bands, glove cuffs); `glove` is
 * padded leather in the design's glove colour (gloves, headgear).
 */
export type MatSlot = 'paint' | 'trim' | 'glove' | 'frame' | 'mech' | 'chrome' | 'rubber' | 'glow' | 'lens' | 'core' | 'wire';

export const MAT_SLOTS: readonly MatSlot[] = ['paint', 'trim', 'glove', 'frame', 'mech', 'chrome', 'rubber', 'glow', 'lens', 'core', 'wire'];

/** Decal kinds baked into the `aDecal.z` attribute. 0 = none. */
export const DECAL = { NONE: 0, ACCENT: 1, NUMBER: 2, LABEL: 3, WARNING: 4, SERIAL: 5 } as const;
export type DecalKind = (typeof DECAL)[keyof typeof DECAL];

export type KitMaterials = Record<MatSlot, THREE.Material>;

/** One rigged joint frame: a group under the parent part that turns with a subset of the joints. */
export interface RigFrame {
  group: THREE.Group;
  joint: string; // the joint whose stator lives in this frame (drives the frame's heat)
  index: number; // k: this frame applies joints[0..k-1]
  obj: KitObjState; // shader state of the frame's meshes
}

/** Piston between two part frames: barrel pivots on the parent, rod end pins to the child. */
export interface PistonLinkage {
  kind: 'piston';
  parent: string; // part id the barrel is mounted on
  child: string; // part id the rod end is pinned to
  anchorParent: THREE.Vector3; // barrel pivot, parent part frame
  anchorChild: THREE.Vector3; // rod eye, child part frame
  barrel: THREE.Object3D; // local +z points from the pivot toward the rod end
  rod: THREE.Object3D; // local +z points along the rod; its origin sits at the rod eye
  barrelLength: number;
}

/** Flexible hose between two part frames, re-shaped every frame in the parent's frame. */
export interface HoseLinkage {
  kind: 'hose';
  parent: string;
  child: string;
  a: THREE.Vector3; // start, parent frame
  aDir: THREE.Vector3; // leaving direction at the start, parent frame
  b: THREE.Vector3; // end, child frame
  bDir: THREE.Vector3; // arriving direction at the end, child frame (points into the socket)
  mesh: THREE.Mesh;
  radius: number;
  slack: number; // tangent length factor
}

export type Linkage = PistonLinkage | HoseLinkage;

/** Things that animate inside a part (rotor spin, eye flicker, glow). */
export interface KitAnimated {
  /** Spinning parts; each object rests at its parent's origin (a pivot group places it). */
  rotors: Array<{ object: THREE.Object3D; axis: THREE.Vector3; speed: number }>;
  /** Rams that fire with an ability (piston fists): slide along `dir` by `travel` at full stroke. */
  rams: Array<{ object: THREE.Object3D; part: string; dir: THREE.Vector3; travel: number; skill: string; stroke: number }>;
}

export interface PartVisualState {
  hp: number;
  heat: number;
  attached: boolean;
}

/** Everything the kit built for one physics part. */
export interface KitPart {
  id: string;
  def: PartDef;
  attached: THREE.Group; // follows the attached body pose
  debris: THREE.Group | null; // follows the debris twin; hidden until the part detaches
  content: THREE.Group; // the part's own visual inside `attached`
  debrisContent: THREE.Group | null;
  frames: RigFrame[]; // joint frames that live under the parent part's group
  chain: JointChain;
  meshes: THREE.Mesh[]; // merged meshes of the part itself (dent targets), shared with the debris twin
  bolts: THREE.InstancedMesh[];
  anchors: Map<string, THREE.Vector3>; // named points in the part frame
  state: PartVisualState;
  obj: KitObjState; // shader state of the attached content
  debrisObj: KitObjState | null;
  stump: THREE.Group | null; // torn socket shown on the parent after this part detaches
  stumpObj: KitObjState | null;
  sparkPoints: THREE.Object3D[]; // live spark emitters (stump wires), world pose via matrixWorld
  detachedAt: number; // view time when the part came off, -1 while attached
}

export interface RobotKitView {
  corner: 0 | 1;
  design: RobotDesign;
  skin: SkinId;
  /** Same shape as the placeholder RobotView so callers can swap views freely. */
  parts: Map<string, KitPart>;
  linkages: Linkage[];
  animated: KitAnimated;
  materials: KitMaterials;
  /** Per-joint heat 0..1, written from telemetry. */
  jointHeat: Map<string, number>;
  gyroSaturation: number; // smoothed 0..1
  gyroHealth: number;
  time: number;
  triangles: number;
  dispose(): void;
}

/** Numbers the recipes read from the collision geoms, so visuals match contacts. */
export interface PartDims {
  /** Axis-aligned box of all collision geoms in the part frame. */
  min: THREE.Vector3;
  max: THREE.Vector3;
  size: THREE.Vector3;
  center: THREE.Vector3;
  /** Capsule/cylinder limbs: segment length and radius (0 for boxes). */
  length: number;
  radius: number;
}
