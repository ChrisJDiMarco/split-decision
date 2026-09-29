// Hydraulic oil as a real particle fluid (threejs-particle-fluids, Position Based
// Fluids on WebGPU). Every particle waits pinned far below the canvas; leaks release
// them from the vent with pressure-driven velocity, the solver gives the jet cohesion,
// splash and spreading, the canvas is an SDF plane, and the pooled particles feed the
// OilFilm puddles and stains. The pool is a ring: when it wraps, the oldest oil on the
// floor is re-used for the newest spurt (its stain stays behind).
import * as THREE from 'three/webgpu';
import {
  Fn, If, float, hash, instanceIndex, instancedArray, length, select, smoothstep, step, uniform, uint,
  vec3, vec4,
} from 'three/tsl';
import type ComputeNode from 'three/src/nodes/gpgpu/ComputeNode.js';
import { FluidSystem, ParticleSystem, PrimitiveSet, SimLoop } from 'threejs-particle-fluids';
import { FLOOR_Y, randomInCone, range, type Rng } from '../coords';
import type { Any } from '../tsl-any';
import { OilFilm } from './oil-film';
import { OIL_DENSITY, type OilSystem } from './oil-look';
import { oilStreakMaterial, streakQuad } from './oil-streaks';

export const OIL_CAPACITY = 6144;
/** Particle radius (m): 1 cm spacing, ~1 mL per particle. */
export const OIL_RADIUS = 0.005;
const MAX_SPAWN_PER_FRAME = 256;
const PARK_Y = -2;
const PARK_SPACING = 0.1;
/** The solver sleeps once nothing has been released for this long and the oil has settled. */
const SETTLE_S = 6;
const SUBSTEPS = 3;
const ITERATIONS = 2;
/** Oil drags on the canvas weave, so puddles stop spreading. */
const CANVAS_FRICTION = { muS: 1.0, muK: 0.8 };
/** Longest solver step; a slow frame is split so fast jets can't tunnel. */
const MAX_STEP_S = 1 / 50;
/** Droplet instances drawn per particle, and the time gap between them (s). */
const SUBDROPS = 3;
const SUBDROP_LAG_S = 1 / 150;

export class FluidOil implements OilSystem {
  readonly object = new THREE.Group();
  readonly kind = 'fluid' as const;
  private readonly particles: ParticleSystem;
  private readonly fluid: FluidSystem;
  private readonly loop: SimLoop;
  private readonly film: OilFilm;
  private readonly floor: PrimitiveSet;
  private readonly spawnPos = instancedArray(MAX_SPAWN_PER_FRAME, 'vec4');
  private readonly spawnVel = instancedArray(MAX_SPAWN_PER_FRAME, 'vec4');
  private readonly spawnStart = uniform(0, 'uint' as 'float') as Any;
  private readonly spawnCount = uniform(0, 'uint' as 'float') as Any;
  private readonly emitKernel: ComputeNode;
  private readonly parkKernel: ComputeNode;
  private readonly droplets: THREE.InstancedMesh;
  private pending = 0;
  private cursor = 0;
  private released = 0;
  private sinceEmit = Infinity;
  private readonly rng: Rng;

