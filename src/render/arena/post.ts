// Post-processing on three/webgpu's RenderPipeline: scene pass, GTAO, bloom, subtle
// chromatic aberration, ACES tone mapping, anti-aliasing, then vignette and film grain in
// display space. GTAO cannot read a multisampled depth buffer, so presets with AO render
// the scene pass single-sampled and anti-alias with SMAA/FXAA; the low preset has no AO
// and uses 4x MSAA instead. Presets also trade pixel budget for frame time.
import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  dot, float, fract, mix, pass, perspectiveDepthToViewZ, rand, renderOutput, rtt, smoothstep, time, uniform, uv, vec3, vec4,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import type { Stage } from '../stage';
import type { ShadowQuality } from './lighting';

export type Quality = 'high' | 'medium' | 'low';

type AntiAlias = 'msaa' | 'smaa' | 'fxaa';

interface Preset {
  antiAlias: AntiAlias;
  ao: boolean;
  aoScale: number;
  aberration: boolean;
  maxPixels: number; // drawing-buffer budget; the pixel ratio is lowered to fit
  bloomRadius: number;
}

const PRESETS: Record<Quality, Preset> = {
  high: { antiAlias: 'smaa', ao: true, aoScale: 0.5, aberration: true, maxPixels: 2560 * 1440, bloomRadius: 0.55 },
  medium: { antiAlias: 'fxaa', ao: true, aoScale: 0.5, aberration: true, maxPixels: 1920 * 1080, bloomRadius: 0.5 },
  low: { antiAlias: 'msaa', ao: false, aoScale: 0.5, aberration: false, maxPixels: 1280 * 720, bloomRadius: 0.4 },
};

const MSAA_SAMPLES = 4;
const EXPOSURE = 1.05;
const BLOOM_STRENGTH = 0.5;
const BLOOM_THRESHOLD = 1.6;
const AO_RADIUS_M = 0.5;
const AO_STRENGTH = 0.85;
const AO_NEAR_M = 10; // full AO inside this view distance
const AO_FAR_M = 16; // none beyond (the crowd)
const ABERRATION = 0.0035; // UV shift at the frame corners
const VIGNETTE = 0.42;
const GRAIN = 0.045;
/**
 * Hit pulse on the heaviest impacts: a very short chromatic-aberration and contrast punch in
 * display space. Capped (a stack of hits can't exceed PULSE_MAX), decays in wall time over
 * ~0.1 s, and is compiled out on 'low' along with the aberration.
 */
const PULSE_MAX = 1;
const PULSE_DECAY_PER_S = 22;
const PULSE_ABERRATION_GAIN = 3.5; // aberration multiplier added at a full pulse
const PULSE_CONTRAST = 0.16; // contrast gain at a full pulse
const PULSE_MAX_FRAME_S = 0.1; // a hitch must not skip the decay

export interface PostProcessing {
  render(): void;
  /** Hit pulse 0..1 (adds, capped at 1; decays in ~0.1 s wall time). No effect on 'low'. */
  pulse(amount: number): void;
  /** Current pulse level (debug handle). */
  readonly pulseLevel: number;
  setQuality(q: Quality): void;
  readonly quality: Quality;
  readonly pipeline: THREE.RenderPipeline;
}

export interface QualityListener {
  setShadowQuality(q: ShadowQuality): void;
}

function applyPixelBudget(renderer: THREE.WebGPURenderer, maxPixels: number): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const fit = Math.sqrt(maxPixels / Math.max(1, w * h));
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2, fit));
  renderer.setSize(w, h);
}

