// Loose render-only debris: bolts, nuts, armor shards, torn plate and metal chips that
// pop off heavy impacts and part detachments, tumble with real mass, skid across the
// canvas and stay where they land. Each shape variant is one InstancedMesh.
import * as THREE from 'three/webgpu';
import { APOTHEM } from '../../core/arena-spec';
import { randomInCone, range, type Rng } from './coords';
import { boltShape, nutShape, plateShape, shardShape, type DebrisShape } from './debris-geometry';
import { makeBody, stepBody, wake, type RigidBody, type RigidEnv } from './rigid';

/**
 * chip: bright metal flakes; fibre: dark carbon slivers off a cracked panel; shaving: off-white UHMW
 * curls off a gouge; flake: pale polycarbonate chips off a whitened crack.
 */
export type DebrisKind = 'bolt' | 'nut' | 'shard' | 'plate' | 'chip' | 'fibre' | 'shaving' | 'flake';

interface Species {
  kind: DebrisKind;
  shape: DebrisShape;
  mesh: THREE.InstancedMesh;
  capacity: number;
  pieces: Piece[];
  next: number; // ring cursor: the oldest piece is recycled when full
}

interface Piece {
  body: RigidBody;
  slot: number;
}

const CAPACITY: Record<DebrisKind, number> = { bolt: 90, nut: 60, shard: 80, plate: 24, chip: 220, fibre: 60, shaving: 60, flake: 60 };
const VARIANTS: Record<DebrisKind, number> = { bolt: 2, nut: 1, shard: 4, plate: 2, chip: 3, fibre: 2, shaving: 2, flake: 2 };
const FENCE_MARGIN_M = 0.05;

export class DebrisSystem {
  readonly object = new THREE.Group();
  private readonly species: Species[] = [];
  private readonly byKind = new Map<DebrisKind, Species[]>();
  private readonly env: RigidEnv = { fenceRadius: APOTHEM - FENCE_MARGIN_M };
  private readonly rng: Rng;

  constructor(rng: Rng) {
    this.rng = rng;
    this.object.name = 'vfx.debris';
    const steel = new THREE.MeshStandardNodeMaterial({ color: 0x8b8e92, metalness: 0.95, roughness: 0.36 });
    const darkSteel = new THREE.MeshStandardNodeMaterial({ color: 0x3a3c40, metalness: 0.85, roughness: 0.5 });
    const armor = new THREE.MeshStandardNodeMaterial({ color: 0x4a4d52, metalness: 0.8, roughness: 0.42, flatShading: true });
    const bright = new THREE.MeshStandardNodeMaterial({ color: 0xb8bcc2, metalness: 1, roughness: 0.25, flatShading: true });
    const make = (kind: DebrisKind, shapeFor: (v: number) => DebrisShape, material: THREE.Material) => {
      const list: Species[] = [];
      const n = VARIANTS[kind];
      for (let v = 0; v < n; v++) {
        const shape = shapeFor(v);
        const capacity = Math.ceil(CAPACITY[kind] / n);
        const mesh = new THREE.InstancedMesh(shape.geometry, material, capacity);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        // Every slot starts collapsed; one is always drawn so the pipeline compiles at load.
        for (let i = 0; i < capacity; i++) mesh.setMatrixAt(i, COLLAPSED);
        mesh.count = 1;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.object.add(mesh);
        const s: Species = { kind, shape, mesh, capacity, pieces: [], next: 0 };
        list.push(s);
        this.species.push(s);
      }
      this.byKind.set(kind, list);
    };
    make('bolt', (v) => boltShape(v === 0 ? 0.075 : 0.05, v === 0 ? 0.01 : 0.008), steel);
    make('nut', () => nutShape(0.017), darkSteel);
    make('shard', () => shardShape(this.rng, new THREE.Vector3(range(this.rng, 0.04, 0.1), range(this.rng, 0.012, 0.02), range(this.rng, 0.03, 0.08))), armor);
    make('plate', () => plateShape(this.rng, range(this.rng, 0.12, 0.2), range(this.rng, 0.08, 0.14), 0.008), armor);
    make('chip', () => shardShape(this.rng, new THREE.Vector3(range(this.rng, 0.008, 0.016), 0.003, range(this.rng, 0.006, 0.012))), bright);
    // Shell flecks by material (docs/design/strike-power.md §4.7).
    const carbon = new THREE.MeshStandardNodeMaterial({ color: 0x17181a, metalness: 0.15, roughness: 0.55, flatShading: true });
    const uhmw = new THREE.MeshStandardNodeMaterial({ color: 0xe9e5d8, metalness: 0, roughness: 0.85, flatShading: true });
    const polycarb = new THREE.MeshStandardNodeMaterial({ color: 0xdfe5ea, metalness: 0, roughness: 0.4, flatShading: true });
    make('fibre', () => shardShape(this.rng, new THREE.Vector3(range(this.rng, 0.025, 0.05), 0.0018, range(this.rng, 0.003, 0.006))), carbon);
    make('shaving', () => shardShape(this.rng, new THREE.Vector3(range(this.rng, 0.012, 0.024), 0.0015, range(this.rng, 0.008, 0.014))), uhmw);
    make('flake', () => shardShape(this.rng, new THREE.Vector3(range(this.rng, 0.01, 0.022), 0.002, range(this.rng, 0.008, 0.016))), polycarb);
  }