  constructor(private readonly renderer: THREE.WebGPURenderer, rng: Rng) {
    this.rng = rng;
    this.object.name = 'vfx.oil.fluid';
    this.particles = new ParticleSystem(renderer, OIL_CAPACITY, OIL_RADIUS);
    this.particles.uploadParticles(Array.from({ length: OIL_CAPACITY }, (_, k) => ({ position: parkPosition(k) })));
    this.fluid = new FluidSystem(this.particles, {
      restDensity: OIL_DENSITY,
      viscosity: 0.12,
      surfaceTension: 0.25,
      vorticity: 0.01,
    });
    this.particles.setInvMass(this.fluid.range, 0);
    this.floor = new PrimitiveSet(this.particles);
    this.floor.addPlane(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, FLOOR_Y, 0), CANVAS_FRICTION);
    this.loop = new SimLoop(this.particles, {
      substeps: SUBSTEPS,
      iterations: ITERATIONS,
      colliders: [this.floor],
      materials: [this.fluid],
      hashOrigin: new THREE.Vector3(0, -0.5, 0),
    });
    this.emitKernel = this.buildEmit();
    this.parkKernel = this.buildPark();
    this.film = new OilFilm(this.particles, renderer);
    this.droplets = this.buildDroplets();
    this.object.add(this.film.mesh, this.droplets);
    this.warmUp();
  }

  /**
   * Compile every compute pipeline now (load time) rather than on the first leak of
   * the fight: one solver step, an empty emit and a film pass over parked particles.
   */
  private warmUp(): void {
    this.renderer.compute(this.emitKernel);
    this.loop.step(1 / 60).catch((err: unknown) => console.error('[vfx] oil solver warm-up failed', err));
    this.film.update(1 / 60);
  }

  get activeParticles(): number {
    return Math.min(this.released, OIL_CAPACITY);
  }

  spray(pos: THREE.Vector3, dir: THREE.Vector3, speed: number, count: number, spread: number, inherit: THREE.Vector3): void {
    const pa = this.spawnPos.value.array as Float32Array;
    const va = this.spawnVel.value.array as Float32Array;
    for (let k = 0; k < count && this.pending < MAX_SPAWN_PER_FRAME; k++) {
      const i = this.pending++;
      randomInCone(this.rng, dir, spread, V).multiplyScalar(speed * range(this.rng, 0.85, 1.1)).add(inherit);
      // Spread the frame's particles along the stream (≥ one spacing apart) so the
      // solver doesn't see them overlap and blow apart.
      const lead = (k / Math.max(1, count)) / 60 + range(this.rng, 0, 0.002);
      pa[i * 4] = pos.x + V.x * lead + range(this.rng, -0.004, 0.004);
      pa[i * 4 + 1] = Math.max(FLOOR_Y + OIL_RADIUS, pos.y + V.y * lead);
      pa[i * 4 + 2] = pos.z + V.z * lead + range(this.rng, -0.004, 0.004);
      pa[i * 4 + 3] = 0;
      va[i * 4] = V.x; va[i * 4 + 1] = V.y; va[i * 4 + 2] = V.z; va[i * 4 + 3] = 0;
    }
  }

  update(dt: number): void {
    if (dt <= 0) return;
    const emitting = this.pending > 0;
    if (emitting) this.flushSpawns();
    this.sinceEmit = emitting ? 0 : this.sinceEmit + dt;
    const awake = this.sinceEmit < SETTLE_S && this.released > 0;
    // Only ring slots that have ever been released can be airborne.
    // (At least one: a parked, zero-width instance keeps the pipeline compiled.)
    this.droplets.count = awake ? Math.min(this.released, OIL_CAPACITY) * SUBDROPS : 1;
    if (!awake) return;
    // SimLoop.step submits its compute passes synchronously on an initialised
    // renderer (the promise only reports errors), so steps and the film queue in order.
    const steps = Math.ceil(dt / MAX_STEP_S);
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      this.loop.step(h).catch((err: unknown) => console.error('[vfx] oil solver step failed', err));
    }
    this.film.update(dt);
  }

  private flushSpawns(): void {
    this.spawnPos.value.needsUpdate = true;
    this.spawnVel.value.needsUpdate = true;
    this.spawnStart.value = this.cursor;
    this.spawnCount.value = this.pending;
    this.renderer.compute(this.emitKernel);
    this.cursor = (this.cursor + this.pending) % OIL_CAPACITY;
    this.released += this.pending;
    this.pending = 0;
  }

  /** Move spawn records into their ring slots and give them mass. */
  private buildEmit(): ComputeNode {
    const p = this.particles;
    const fluid = this.fluid;
    return Fn(() => {
      const k: Any = instanceIndex;
      If(k.lessThan(this.spawnCount), () => {
        const slot: Any = this.spawnStart.add(k).mod(uint(OIL_CAPACITY));
        const pos: Any = vec4(this.spawnPos.element(k).xyz, 0);
        p.positions.element(slot).assign(pos);
        p.predictedPositions.element(slot).assign(pos);
        p.velocities.element(slot).assign(vec4(this.spawnVel.element(k).xyz, 0));
        p.invMass.element(slot).assign(1 / fluid.mass);
        // Released particles had no neighbours while parked; their density is stale.
        fluid.density.element(slot).assign(fluid.restDensity);
      });
    })().compute(MAX_SPAWN_PER_FRAME).setName('FluidOil.emit');
  }

  /** Pin every particle back in its parking spot (clear between rounds). */
  private buildPark(): ComputeNode {
    const p = this.particles;
    const perRow = parkPerRow();
    return Fn(() => {
      const i: Any = instanceIndex;
      const x: Any = i.mod(perRow).toFloat().mul(PARK_SPACING).sub(perRow * PARK_SPACING * 0.5);
      const z: Any = i.div(perRow).toFloat().mul(PARK_SPACING).sub(perRow * PARK_SPACING * 0.5);
      const pos: Any = vec4(x, PARK_Y, z, 0);
      p.positions.element(i).assign(pos);
      p.predictedPositions.element(i).assign(pos);
      p.velocities.element(i).assign(vec4(0));
      p.invMass.element(i).assign(0);
    })().compute(OIL_CAPACITY).setName('FluidOil.park');
  }

  /**
   * Airborne oil as motion streaks read straight from the solver's buffers. Pooled
   * particles fade out: the film draws those. SUBDROPS instances per particle (the
   * particle plus smaller satellites strung out behind it) make a jet read as a broken
   * stream rather than a row of beads.
   */
  private buildDroplets(): THREE.InstancedMesh {
    const particle: Any = instanceIndex.div(SUBDROPS);
    const sub: Any = instanceIndex.mod(SUBDROPS).toFloat();
    const v: Any = this.particles.velocities.element(particle).xyz;
    const jitter: Any = vec3(hash(instanceIndex), hash(instanceIndex.add(7)), hash(instanceIndex.add(13))).sub(0.5).mul(sub.mul(0.006));
    const p: Any = this.particles.positions.element(particle).xyz.sub(v.mul(sub.mul(SUBDROP_LAG_S))).add(jitter);
    const speed: Any = length(v);
    const height: Any = p.y.sub(FLOOR_Y);
    const airborne: Any = smoothstep(OIL_RADIUS * 1.5, OIL_RADIUS * 4, height).max(smoothstep(0.35, 1.0, speed));
    const live: Any = step(PARK_Y * 0.5, p.y);
    // Satellites only show while the particle is flying fast.
    const satellite: Any = (select as Any)(sub.greaterThan(0), smoothstep(1, 2.5, speed).mul(0.55), float(1));
    const width: Any = float(OIL_RADIUS * 1.4).mul(airborne).mul(live).mul(satellite);
    const m = oilStreakMaterial({ pos: p, vel: v, width });
    const mesh = new THREE.InstancedMesh(streakQuad(), m, OIL_CAPACITY * SUBDROPS);
    mesh.count = 1;
    mesh.frustumCulled = false;
    mesh.renderOrder = 12;
    return mesh;
  }

  clear(): void {
    this.renderer.compute(this.parkKernel);
    this.film.clear();
    this.cursor = 0;
    this.released = 0;
    this.pending = 0;
    this.sinceEmit = Infinity;
    this.droplets.count = 1;
  }

  dispose(): void {
    this.emitKernel.dispose();
    this.parkKernel.dispose();
    this.film.dispose();
    this.droplets.geometry.dispose();
    (this.droplets.material as THREE.Material).dispose();
    this.loop.dispose();
    this.floor.dispose();
    this.particles.dispose();
  }
}

function parkPerRow(): number {
  return Math.ceil(Math.sqrt(OIL_CAPACITY));
}

/** Sparse grid far below the canvas; spacing ≫ smoothing radius, so no neighbours. */
function parkPosition(k: number): [number, number, number] {
  const perRow = parkPerRow();
  return [
    (k % perRow) * PARK_SPACING - perRow * PARK_SPACING * 0.5,
    PARK_Y,
    Math.floor(k / perRow) * PARK_SPACING - perRow * PARK_SPACING * 0.5,
  ];
}

const V = new THREE.Vector3();
