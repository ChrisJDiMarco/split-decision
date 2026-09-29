// Builds robot kit views: one group per physics body (same contract as render/robot-view.ts),
// joint frames under each parent, hidden debris twins that carry the full detailed mesh, and
// the pistons / hoses that span two bodies.
import * as THREE from 'three/webgpu';
import type { WorldMeta } from '../../core/protocol';
import type { PartDef, RobotDesign, SkinId } from '../../core/types';
import { design as designById } from '../../robots/designs';
import { applyLoadout } from '../../robots/loadout';
import { FrameBuilder, newObjState, type BuiltFrame } from './geom/part-builder';
import { hashString, rng } from './geom/xf';
import { newEyeState } from './eyes';
import { newHandState } from './hands';
import { designLook } from './look';
import { createRobotMaterials } from './materials';
import { partDims, styleFor, type LinkageRequest, type RecipeContext } from './recipes/context';
import { resolveRecipe } from './recipes/registry';
import { registerHumanoidRecipes } from './recipes/humanoid';
import { jointChain } from './rig/joints';
import { buildLinkage } from './rig/linkages';
import type { KitAnimated, KitPart, RigFrame, RobotKitView } from './types';

export interface PartMeta {
  id: string;
  body: number;
  debrisBody: number | null;
}

registerHumanoidRecipes();

/**
 * The recipe a part draws with. A 'knuckle' hands loadout fits bare fists behind AR500 plates;
 * the physics reuses the bare-fist kit ids, so the kit shows the plates itself.
 */
function kitId(design: RobotDesign, part: PartDef): string {
  if (design.loadout?.hands === 'knuckle' && part.tags.includes('fist')) return 'fist.plate';
  return part.visual.kit;
}

function sideOf(part: PartDef): 1 | -1 | 0 {
  if (part.tags.includes('left')) return 1;
  if (part.tags.includes('right')) return -1;
  return 0;
}

/** Transform from a part's frame to a rigid descendant's frame, from the design tree. */
function descendantTransform(design: RobotDesign, ancestor: string, id: string): THREE.Matrix4 | null {
  const chain: PartDef[] = [];
  let cur = design.parts.find((p) => p.id === id);
  while (cur && cur.id !== ancestor) {
    if (cur.joints?.length) return null; // not rigid
    chain.unshift(cur);
    cur = design.parts.find((p) => p.id === cur!.parent);
  }
  if (!cur) return null;
  const m = new THREE.Matrix4();
  for (const p of chain) {
    const q = p.quat ? new THREE.Quaternion(p.quat[1], p.quat[2], p.quat[3], p.quat[0]) : new THREE.Quaternion();
    m.multiply(new THREE.Matrix4().compose(new THREE.Vector3(...p.pos), q, new THREE.Vector3(1, 1, 1)));
  }
  return m;
}

function cloneContent(src: THREE.Group, obj: ReturnType<typeof newObjState>): THREE.Group {
  const out = src.clone(true);
  out.traverse((o) => {
    o.userData.kit = obj;
    const inst = o as THREE.InstancedMesh;
    if (inst.isInstancedMesh) {
      const orig = src.getObjectByName(inst.name) as THREE.InstancedMesh | undefined;
      if (orig?.isInstancedMesh) inst.instanceMatrix = orig.instanceMatrix; // dents move both
    }
  });
  return out;
}

interface Built {
  kit: KitPart;
  triangles: number;
}

function buildPart(
  part: PartDef, meta: PartMeta, view: { design: RobotDesign; parts: Map<string, KitPart> },
  env: { seed: number; mats: RobotKitView['materials']; animated: KitAnimated; linkages: LinkageRequest[]; parent: THREE.Object3D; bodyGroups: Map<number, THREE.Group>; prefix: string },
): Built {
  const design = view.design;
  const nJ = part.joints?.length ?? 0;
  const partSeed = env.seed ^ hashString(part.id);
  const frames = Array.from({ length: nJ + 1 }, (_, k) => new FrameBuilder(`${env.prefix}${part.id}.f${k}`, partSeed + k * 7919));
  const parentDef = part.parent ? design.parts.find((p) => p.id === part.parent) : undefined;
  const ctx: RecipeContext = {
    part, design, style: styleFor(design), dims: partDims(part), parentDims: parentDef ? partDims(parentDef) : null,
    params: part.visual.params ?? {}, side: sideOf(part), frames, own: frames[nJ], mats: env.mats,
    linkages: env.linkages, rotors: env.animated.rotors, rams: env.animated.rams,
    eyes: env.animated.eyes, fingers: env.animated.fingers,
    rand: rng(partSeed), look: designLook(design),
  };
  resolveRecipe(kitId(design, part))(ctx);
  if (part.smokePoint) frames[nJ].anchor('vent', new THREE.Vector3(...part.smokePoint));

  const attached = new THREE.Group();
  attached.name = `${env.prefix}${part.id}`;
  env.parent.add(attached);
  env.bodyGroups.set(meta.body, attached);
  const obj = newObjState((partSeed % 1000) / 1000);
  const own: BuiltFrame = frames[nJ].finalize(env.mats, obj);
  attached.add(own.group);
  let triangles = own.triangles;

  const rig: RigFrame[] = [];
  const parentKit = part.parent ? view.parts.get(part.parent) : undefined;
  if (parentKit && nJ > 0) {
    let host: THREE.Object3D = parentKit.attached;
    for (let k = 0; k < nJ; k++) {
      const fObj = newObjState(((partSeed + k) % 1000) / 1000);
      const built = frames[k].finalize(env.mats, fObj);
      if (k === 0) {
        built.group.position.set(...part.pos);
        if (part.quat) built.group.quaternion.set(part.quat[1], part.quat[2], part.quat[3], part.quat[0]);
      }
      host.add(built.group);
      rig.push({ group: built.group, joint: part.joints![k].name, index: k, obj: fObj });
      triangles += built.triangles;
      host = built.group;
    }
  }
  const kit: KitPart = {
    id: part.id, def: part, attached, debris: null, content: own.group, debrisContent: null,
    frames: rig, chain: jointChain(part), meshes: own.meshes, bolts: own.bolts, anchors: frames[nJ].anchors,
    state: { hp: 1, heat: 0, attached: true }, obj, debrisObj: null, stump: null, stumpObj: null,
    sparkPoints: [], detachedAt: -1,
  };
  return { kit, triangles };
}