  /** Pieces on screen, moving or at rest. The oldest piece of a kind is recycled when its pool is full. */
  get total(): number {
    return this.species.reduce((s, sp) => s + sp.pieces.length, 0);
  }

  get moving(): number {
    return this.species.reduce((s, sp) => s + sp.pieces.filter((p) => !p.body.asleep).length, 0);
  }

  /**
   * Throw `count` pieces of `kind` from `pos`. They leave within a cone around `dir`
   * (unit) at roughly `speed` m/s, tumbling.
   */
  throw(kind: DebrisKind, count: number, pos: THREE.Vector3, dir: THREE.Vector3, speed: number, spread = 1.1, inherit?: THREE.Vector3): void {
    const list = this.byKind.get(kind);
    if (!list) return;
    for (let i = 0; i < count; i++) {
      const sp = list[Math.floor(this.rng() * list.length)];
      const piece = this.allocate(sp);
      const b = piece.body;
      b.pos.copy(pos).addScaledVector(randomInCone(this.rng, dir, Math.PI, TMP), sp.shape.radius * 1.5);
      randomInCone(this.rng, dir, spread, b.vel).multiplyScalar(speed * range(this.rng, 0.5, 1.3));
      if (inherit) b.vel.add(inherit);
      b.quat.setFromEuler(EULER.set(this.rng() * 6.28, this.rng() * 6.28, this.rng() * 6.28));
      b.angVel.set(range(this.rng, -1, 1), range(this.rng, -1, 1), range(this.rng, -1, 1)).multiplyScalar(range(this.rng, 8, 30));
      wake(b);
    }
  }

  private allocate(sp: Species): Piece {
    if (sp.pieces.length < sp.capacity) {
      const body = makeBody(sp.shape.support, sp.shape.radius, sp.shape.massKg, restitutionFor(sp.kind));
      const piece: Piece = { body, slot: sp.pieces.length };
      sp.pieces.push(piece);
      sp.mesh.count = Math.max(1, sp.pieces.length);
      return piece;
    }
    const piece = sp.pieces[sp.next];
    sp.next = (sp.next + 1) % sp.capacity;
    return piece;
  }

  update(dt: number): void {
    // Two substeps keep fast tumbling bolts from sinking through the canvas.
    const h = dt / 2;
    for (const sp of this.species) {
      let dirty = false;
      for (const p of sp.pieces) {
        if (p.body.asleep) continue;
        stepBody(p.body, h, this.env);
        stepBody(p.body, h, this.env);
        MAT.compose(p.body.pos, p.body.quat, ONE);
        sp.mesh.setMatrixAt(p.slot, MAT);
        dirty = true;
      }
      if (dirty) sp.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Remove every piece (between rounds). */
  clear(): void {
    for (const sp of this.species) {
      for (const p of sp.pieces) sp.mesh.setMatrixAt(p.slot, COLLAPSED);
      sp.mesh.instanceMatrix.needsUpdate = true;
      sp.pieces.length = 0;
      sp.next = 0;
      sp.mesh.count = 1;
    }
  }

  dispose(): void {
    const materials = new Set<THREE.Material>();
    for (const sp of this.species) {
      sp.shape.geometry.dispose();
      materials.add(sp.mesh.material as THREE.Material);
      sp.mesh.dispose();
    }
    for (const m of materials) m.dispose();
  }
}

function restitutionFor(kind: DebrisKind): { restitution: number; friction: number } {
  switch (kind) {
    case 'bolt':
    case 'nut':
      return { restitution: 0.35, friction: 0.45 };
    case 'chip':
      return { restitution: 0.2, friction: 0.7 };
    case 'fibre':
    case 'shaving':
    case 'flake':
      return { restitution: 0.12, friction: 0.8 };
    default:
      return { restitution: 0.18, friction: 0.6 };
  }
}

const TMP = new THREE.Vector3();
const EULER = new THREE.Euler();
const MAT = new THREE.Matrix4();
const ONE = new THREE.Vector3(1, 1, 1);
const COLLAPSED = new THREE.Matrix4().makeScale(0, 0, 0);
