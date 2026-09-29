// The kit's main surface shader (TSL). One graph serves painted armor, the structural frame
// and machined actuator metal; skins and flavors only change uniform values, so every robot
// shares one compiled program. Layers, bottom to top:
//   base paint (+ patchwork, tint) → accent pattern → carbon weave → decals → rust →
//   edge chips + primer rim → scratches → grime → scorch / temper → hot-metal darkening.
// Per-object uniforms (heat, wear, seed) come from mesh.userData.kit (see part-builder.ts).
import * as THREE from 'three/webgpu';
import type { SkinParams } from './skins';
import {
  abs, attribute, clamp, float, floor, fract, max, mix, mod, mx_noise_float,
  normalLocal, positionLocal, positionWorld, select, sin, smoothstep, step, texture, uniform, vec2, vec3, type Nd,
} from './tsl';
import { bumpNormal, fbm01, heatColor, objectValue, planar, scratchLines, srgb } from './tsl-util';

export type KitFlavor = 'paint' | 'trim' | 'glove' | 'frame' | 'mech';

const HEAT_GLOW = 0.55; // emissive gain for overheated metal (higher saturates to a flat cream under ACES)
const CHIP_DEPTH_M = 0.0005; // bump depth of chipped paint
const SCRATCH_DEPTH_M = 0.00015;
const DUST_HEIGHT_M = 0.45; // dust fades out this far above the canvas

interface FlavorTuning {
  accent: number;
  decals: number;
  wear: number;
  neon: number;
  colorVar: number;
  chipMetal: number; // chips and scratches expose bare metal (1) or scuffed material (0)
}

const FLAVOR: Record<KitFlavor, FlavorTuning> = {
  paint: { accent: 1, decals: 1, wear: 1, neon: 1, colorVar: 1, chipMetal: 1 },
  trim: { accent: 0, decals: 1, wear: 0.8, neon: 1, colorVar: 0.6, chipMetal: 1 },
  glove: { accent: 0, decals: 0, wear: 0.7, neon: 0, colorVar: 0.5, chipMetal: 0 },
  frame: { accent: 0, decals: 0, wear: 0.55, neon: 0, colorVar: 0.5, chipMetal: 1 },
  mech: { accent: 0, decals: 0, wear: 0.35, neon: 0, colorVar: 0.3, chipMetal: 1 },
};

/** Padded leather: satin, a light sheen, scuffs to a paler leather instead of metal. */
/** Shine limits (see the roughness node below). */
const ROUGHNESS_FLOOR = 0.3;
const CLEARCOAT_SCALE = 0.35;

const GLOVE_LEATHER = { metal: 0, rough: 0.5, clearcoat: 0.35, clearcoatRough: 0.35 };

function scaleHex(hex: string, k: number): string {
  const c = new THREE.Color(hex);
  c.lerp(new THREE.Color(k > 1 ? '#ffffff' : '#000000'), Math.abs(k - 1));
  return `#${c.getHexString()}`;
}

/** Selects one of the accent patterns by mode (see ACCENT in skins.ts). */
function accentColor(mode: Nd, base: Nd, a: Nd, b: Nd, p: Nd, decalU: Nd, variant: Nd): Nd {
  const hazard = mix(b, a, step(0.5, fract(p.x.add(p.y).add(p.z).mul(8.5))));
  const du = abs(decalU.sub(0.5));
  const racing = mix(base, a, step(0.06, du).mul(step(du, 0.15)));
  const patch = mix(a, b, step(0.5, variant));
  return select(mode.lessThan(0.5), hazard, select(mode.lessThan(1.5), racing, select(mode.lessThan(2.5), a, select(mode.lessThan(3.5), patch, a))));
}

/** Carbon-fibre 2×2 twill brightness for planar coordinates in metres. */
function carbonWeave(q: Nd): Nd {
  const cq = q.mul(150);
  const cell = floor(cq);
  const f = fract(cq);
  const twill = step(2.0, mod(cell.x.add(cell.y), 4.0));
  const thread = mix(f.x, f.y, twill);
  return mix(float(0.5), float(1.0), sin(thread.mul(Math.PI))).mul(mix(float(0.8), float(1.15), twill));
}