function buildDebris(view: RobotKitView, kit: KitPart, meta: PartMeta, parent: THREE.Object3D, bodyGroups: Map<number, THREE.Group>): void {
  if (meta.debrisBody === null) return;
  const debris = new THREE.Group();
  debris.name = `${kit.attached.name}_debris`;
  debris.visible = false;
  kit.debrisObj = newObjState(kit.obj.seed);
  kit.debrisContent = cloneContent(kit.content, kit.debrisObj);
  debris.add(kit.debrisContent);
  // Rigid descendants ride along on the debris body (e.g. a fist on a forearm).
  for (const p of view.design.parts) {
    if (p.id === kit.id) continue;
    const m = descendantTransform(view.design, kit.id, p.id);
    const child = view.parts.get(p.id);
    if (!m || !child) continue;
    const c = cloneContent(child.content, kit.debrisObj);
    c.applyMatrix4(m);
    debris.add(c);
  }
  parent.add(debris);
  bodyGroups.set(meta.debrisBody, debris);
  kit.debris = debris;
}

/** Build one robot's view under `parent`, registering every body group in `bodyGroups`. */
export function buildRobotKitView(design: RobotDesign, skin: SkinId, corner: 0 | 1, parts: PartMeta[], parent: THREE.Object3D, bodyGroups: Map<number, THREE.Group>): RobotKitView {
  const seed = hashString(`${design.id}:${corner}:${skin}`);
  const robotMats = createRobotMaterials(skin, design, seed);
  const animated: KitAnimated = { rotors: [], rams: [], eyes: [], fingers: [] };
  const linkReqs: LinkageRequest[] = [];
  const metaById = new Map(parts.map((p) => [p.id, p]));
  const view: RobotKitView = {
    corner, design, skin, parts: new Map(), linkages: [], animated, materials: robotMats.mats,
    jointHeat: new Map(), gyroSaturation: 0, gyroHealth: 1, eyes: newEyeState(seed), hands: newHandState(), time: 0, triangles: 0,
    dispose: () => undefined,
  };
  const prefix = corner === 0 ? 'r0_' : 'r1_';
  for (const part of design.parts) {
    const meta = metaById.get(part.id);
    if (!meta) continue;
    const { kit, triangles } = buildPart(part, meta, view, { seed, mats: robotMats.mats, animated, linkages: linkReqs, parent, bodyGroups, prefix });
    view.parts.set(part.id, kit);
    view.triangles += triangles;
  }
  for (const kit of view.parts.values()) {
    const meta = metaById.get(kit.id);
    if (meta) buildDebris(view, kit, meta, parent, bodyGroups);
  }
  for (const req of linkReqs) {
    const host = view.parts.get(req.parent);
    if (!host || !view.parts.has(req.child)) continue;
    const l = buildLinkage(req, robotMats.mats, host.attached);
    view.linkages.push(l);
  }
  view.dispose = () => disposeView(view, robotMats.dispose);
  return view;
}

function disposeView(view: RobotKitView, disposeMats: () => void): void {
  const geos = new Set<THREE.BufferGeometry>();
  for (const kit of view.parts.values()) {
    for (const root of [kit.attached, kit.debris]) {
      if (!root) continue;
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && !(m as THREE.InstancedMesh).isInstancedMesh) geos.add(m.geometry);
      });
      root.removeFromParent();
    }
  }
  for (const g of geos) g.dispose();
  disposeMats();
}

/**
 * Contract-compatible replacement for render/robot-view.ts buildRobotViews. Each robot is built
 * from its design with the same loadout the physics compiled (WorldMeta.robots[i].loadout).
 */
export function buildRobotKitViews(meta: WorldMeta, physicsRoot: THREE.Group, skins: [SkinId, SkinId]): { views: RobotKitView[]; bodyGroups: Map<number, THREE.Group> } {
  const bodyGroups = new Map<number, THREE.Group>();
  const views = meta.robots.map((r) => buildRobotKitView(applyLoadout(designById(r.design), r.loadout), skins[r.corner], r.corner, r.parts, physicsRoot, bodyGroups));
  return { views, bodyGroups };
}
