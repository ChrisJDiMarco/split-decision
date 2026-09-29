// Boot: stage → physics worker → views → frame loop.
import type { MainToWorker, WorkerToMain, WorldMeta } from './core/protocol';
import type { MatchSetup } from './core/types';
import { buildArena } from './render/arena-view';
import { applyPoses, buildRobotViews } from './render/robot-view';
import { createStage } from './render/stage';

const setup: MatchSetup = {
  fighters: [
    { design: 'bruiser', skin: 'factory', plan: 'Walk him down. Jab to set up the overhand. Punish every kick with a body shot.', temperament: 1 },
    { design: 'striker', skin: 'neon', plan: 'Stay long. Low kicks to the lead leg until it fails, then head kick.', temperament: 1.2 },
  ],
  seed: 7,
  timestep: 0.001,
  reactionDelayS: 0.3,
};

const stage = await createStage(document.getElementById('stage') as HTMLCanvasElement);
buildArena(stage.physicsRoot, stage.scene);

const worker = new Worker(new URL('./physics/worker.ts', import.meta.url), { type: 'module' });
const send = (m: MainToWorker) => worker.postMessage(m);

let meta: WorldMeta | null = null;
let bodyGroups: ReturnType<typeof buildRobotViews>['bodyGroups'] | null = null;
let latest: Extract<WorkerToMain, { type: 'frame' }> | null = null;

const hud = document.getElementById('hud')!;
hud.innerHTML = `<div class="hud-help">SPACE release · R reset · S slow-mo</div><div class="hud-perf" id="perf"></div>`;
const perf = document.getElementById('perf')!;

worker.onmessage = (e: MessageEvent<WorkerToMain>) => {
  const msg = e.data;
  if (msg.type === 'ready') {
    if (bodyGroups) for (const g of bodyGroups.values()) g.removeFromParent();
    meta = msg.meta;
    bodyGroups = buildRobotViews(meta, stage.physicsRoot).bodyGroups;
  } else if (msg.type === 'frame') {
    latest = msg;
  } else if (msg.type === 'error') {
    console.error('[physics]', msg.message);
  }
};
send({ type: 'init', setup });

let slow = false;
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') send({ type: 'release' });
  if (e.code === 'KeyR') send({ type: 'reset' });
  if (e.code === 'KeyS') { slow = !slow; send({ type: 'timescale', scale: slow ? 0.15 : 1 }); }
});

let frames = 0;
let fpsT = performance.now();
let fps = 0;
function frame() {
  if (latest && bodyGroups) applyPoses(latest.poses, bodyGroups);
  stage.render();
  frames++;
  const now = performance.now();
  if (now - fpsT > 500) {
    fps = (frames * 1000) / (now - fpsT);
    frames = 0;
    fpsT = now;
    const t = latest;
    perf.textContent = `${stage.isWebGPU ? 'WebGPU' : 'WebGL2'} · ${fps.toFixed(0)} fps · physics ${(t?.stepMs ?? 0).toFixed(3)} ms/step · t=${(t?.time ?? 0).toFixed(1)}s`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
void meta;
