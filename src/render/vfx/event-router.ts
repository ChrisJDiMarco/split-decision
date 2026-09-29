// Routes physics events to effect systems: metal hits throw sparks, flashes and chips;
// heavy hits knock bolts and fragments loose; bodies slamming the canvas raise dust;
// detached parts shed their fasteners in a burst.
import * as THREE from 'three/webgpu';
import type { SimEvent } from '../../core/protocol';
import { FLOOR_Y, randomInCone, toWorld, type Rng } from './coords';
import type { DebrisSystem } from './debris';
import type { FlashSystem } from './flash';
import { chipCount, debrisCount, dustPuffs, SPARK_MIN_ENERGY_J } from './scaling';
import type { SmokeSystem } from './smoke';
import type { SparkSystem } from './sparks';

/** Impacts this close to the canvas count as floor hits (m). */
const FLOOR_HIT_HEIGHT_M = 0.3;
/** A detached part sheds its seam like a hit of this energy. */
const DETACH_ENERGY_J = 900;
/** The flash for a popped part is a modest pop: the sparks, bolts and flying part carry the moment. */
const DETACH_FLASH_J = 150;
/** Cage hits are chain link and posts: rattly, few sparks. */
const CAGE_SPARK_SCALE = 0.25;
/** Below this squared length a direction is degenerate and gets a fallback. */
const MIN_DIR_SQ = 1e-4;

export interface EffectSystems {
  sparks: SparkSystem;
  flash: FlashSystem;
  debris: DebrisSystem;
  smoke: SmokeSystem;
  /** Robot centre of mass (world), for events that carry no position. */
  com(corner: 0 | 1, out: THREE.Vector3): THREE.Vector3 | null;
}

export function routeEvent(e: SimEvent, fx: EffectSystems, rng: Rng): void {
  switch (e.kind) {
    case 'impact':
      impact(e, fx, rng);
      break;
    case 'detach':
      detach(e, fx, rng);
      break;
    case 'fall': {
      const com = fx.com(e.corner, P);
      if (com) fx.smoke.dust(com.setY(FLOOR_Y), dustPuffs(4.5), 4.5);
      break;
    }
    case 'cage': {
      toWorld(e.pos, P);
      const energy = 40 * e.speed * e.speed;
      fx.sparks.burst(P, energy, { countScale: CAGE_SPARK_SCALE, normal: N.set(-P.x, 0, -P.z).normalize() });
      break;
    }
    default:
      break; // joint / getup / ko have no particle effect of their own
  }
}

function impact(e: Extract<SimEvent, { kind: 'impact' }>, fx: EffectSystems, rng: Rng): void {
  toWorld(e.pos, P);
  toWorld(e.normal, N);
  if (N.lengthSq() < 1e-8) N.set(0, 1, 0);
  N.normalize();
  const floorHit = e.striker === null && P.y < FLOOR_HIT_HEIGHT_M;
  if (floorHit) {
    const puffs = dustPuffs(e.speed);
    if (puffs > 0) fx.smoke.dust(P, puffs, e.speed);
  }
  if (e.metal && e.energyJ >= SPARK_MIN_ENERGY_J) {
    fx.sparks.burst(P, e.energyJ, { normal: N });
    fx.flash.flash(P, e.energyJ);
    const chips = chipCount(e.energyJ);
    if (chips > 0) fx.debris.throw('chip', chips, P, N, 1.5 + Math.sqrt(e.energyJ) * 0.12, 1.3);
  }
  // Slamming into the canvas is spread over a big contact patch: it takes twice the
  // energy of a strike to shake hardware loose.
  const pieces = debrisCount(floorHit ? e.energyJ / 2 : e.energyJ);
  if (pieces > 0) {
    const speed = 1.2 + Math.sqrt(e.energyJ) * 0.09;
    // Up and away from the struck surface (straight up when the victim was driven down).
    D.copy(N).add(UP);
    if (D.lengthSq() < MIN_DIR_SQ) D.copy(UP);
    D.normalize();
    for (let i = 0; i < pieces; i++) {
      const r = rng();
      const kind = r < 0.4 ? 'bolt' : r < 0.6 ? 'nut' : r < 0.9 ? 'shard' : 'plate';
      fx.debris.throw(kind, 1, P, D, speed, 1.0);
    }
  }
}

function detach(e: Extract<SimEvent, { kind: 'detach' }>, fx: EffectSystems, rng: Rng): void {
  toWorld(e.pos, P);
  toWorld(e.vel, V);
  randomInCone(rng, UP, 1.2, D);
  fx.sparks.burst(P, DETACH_ENERGY_J, { normal: D });
  fx.flash.flash(P, DETACH_FLASH_J);
  // Sheared fasteners and a few fragments of the mount.
  fx.debris.throw('bolt', 3 + Math.floor(rng() * 4), P, UP, 2.4, 1.3, V);
  fx.debris.throw('nut', 1 + Math.floor(rng() * 3), P, UP, 2.0, 1.3, V);
  fx.debris.throw('shard', 1 + Math.floor(rng() * 3), P, UP, 1.8, 1.2, V);
  fx.debris.throw('chip', 8, P, UP, 2.5, 1.4, V);
  for (let i = 0; i < 6; i++) fx.smoke.smokePuff(P, V, 0.7, 0.75, 0);
}

const P = new THREE.Vector3();
const N = new THREE.Vector3();
const V = new THREE.Vector3();
const D = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
