// Impact flash: one pooled point light that lights the robots and canvas for a few
// frames, plus short-lived glare sprites at the contact. The light always exists (with
// zero intensity when idle) so the scene's light count never changes and no shader
// recompiles mid-fight. Idle glares stay in the draw list, dark and shrunk to nothing,
// so their pipeline also compiles at load rather than on the first hit.
import * as THREE from 'three/webgpu';
import { float, length, uv, vec4, uniform } from 'three/tsl';
import { flashIntensity } from './scaling';

const LIGHT_DECAY_PER_S = 38;
const GLARE_LIFE_S = 0.09;
const MAX_GLARES = 8;
/** Largest glare sprite, metres: a bigger one reads as a white-out, not a hit. */
const MAX_GLARE_SIZE_M = 0.4;
/** Glares closer to the camera than this fade out, so a close replay angle never flashes the lens. */
const LENS_FADE_NEAR_M = 1.2;
const LENS_FADE_FAR_M = 3.0;
/** Flash strength during slow-motion replays: the moment reads without blinding the viewer. */
const REPLAY_SCALE = 0.3;
const FLASH_COLOR = new THREE.Color(1.0, 0.72, 0.42);
/** Size of an idle glare: drawn (so it is compiled) but covering no pixels. */
const IDLE_SCALE = 1e-5;

interface Glare {
  sprite: THREE.Sprite;
  age: number;
  life: number;
  size: number;
  active: boolean;
  peak: number; // starting strength after replay and lens-distance scaling
  strength: ReturnType<typeof uniform<'float', number>>;
}

const CAM = new THREE.Vector3();

export class FlashSystem {
  readonly object = new THREE.Group();
  private readonly light: THREE.PointLight;
  private readonly glares: Glare[] = [];
  private next = 0;
  private scale = 1;

  constructor(private readonly camera?: THREE.Camera) {
    this.object.name = 'vfx.flash';
    this.light = new THREE.PointLight(FLASH_COLOR, 0, 7, 2);
    this.light.castShadow = false;
    this.object.add(this.light);
    for (let i = 0; i < MAX_GLARES; i++) this.glares.push(this.makeGlare());
  }

  private makeGlare(): Glare {
    const strength = uniform(0, 'float');
    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const d = length(uv().sub(0.5)).mul(2);
    const falloff = float(1).sub(d).max(0).pow(3).add(float(1).sub(d).max(0).pow(12).mul(4));
    m.colorNode = vec4(float(2.6).mul(falloff).mul(strength), float(1.6).mul(falloff).mul(strength), float(0.75).mul(falloff).mul(strength), 1);
    const sprite = new THREE.Sprite(m);
    sprite.scale.setScalar(IDLE_SCALE);
    sprite.frustumCulled = false;
    sprite.renderOrder = 21;
    this.object.add(sprite);
    return { sprite, age: 0, life: GLARE_LIFE_S, size: 0.3, active: false, peak: 0, strength };
  }

  /** Replays show flashes dimmer (they also last longer, because the effects clock runs slow). */
  setReplay(replaying: boolean): void {
    this.scale = replaying ? REPLAY_SCALE : 1;
  }

  /** 1 far from the lens, fading to 0 when the flash is almost on the camera. */
  private lensFade(pos: THREE.Vector3): number {
    if (!this.camera) return 1;
    const d = this.camera.getWorldPosition(CAM).distanceTo(pos);
    return THREE.MathUtils.clamp((d - LENS_FADE_NEAR_M) / (LENS_FADE_FAR_M - LENS_FADE_NEAR_M), 0, 1);
  }

  flash(pos: THREE.Vector3, energyJ: number): void {
    const intensity = flashIntensity(energyJ) * this.scale;
    if (intensity > this.light.intensity) {
      this.light.intensity = intensity;
      this.light.position.copy(pos);
    }
    const g = this.glares[this.next];
    this.next = (this.next + 1) % MAX_GLARES;
    g.age = 0;
    g.life = GLARE_LIFE_S * (0.7 + Math.min(1.5, energyJ / 400));
    g.size = Math.min(MAX_GLARE_SIZE_M, 0.1 + Math.sqrt(energyJ) * 0.012);
    g.peak = this.scale * this.lensFade(pos);
    g.sprite.position.copy(pos);
    g.sprite.scale.setScalar(g.size);
    g.strength.value = g.peak;
    g.active = g.peak > 0.01;
    if (!g.active) g.sprite.scale.setScalar(IDLE_SCALE);
  }

  update(dt: number): void {
    this.light.intensity *= Math.exp(-LIGHT_DECAY_PER_S * dt);
    if (this.light.intensity < 0.01) this.light.intensity = 0;
    for (const g of this.glares) {
      if (!g.active) continue;
      g.age += dt;
      const t = g.age / g.life;
      if (t >= 1) {
        g.active = false;
        g.strength.value = 0;
        g.sprite.scale.setScalar(IDLE_SCALE);
        continue;
      }
      g.strength.value = g.peak * (1 - t) * (1 - t);
      g.sprite.scale.setScalar(g.size * (1 + t * 0.6));
    }
  }

  dispose(): void {
    for (const g of this.glares) (g.sprite.material as THREE.Material).dispose();
    this.light.dispose();
  }
}
