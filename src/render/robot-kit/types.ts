// Robot kit: shared types. The kit turns a RobotDesign into detailed hard-surface meshes
// that follow the physics body poses (see src/render/robot-view.ts for the contract).
import type * as THREE from 'three/webgpu';
import type { GazeMode } from '../../core/protocol';
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

/**
 * A moving optic inside a head (see recipes/optics.ts). Offsets are in the head's part frame
 * (+x face forward, +y the robot's left, +z up); the gaze drives yawN / pitchN in -1..1.
 *   pupil   a glowing iris that slides inside its lens: rest + travel·(yawN·u + pitchN·v)
 *   slider  a hotspot that runs along a light bar or visor slit: rest + clamp(yawN·a.y + pitchN·a.z)·halfLen·a
 *   beacon  a tip light that pulses with aggression and burns steady on lock-on
 */
export interface EyeElement {
  kind: 'pupil' | 'slider' | 'beacon';
  part: string;
  object: THREE.Object3D;
  obj: KitObjState; // the element's own glow state (brighter than the static rings)
  rest: THREE.Vector3;
  u: THREE.Vector3; // pupil: lateral unit in the lens plane; slider: run direction (unit)
  v: THREE.Vector3; // pupil: vertical unit in the lens plane
  travel: number; // pupil: max offset (m); slider: half the run (m)
  gain: number; // brightness relative to the head's base eye level
  path?: THREE.Vector3[]; // slider on a curved bar: runs along this polyline instead (t from the same drive)
}

/**
 * One finger joint of a dexterous hand the kit draws itself (a palm with no phalanx bodies).
 * The pivot turns about `axis` by the grip (open → fist), blended toward `brace` by the spread.
 */
export interface FingerJoint {
  part: string; // the palm part that carries the hand
  side: 1 | -1;
  pivot: THREE.Object3D;
  axis: THREE.Vector3; // flexion axis in the pivot's parent frame
  pose: { open: number; fist: number; brace: number }; // flexion (rad)
}

/** Things that animate inside a part (rotor spin, eye flicker, glow). */
export interface KitAnimated {
  /** Spinning parts; each object rests at its parent's origin (a pivot group places it). */
  rotors: Array<{ object: THREE.Object3D; axis: THREE.Vector3; speed: number }>;
  /** Rams that fire with an ability (piston fists): slide along `dir` by `travel` at full stroke. */
  rams: Array<{ object: THREE.Object3D; part: string; dir: THREE.Vector3; travel: number; skill: string; stroke: number }>;
  /** Moving optics (pupils, scanner hotspots, beacons) the gaze and mood drive. */
  eyes: EyeElement[];
  /** Kit-drawn dexterous finger pivots, driven by the hand pose. */
  fingers: FingerJoint[];
}

export type { GazeMode };

/** Where a robot is looking, in physics space (same contract as RobotTelemetry.gaze). */
export interface GazeInput {
  point: [number, number, number];
  mode: GazeMode;
}

/** A hand pose: grip 0 open .. 1 closed fist, spread 0..1 fingers splayed to brace. */
export interface HandPose {
  grip: number;
  spread: number;
}

/**
 * Optics state. Everything smooths toward targets each frame (see eyes.ts). `override` lets a
 * harness force a gaze or a mood without physics; telemetry wins where it carries the field.
 */
export interface EyeState {
  seed: number;
  yaw: number; // current eye look in the head frame, radians (left +)
  pitch: number; // radians (up +)
  targetYaw: number;
  targetPitch: number;
  nextSaccade: number; // view time of the next voluntary saccade
  scanPhase: number;
  mode: GazeMode;
  level: number; // smoothed base brightness from aggression / confidence
  flare: number; // 0..1 lock-on envelope
  flash: number; // 0..1 hit flash envelope
  power: number; // 0..1: 0 = dark (KO, flat battery)
  tint: number; // 0..1 hot red when badly hurt
  lastFlashAt: number;
  override: {
    gaze?: GazeInput | null;
    flare?: boolean;
    hurt?: number; // 0..1 forces the damage look
    ko?: boolean;
    battery?: number;
  };
}

export interface HandState {
  pose: { l: HandPose; r: HandPose }; // current (smoothed)
  override: { l?: HandPose | null; r?: HandPose | null };
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
  eyes: EyeState;
  hands: HandState;
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