export function installPostProcessing(stage: Stage, listener?: QualityListener, initial: Quality = 'high'): PostProcessing {
  const { renderer, scene, camera } = stage;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = EXPOSURE;
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false;

  const aoStrength = uniform(AO_STRENGTH);
  const near = uniform(camera.near);
  const far = uniform(camera.far);
  const aberration = uniform(ABERRATION);
  const vignette = uniform(VIGNETTE);
  const grain = uniform(GRAIN);
  const kick = uniform(0);
  let kickT = performance.now();
  let disposables: Array<{ dispose(): void }> = [];
  let quality: Quality = initial;

  const build = (p: Preset): Node => {
    const scenePass = pass(scene, camera, { samples: p.antiAlias === 'msaa' ? MSAA_SAMPLES : 0 });
    const color = scenePass.getTextureNode('output');
    const depth = scenePass.getTextureNode('depth');
    disposables.push(scenePass);

    const screen = uv();
    const fromCentre = screen.sub(0.5);
    let rgb: Node<'vec3'>;
    if (p.aberration) {
      const shift = fromCentre.mul(aberration.mul(kick.mul(PULSE_ABERRATION_GAIN).add(1)).mul(dot(fromCentre, fromCentre)).mul(2));
      rgb = vec3(color.sample(screen.add(shift)).r, color.sample(screen).g, color.sample(screen.sub(shift)).b);
    } else {
      rgb = color.rgb;
    }
    if (p.ao) {
      const aoPass = ao(depth, null as unknown as Node, camera); // normals reconstructed from depth
      aoPass.resolutionScale = p.aoScale;
      aoPass.radius.value = AO_RADIUS_M;
      aoPass.distanceFallOff.value = 0.6;
      aoPass.thickness.value = 1.2;
      disposables.push(aoPass);
      // AO also multiplies the additive haze drawn over distant geometry, which would
      // stamp the crowd's occlusion pattern into the light beams; keep it to the cage.
      const viewDist = perspectiveDepthToViewZ(depth.sample(screen).r, near, far).negate();
      const reach = smoothstep(AO_FAR_M, AO_NEAR_M, viewDist);
      rgb = rgb.mul(mix(float(1), aoPass.getTextureNode().r, aoStrength.mul(reach)));
    }
    const glow = bloom(color, BLOOM_STRENGTH, p.bloomRadius, BLOOM_THRESHOLD);
    disposables.push(glow);
    rgb = rgb.add(glow.rgb);

    // The TSL typings lose the vec4 type through these nodes, hence the casts.
    let display: Node<'vec4'> = renderOutput(vec4(rgb, 1)) as unknown as Node<'vec4'>;
    if (p.antiAlias !== 'msaa') {
      // smaa()/fxaa() would wrap `display` in a render-to-texture node that their dispose()
      // never frees, leaking a full-resolution target on every quality switch; own it here.
      const source = rtt(display);
      disposables.push({ dispose: () => source.renderTarget?.dispose() });
      const aa = p.antiAlias === 'smaa' ? smaa(source) : fxaa(source);
      disposables.push(aa);
      display = aa as unknown as Node<'vec4'>;
    }
    const vig = float(1).sub(vignette.mul(smoothstep(0.2, 0.75, fromCentre.length())));
    const noise = rand(fract(screen.add(fract(time.mul(0.713))))).sub(0.5);
    let graded: Node<'vec3'> = display.rgb.mul(vig).mul(noise.mul(grain).add(1));
    if (p.aberration) graded = graded.sub(0.5).mul(kick.mul(PULSE_CONTRAST).add(1)).add(0.5).max(0);
    return vec4(graded, 1);
  };

  const apply = (q: Quality) => {
    for (const d of disposables) d.dispose();
    disposables = [];
    const p = PRESETS[q];
    applyPixelBudget(renderer, p.maxPixels);
    pipeline.outputNode = build(p);
    pipeline.needsUpdate = true;
    listener?.setShadowQuality(q);
    quality = q;
  };
  apply(initial);
  window.addEventListener('resize', () => applyPixelBudget(renderer, PRESETS[quality].maxPixels));

  return {
    render() {
      const now = performance.now();
      const dt = Math.min(PULSE_MAX_FRAME_S, (now - kickT) / 1000);
      kickT = now;
      kick.value = kick.value < 1e-3 ? 0 : kick.value * Math.exp(-PULSE_DECAY_PER_S * dt);
      stage.controls.update();
      near.value = camera.near;
      far.value = camera.far;
      pipeline.render();
    },
    setQuality(q) {
      if (q !== quality) apply(q);
    },
    pulse(amount) {
      if (!PRESETS[quality].aberration || !(amount > 0)) return;
      kick.value = Math.min(PULSE_MAX, kick.value + amount);
    },
    get pulseLevel() { return kick.value; },
    get quality() { return quality; },
    pipeline,
  };
}
