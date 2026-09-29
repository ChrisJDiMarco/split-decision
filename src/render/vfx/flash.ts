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
const FLASH_COLOR = new THREE.Color(1.0, 0.72, 0.42);
/** Size of an idle glare: drawn (so it is compiled) but covering no pixels. */
const IDLE_SCALE = 1e-5;

interface Glare {
  sprite: THREE.Sprite;
  age: number;
  life: number;
  size: number;
  active: boolean;
  strength: ReturnType<typeof uniform<'float', number>>;
}

export class FlashSystem {
  readonly object = new THREE.Group();
  private readonly light: THREE.PointLight;
  private readonly glares: Glare[] = [];
  private next = 0;

  constructor() {
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
    m.colorNode = vec4(float(6).mul(falloff).mul(strength), float(3.6).mul(falloff).mul(strength), float(1.6).mul(falloff).mul(strength), 1);
    const sprite = new THREE.Sprite(m);
    sprite.scale.setScalar(IDLE_SCALE);
    sprite.frustumCulled = false;
    sprite.renderOrder = 21;
    this.object.add(sprite);
    return { sprite, age: 0, life: GLARE_LIFE_S, size: 0.3, active: false, strength };
  }

  flash(pos: THREE.Vector3, energyJ: number): void {
    const intensity = flashIntensity(energyJ);
    if (intensity > this.light.intensity) {
      this.light.intensity = intensity;
      this.light.position.copy(pos);
    }
    const g = this.glares[this.next];
    this.next = (this.next + 1) % MAX_GLARES;
    g.age = 0;
    g.life = GLARE_LIFE_S * (0.7 + Math.min(1.5, energyJ / 400));
    g.size = 0.12 + Math.min(0.9, Math.sqrt(energyJ) * 0.03);
    g.sprite.position.copy(pos);
    g.sprite.scale.setScalar(g.size);
    g.strength.value = 1;
    g.active = true;
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
      g.strength.value = (1 - t) * (1 - t);
      g.sprite.scale.setScalar(g.size * (1 + t * 0.6));
    }
  }

  dispose(): void {
    for (const g of this.glares) (g.sprite.material as THREE.Material).dispose();
    this.light.dispose();
  }
}
