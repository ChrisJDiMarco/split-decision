// Routes physics events to effect systems. A landed strike reads by its strength (scaling.ts
// hitStrength): a shockwave ring along the struck surface and a small surface flash; padded or
// soft contacts (gloves, rubber) burst a soft dust puff and never spark; only bare metal on metal
// throws a short bright spark spray; the heaviest hits fling armor flecks. Tiny touches produce
// nothing. Heavy hits knock bolts loose; bodies slamming the canvas and hard foot plants raise
// dust (and a dust ring when it's heavy); detached parts shed their fasteners in a burst.
// Physical damage reads by material and cause (docs/design/strike-power.md §4.7): a cracked carbon
// panel throws dark fibre, a gouged UHMW shell sheds pale shavings, a polycarbonate crack throws
// flakes and a pale puff; at the joint itself a stripped gear sprays sparks and chips, a seize clacks
// with a few, a bent shaft crunches out flecks and grit, a hyperextension snaps with a bright flash, a
// struck drive housing sparks and puffs dark smoke, a blown seal mists.
import * as THREE from 'three/webgpu';
import type { SimEvent } from '../../core/protocol';
import { FLOOR_Y, randomInCone, range, toWorld, type Rng } from './coords';
import type { ContactSystem } from './contact';
import type { DebrisSystem } from './debris';
import type { FlashSystem } from './flash';
import { chipCount, debrisCount, dustPuffs, footDustPuffs, HIT, hitStrength, SPARK_MIN_ENERGY_J, strikeStrength } from './scaling';
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
/** Full-strength shockwave ring radius and life (effect seconds: it holds through hit-stop). */
const RING_RADIUS_M = 0.55;
const RING_LIFE_S = 0.2;
/** Canvas slams at or above this closing speed also throw a flat dust ring. */
const LANDING_RING_SPEED = 3.2;

export interface EffectSystems {
  sparks: SparkSystem;
  contact: ContactSystem;
  flash: FlashSystem;
  debris: DebrisSystem;
  smoke: SmokeSystem;
  /** Robot centre of mass (world), for events that carry no position. */
  com(corner: 0 | 1, out: THREE.Vector3): THREE.Vector3 | null;
}

/** `tel`: the frame's telemetry when known, so a ground scramble doesn't get strike marks. */
export function routeEvent(e: SimEvent, fx: EffectSystems, rng: Rng, tel?: readonly { down: boolean }[] | null): void {
  switch (e.kind) {
    case 'impact':
      impact(e, fx, rng, tel);
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
    case 'joint':
      jointEffect(e, fx, rng);
      break;
    default:
      break; // getup / ko have no particle effect of their own
  }
}

/** Effect "energy" (J, the spark and flash scales) for a joint failure at severity 1. */
export const JOINT_FX_J: Record<string, number> = { strip: 260, seize: 150, slip: 90, hyperextension: 220, fault: 110, wear: 40 };

/**
 * A joint failure at the joint (e.pos), by what failed. Thermal cooking and lost parts have their
 * own effects (smoke from telemetry, the detach burst); events without a position (the motor model's
 * thermal limp) have none.
 */
