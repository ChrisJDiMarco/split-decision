// Adapters from the world (meta, poses, telemetry) to what the camera director and the
// audio need: fighter subjects and the audio scene.
import type { RobotTelemetry, WorldMeta } from '../core/protocol';
import type { Corner, MaterialId, RobotDesign, Vec3 } from '../core/types';
import type { AudioScene } from '../audio/broadcast-audio';
import type { Subjects } from '../render/camera/shots';
import { ARENA } from '../core/arena-spec';
import { taleOfTheTape } from './tale';

const DEFAULT_HEAD_Z = 1.85;
const HEAD_ABOVE_COM_M = 0.85;
const FOOT_RE = /foot/;
const LIMB_RE = /fist|foot|hammer|shin|forearm|jaw|claw/;

export interface WorldIndex {
  roots: [number, number];
  heads: [number | null, number | null];
  meta: WorldMeta;
}

export function indexWorld(meta: WorldMeta): WorldIndex {
  const roots: [number, number] = [0, 0];
  const heads: [number | null, number | null] = [null, null];
  for (const r of meta.robots) {
    roots[r.corner] = r.parts[0]?.body ?? 0;
    heads[r.corner] = r.parts.find((p) => p.id === 'head')?.body ?? null;
  }
  return { roots, heads, meta };
}

function bodyPos(poses: Float32Array, body: number): Vec3 | null {
  const o = body * 7;
  if (o + 2 >= poses.length) return null;
  return [poses[o], poses[o + 1], poses[o + 2]];
}

/** Idle subjects before any frame: both fighters on their spawn marks. */
export function idleSubjects(): Subjects {
  const d = ARENA.SPAWN_OFFSET_M;
  return { pos: [[-d, 0, 1], [d, 0, 1]], headZ: [DEFAULT_HEAD_Z, DEFAULT_HEAD_Z], heading: [0, Math.PI], down: [false, false] };
}

export function buildSubjects(index: WorldIndex | null, telemetry: readonly RobotTelemetry[] | null, poses: Float32Array | null): Subjects {
  const s = idleSubjects();
  if (!telemetry) return s;
  for (const t of telemetry) {
    const c = t.corner;
    s.pos[c] = t.comWorld;
    s.heading[c] = t.heading;
    s.down[c] = t.down;
    const headAttached = t.parts.find((p) => p.id === 'head')?.attached ?? false;
    const headBody = index?.heads[c] ?? null;
    const head = headAttached && headBody !== null && poses ? bodyPos(poses, headBody) : null;
    s.headZ[c] = head ? head[2] : t.comWorld[2] + HEAD_ABOVE_COM_M;
  }
  if (poses) s.bodyPos = (body: number) => bodyPos(poses, body);
  return s;
}

function partMaterial(design: RobotDesign, part: string | null): MaterialId {
  const p = part ? design.parts.find((x) => x.id === part) : undefined;
  const g = p?.geoms.find((x) => x.role === 'armor' || x.role === 'sensor') ?? p?.geoms[0];
  return g?.material ?? 'steel';
}

export function buildAudioScene(index: WorldIndex, designs: readonly [RobotDesign, RobotDesign], pan: (p: Vec3) => number): AudioScene {
  const feet: AudioScene['feet'] = [];
  const limbs: AudioScene['limbs'] = [];
  for (const r of index.meta.robots) {
    for (const p of r.parts) {
      if (FOOT_RE.test(p.id)) feet.push({ corner: r.corner, body: p.body });
      if (LIMB_RE.test(p.id)) limbs.push({ corner: r.corner, body: p.body });
    }
  }
  return {
    pan,
    material: (corner: Corner, part: string | null) => partMaterial(designs[corner], part),
    massKg: [taleOfTheTape(designs[0]).massKg, taleOfTheTape(designs[1]).massKg],
    feet,
    limbs,
    roots: index.roots,
  };
}