export interface KitMaterialOptions {
  skin: SkinParams;
  flavor: KitFlavor;
  atlas: THREE.Texture | null;
  /** Glove flavor: the leather colour (gloves and headgear keep it in every skin). */
  gloveColor?: string;
}

export function createKitMaterial({ skin, flavor, atlas, gloveColor }: KitMaterialOptions): THREE.MeshPhysicalNodeMaterial {
  const tune = FLAVOR[flavor];
  const glove = flavor === 'glove';
  const leather = gloveColor ?? '#9e1a1f';
  const layer = flavor === 'paint' ? skin.paint : flavor === 'trim' ? skin.trim : flavor === 'frame' ? skin.frame : flavor === 'mech' ? skin.mech
    : { color: leather, metal: GLOVE_LEATHER.metal, rough: GLOVE_LEATHER.rough };
  const alts = flavor === 'paint' ? skin.paintAlt : [];
  const U = {
    base: uniform(srgb(layer.color)),
    alt0: uniform(srgb(alts[0] ?? layer.color)),
    alt1: uniform(srgb(alts[1] ?? layer.color)),
    alt2: uniform(srgb(alts[2] ?? layer.color)),
    alt3: uniform(srgb(alts[3] ?? layer.color)),
    altCount: uniform(alts.length),
    colorVar: uniform(skin.colorVar * tune.colorVar),
    metal: uniform(layer.metal),
    rough: uniform(layer.rough),
    clearcoat: uniform(flavor === 'paint' ? skin.clearcoat : flavor === 'trim' ? skin.clearcoat * 0.6 : glove ? GLOVE_LEATHER.clearcoat : 0),
    ccRough: uniform(glove ? GLOVE_LEATHER.clearcoatRough : skin.clearcoatRough),
    accentOn: uniform(tune.accent),
    accentMode: uniform(skin.accentMode),
    accentA: uniform(srgb(skin.accentA)),
    accentB: uniform(srgb(skin.accentB)),
    bare: uniform(srgb(glove ? scaleHex(leather, 1.35) : skin.bare)),
    primer: uniform(srgb(glove ? scaleHex(leather, 0.6) : skin.primer)),
    chipMetal: uniform(tune.chipMetal * (flavor === 'paint' || flavor === 'trim' ? skin.bareMetal ?? 1 : 1)),
    wear: uniform(skin.wear * tune.wear),
    scratches: uniform(skin.scratches * tune.wear * (glove ? 0.35 : 1)),
    grime: uniform(skin.grime),
    grimeColor: uniform(srgb(skin.grimeColor)),
    rust: uniform(glove ? 0 : skin.rust * (flavor === 'mech' ? 0.5 : 1)),
    carbon: uniform(flavor === 'mech' || glove ? 0 : skin.carbon),
    neon: uniform(srgb(skin.neon).multiplyScalar(skin.neonIntensity * tune.neon)),
    decalOn: uniform(atlas ? tune.decals : 0),
    // Numbers on trim (shin guards) are painted in the main colour so they read on the pale trim.
    decalFill: uniform(srgb(flavor === 'trim' && skin.id === 'livery' ? skin.paint.color : skin.decalFill)),
    decalLine: uniform(srgb(skin.decalLine)),
    decalOpacity: uniform(skin.decalOpacity),
    dust: uniform(skin.dust),
    dustColor: uniform(srgb(skin.dustColor)),
  };
  const uGround = uniform(0); // scene y of the physics canvas, set by updateRobotKit

  const p = positionLocal;
  const n = normalLocal;
  const surf = attribute('aSurf', 'vec4');
  const dec = attribute('aDecal', 'vec4');
  const dmg = attribute('aDamage', 'vec4');
  const oHeat = objectValue('heat', 0);
  const oWear = objectValue('wear', 0);
  const oSeed = objectValue('seed', 0);

  const ps = p.add(vec3(oSeed.mul(17.3), oSeed.mul(-9.1), oSeed.mul(5.7)));
  const q = planar(p, n);
  const variant = fract(surf.w.mul(7.13).add(oSeed.mul(3.1)));

  // Base paint with patchwork and large-scale tint variation.
  const pick = floor(variant.mul(U.altCount.add(1)));
  const band = (k: number) => step(k - 0.5, pick).mul(step(pick, k + 0.5));
  let col: Nd = U.base;
  col = mix(col, U.alt0, band(1));
  col = mix(col, U.alt1, band(2));
  col = mix(col, U.alt2, band(3));
  col = mix(col, U.alt3, band(4));
  const tint = fbm01(ps.mul(2.2), 3).sub(0.5).mul(2.0);
  col = col.mul(float(1).add(tint.mul(U.colorVar)));

  // Accent plates and carbon weave.
  const accent = surf.z.mul(U.accentOn);
  col = mix(col, accentColor(U.accentMode, col, U.accentA, U.accentB, p, dec.x, variant), accent);
  col = mix(col, col.mul(carbonWeave(q)), U.carbon);

  // Decals from the atlas (cells 0..3 = kinds 2..5).
  if (atlas) {
    const kind = dec.z;
    const inRect = step(0.0, dec.x).mul(step(dec.x, 1.0)).mul(step(0.0, dec.y)).mul(step(dec.y, 1.0));
    const cell = kind.sub(2.0);
    const offset = vec2(mod(cell, 2.0), floor(cell.mul(0.5))).mul(0.5);
    const tex = texture(atlas, offset.add(clamp(dec.xy, 0.005, 0.995).mul(0.5)));
    const on = step(1.5, kind).mul(dec.w).mul(inRect).mul(U.decalOn).mul(U.decalOpacity);
    col = mix(col, U.decalLine, tex.g.mul(on));
    col = mix(col, U.decalFill, tex.r.mul(on));
  }

  // Rust (scrapyard, a touch on military).
  const rn = fbm01(ps.mul(9.0), 4, 0.55);
  const pit = mx_noise_float(ps.mul(70.0)).mul(0.5).add(0.5);
  const rustOn = step(0.001, U.rust);
  const rustMask = smoothstep(0.35, 0.6, rn.add(U.rust.sub(0.62)).add(surf.y.mul(0.25)).add(surf.x.mul(0.15))).mul(rustOn);
  const streak = smoothstep(0.55, 0.95, mx_noise_float(vec3(ps.x.mul(26), ps.y.mul(26), ps.z.mul(2.2))).mul(0.5).add(0.5)).mul(U.rust);
  const rustAmt = clamp(max(rustMask, streak.mul(0.55)), 0.0, 1.0);
  col = mix(col, mix(vec3(0.2, 0.07, 0.025), vec3(0.44, 0.17, 0.05), pit), rustAmt);

  // Edge chips with a primer rim, then scratches down to bare metal. Chips need both an edge
  // and a noise peak, so worn bevels break up instead of outlining every plate.
  const chipN = fbm01(ps.mul(34.0), 3, 0.55);
  const wearAmt = U.wear.add(oWear.mul(0.45));
  const chipV = surf.x.mul(0.42).add(chipN.mul(0.62)).add(wearAmt.mul(0.3)).add(oWear.mul(0.2)).add(dmg.z.mul(0.7));
  const chip = smoothstep(0.93, 0.95, chipV);
  const rim = smoothstep(0.88, 0.93, chipV).sub(chip);
  col = mix(col, U.primer, rim.mul(0.75).mul(tune.accent));
  col = mix(col, U.bare, chip);
  const lines = scratchLines(q.add(vec2(oSeed.mul(3.0), oSeed)), 4.0);
  const density = mx_noise_float(ps.mul(2.6)).mul(0.5).add(0.5);
  const scratch = lines.mul(smoothstep(0.62, 0.95, density.add(U.scratches.mul(0.3)).add(oWear.mul(0.35)).add(dmg.x.mul(1.3))));
  col = mix(col, U.bare, scratch.mul(0.7));

  // Grime in cavities, vertical streaks and battle wear.
  const gN = fbm01(ps.mul(4.5), 3);
  const drip = smoothstep(0.55, 0.95, mx_noise_float(vec3(ps.x.mul(20), ps.y.mul(20), ps.z.mul(1.4))).mul(0.5).add(0.5));
  const grime = clamp(surf.y.mul(0.75).add(gN.mul(U.grime).mul(0.6)).add(drip.mul(U.grime).mul(0.4)).add(oWear.mul(0.3)).sub(0.2), 0.0, 1.0);
  col = mix(col, U.grimeColor, grime.mul(0.8));

  // Canvas dust settles on whatever is nearest the floor (feet, shins, a fallen robot's side).
  const dustN = fbm01(ps.mul(7.0), 2);
  const dust = smoothstep(DUST_HEIGHT_M, 0.0, positionWorld.y.sub(uGround)).mul(U.dust).mul(dustN.mul(0.8).add(0.4));
  col = mix(col, U.dustColor, clamp(dust, 0.0, 0.85));

  // Impact damage: soot and a temper-colour ring.
  const scorch = clamp(dmg.y.mul(float(0.8).add(gN.mul(0.5))), 0.0, 1.0);
  const temper = smoothstep(0.04, 0.25, dmg.y).mul(float(1).sub(smoothstep(0.25, 0.6, dmg.y)));
  col = mix(col, mix(vec3(0.5, 0.36, 0.14), vec3(0.16, 0.18, 0.42), gN), temper.mul(0.4));
  col = mix(col, vec3(0.02, 0.018, 0.016), scorch.mul(0.9));
  col = mix(col, col.mul(0.3), smoothstep(0.4, 1.0, oHeat));

  let metal: Nd = U.metal;
  let rough: Nd = U.rough.add(mx_noise_float(ps.mul(12.0)).mul(0.05));
  metal = mix(metal, float(0.1), rustAmt);
  rough = mix(rough, float(0.9), rustAmt);
  metal = mix(metal, float(1.0), max(chip, scratch).mul(U.chipMetal));
  rough = mix(rough, float(0.32), chip);
  rough = mix(rough, float(0.24), scratch);
  rough = mix(rough, float(0.92), grime.mul(0.55));
  metal = mix(metal, float(0.2), grime.mul(0.6));
  rough = mix(rough, float(0.9), clamp(dust, 0.0, 0.8));
  metal = mix(metal, float(0.15), clamp(dust, 0.0, 0.8));
  rough = mix(rough, float(0.95), scorch);
  metal = mix(metal, float(0.05), scorch);

  const m = new THREE.MeshPhysicalNodeMaterial();
  m.name = `kit-${flavor}-${skin.id}`;
  m.userData.groundUniform = uGround;
  m.colorNode = col;
  m.metalnessNode = clamp(metal, 0.0, 1.0);
  // Chris: the bodies were too shiny and glared under the arena lights. A roughness floor stops
  // mirror-like highlights and the clearcoat runs at a third, so metal still reads as metal.
  m.roughnessNode = clamp(rough, ROUGHNESS_FLOOR, 1.0);
  const coat = U.clearcoat.mul(CLEARCOAT_SCALE).mul(float(1).sub(chip)).mul(float(1).sub(grime.mul(0.8))).mul(float(1).sub(scorch)).mul(float(1).sub(rustAmt));
  m.clearcoatNode = coat;
  m.clearcoatRoughnessNode = U.ccRough.add(scratch.mul(0.3)).max(0.18);
  // Neon runs only on the crisp bevel strips (edge weight 1), not the soft falloff around them.
  const neonLine = smoothstep(0.985, 1.0, surf.x).mul(float(1).sub(chip)).mul(float(1).sub(scorch));
  const heatGlow = heatColor(oHeat).mul(smoothstep(0.35, 1.0, oHeat)).mul(float(0.7).add(gN.mul(0.6))).mul(HEAT_GLOW);
  m.emissiveNode = U.neon.mul(neonLine).add(heatGlow);
  const height = chip.mul(-CHIP_DEPTH_M).add(scratch.mul(-SCRATCH_DEPTH_M)).add(rustAmt.mul(pit).mul(0.0006));
  m.normalNode = bumpNormal(height);
  return m;
}