export function jointEffect(e: Extract<SimEvent, { kind: 'joint' }>, fx: EffectSystems, rng: Rng): void {
  if (!e.pos || !e.cause || !e.failure || e.cause === 'thermal' || e.cause === 'detach') return;
  if (e.failure === 'wear' && e.state === 'ok') return;
  toWorld(e.pos, P);
  const sev = Math.min(3, Math.max(1, e.severity ?? 1));
  D.copy(UP);
  switch (e.failure) {
    case 'strip':
    case 'seize':
    case 'slip':
    case 'wear': {
      const energy = JOINT_FX_J[e.failure] * sev;
      fx.sparks.burst(P, energy, { normal: randomInCone(rng, UP, 1.4, N) });
      const chips = e.failure === 'strip' ? 6 : e.failure === 'seize' ? 3 : e.failure === 'slip' ? 2 : 0;
      if (chips) fx.debris.throw('chip', chips, P, D, 2.2, 1.3);
      if (e.failure !== 'wear') fx.flash.flash(P, energy * 0.35);
      return;
    }
    case 'bend':
      // A crunch: flecks and grit out of the bearing, no sparks.
      fx.debris.throw('chip', Math.round(3 + 2 * sev), P, D, 1.6, 1.4);
      for (let i = 0; i < 4; i++) {
        randomInCone(rng, UP, 1.2, V).multiplyScalar(range(rng, 0.4, 1.1));
        fx.smoke.emit(P, V, { life: range(rng, 0.5, 0.9), size: range(rng, 0.03, 0.06), growth: 0.25, opacity: 0.22, dark: 0.3, buoyancy: 0.1, drag: 5, glow: 0, tint: 0.4 }, 0.02);
      }
      return;
    case 'hyperextension':
      fx.flash.flash(P, JOINT_FX_J.hyperextension * sev);
      fx.contact.flash(P, randomInCone(rng, UP, 1.5, N), 0.9, 0.12);
      fx.sparks.burst(P, 60 * sev, { countScale: 0.5 });
      fx.debris.throw('chip', 3, P, D, 2.0, 1.4);
      return;
    case 'fault':
      fx.sparks.burst(P, JOINT_FX_J.fault * sev, { countScale: 0.7, normal: randomInCone(rng, UP, 1.3, N) });
      fx.smoke.smokePuff(P, ZERO, 0.3, 0.7, 0);
      return;
    case 'seal':
      for (let i = 0; i < 3; i++) fx.smoke.smokePuff(P, ZERO, 0.35, 0, 0);
      return;
    default:
      return;
  }
}

/** Flecks off a shell a hit dented, cracked or gouged, by material. Metal sparks come with `metal`. */
export function shellFlecks(e: Extract<SimEvent, { kind: 'impact' }>, fx: EffectSystems, rng: Rng): void {
  const dent = e.dent;
  if (!dent) return;
  const size = Math.min(1, dent.depthM / 0.012 + dent.radiusM / 0.12);
  // Thrown back off the struck surface, toward the striker.
  D.copy(N).negate().addScaledVector(UP, 0.4).normalize();
  switch (dent.mode) {
    case 'crack':
      fx.debris.throw('fibre', Math.round(4 + 8 * size), P, D, 1.8 + 1.5 * size, 1.2);
      return;
    case 'gouge':
      fx.debris.throw('shaving', Math.round(3 + 6 * size), P, D, 1.4 + size, 1.3);
      return;
    case 'whiten': {
      if (dent.cracked) fx.debris.throw('flake', Math.round(3 + 5 * size), P, D, 1.6 + size, 1.2);
      basis(N);
      for (let i = 0; i < 3 + Math.round(4 * size); i++) {
        const a = rng() * Math.PI * 2;
        const v = 0.6 + 1.2 * size;
        V.copy(T1).multiplyScalar(Math.cos(a) * v).addScaledVector(T2, Math.sin(a) * v).addScaledVector(N, -0.3 * v);
        fx.smoke.emit(P, V, { life: range(rng, 0.4, 0.8), size: range(rng, 0.03, 0.06), growth: 0.3, opacity: 0.25, dark: 0, buoyancy: 0.1, drag: 6, glow: 0, tint: 1 }, 0.02);
      }
      return;
    }
    case 'dent':
      // Bare metal on metal already sparks; a dented aluminium frame sheds a couple of bright flakes.
      if (!e.metal) fx.debris.throw('chip', Math.round(1 + 3 * size), P, D, 1.5, 1.3);
      return;
  }
}

function impact(e: Extract<SimEvent, { kind: 'impact' }>, fx: EffectSystems, rng: Rng, tel?: readonly { down: boolean }[] | null): void {
  toWorld(e.pos, P);
  toWorld(e.normal, N);
  if (N.lengthSq() < 1e-8) N.set(0, 1, 0);
  N.normalize();
  const floorHit = e.striker === null && P.y < FLOOR_HIT_HEIGHT_M;
  const strike = e.striker !== null && e.victim !== null && e.striker !== e.victim;
  // Strike marks only for a clean strike; sparks for any real metal-on-metal contact (a ground scramble too).
  const strength = strikeStrength(e, tel);
  if (floorHit) canvasDust(e, fx);
  if (strike) strikeMarks(e, strength, fx, rng);
  if (e.dent) shellFlecks(e, fx, rng);
  // Bare metal on metal throws sparks (a landed strike only when it's more than a touch).
  if (e.metal && e.energyJ >= SPARK_MIN_ENERGY_J && (!strike || hitStrength(e.energyJ, e.impulseNs, e.speed) >= HIT.MIN)) {
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

/** The marks of a landed strike, all scaled by its strength; nothing below HIT.MIN. */
function strikeMarks(e: Extract<SimEvent, { kind: 'impact' }>, s: number, fx: EffectSystems, rng: Rng): void {
  if (s < HIT.MIN) return;
  if (!e.metal) thwackPuff(s, fx, rng);
  if (s >= HIT.RING) {
    const k = (s - HIT.RING) / (1 - HIT.RING);
    fx.contact.ring(P, N, { radius: RING_RADIUS_M * (0.45 + 0.55 * k), life: RING_LIFE_S * (0.75 + 0.5 * k), alpha: 0.28 + 0.4 * k, tint: 0 });
  }
  if (s >= HIT.FLASH) fx.contact.flash(P, N, 0.35 + 0.65 * s, 0.05 + 0.08 * s);
  if (s >= HIT.FLECKS) {
    // Paint and armor flecks thrown back off the struck surface, toward the striker.
    D.copy(N).negate().addScaledVector(UP, 0.35).normalize();
    fx.debris.throw('chip', Math.round(2 + 6 * (s - HIT.FLECKS) / (1 - HIT.FLECKS)), P, D, 1.6 + 2.2 * s, 1.0);
  }
}

/** A padded contact: a soft burst of dust squeezed out along the struck surface. No sparks. */
function thwackPuff(s: number, fx: EffectSystems, rng: Rng): void {
  const n = Math.round(2 + 9 * s);
  basis(N);
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2;
    const v = (0.9 + 2.6 * s) * range(rng, 0.55, 1.1);
    V.copy(T1).multiplyScalar(Math.cos(a) * v).addScaledVector(T2, Math.sin(a) * v).addScaledVector(N, -v * range(rng, 0.1, 0.4));
    POS.copy(P).addScaledVector(N, -0.03);
    fx.smoke.emit(POS, V, {
      life: range(rng, 0.35, 0.75) * (0.8 + 0.4 * s),
      size: range(rng, 0.04, 0.08) * (0.8 + 0.6 * s),
      growth: range(rng, 0.22, 0.38) * (0.7 + 0.6 * s),
      opacity: range(rng, 0.16, 0.3) * (0.6 + 0.5 * s),
      dark: 0,
      buoyancy: 0.15,
      drag: 7,
      glow: 0,
      tint: 0.85,
    }, 0.02);
  }
}

/** Dust off the canvas: small and low for a hard foot plant, a bigger cloud (and a ring) for a body slam. */
function canvasDust(e: Extract<SimEvent, { kind: 'impact' }>, fx: EffectSystems): void {
  const foot = !!e.part && e.part.startsWith('foot');
  if (foot) {
    const puffs = footDustPuffs(e.speed);
    if (puffs > 0) fx.smoke.dust(P, puffs, e.speed * 0.6);
    if (e.speed >= LANDING_RING_SPEED + 0.8) fx.contact.ring(POS.copy(P).setY(FLOOR_Y + 0.015), UP, { radius: 0.35, life: 0.3, alpha: 0.2, tint: 1 });
    return;
  }
  const puffs = dustPuffs(e.speed);
  if (puffs > 0) fx.smoke.dust(P, puffs, e.speed);
  if (e.speed >= LANDING_RING_SPEED) {
    const k = Math.min(1, (e.speed - LANDING_RING_SPEED) / 3);
    fx.contact.ring(POS.copy(P).setY(FLOOR_Y + 0.015), UP, { radius: 0.6 + 0.6 * k, life: 0.35 + 0.15 * k, alpha: 0.25 + 0.2 * k, tint: 1 });
  }
}

/** Two unit tangents of the plane with normal `n`, in T1 and T2. */
function basis(n: THREE.Vector3): void {
  T1.set(0, 1, 0);
  if (Math.abs(n.y) > 0.9) T1.set(1, 0, 0);
  T1.cross(n).normalize();
  T2.crossVectors(n, T1);
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
const T1 = new THREE.Vector3();
const T2 = new THREE.Vector3();
const POS = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Vector3(0, 0, 0);
