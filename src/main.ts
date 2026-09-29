// Fight night: stage → arena + post → robot kit → VFX → broadcast → Jev brains → physics worker.
// The broadcast owns the flow (select → intro → release → rounds → KO/decision); this file
// wires the modules together and runs the render loop.
import * as THREE from 'three/webgpu';
import { Brain, JevLink } from './brain';
import type { MainToWorker, SimEvent, WorkerToMain, WorldMeta } from './core/protocol';
import type { Corner, MatchSetup } from './core/types';
import { buildArenaView, installPostProcessing, type Quality } from './render/arena';
import { applyImpact, buildRobotKitViews, updateRobotKit, type RobotKitView } from './render/robot-kit';
import { applyPoses } from './render/robot-view';
import { createStage } from './render/stage';
import { createVfx, VFX_REQUIRED_LIMITS } from './render/vfx';
import { createBroadcast } from './ui/broadcast';
import type { FightPhase } from './ui/broadcast';
import type { Minds } from './ui/minds';

type FrameMsg = Extract<WorkerToMain, { type: 'frame' }>;

const SLOW_MO = 0.15;
const MAX_DT = 1 / 20;
const QUALITIES: Quality[] = ['high', 'medium', 'low'];

const DEFAULT_SETUP: MatchSetup = {
  fighters: [
    { design: 'savate', skin: 'livery', plan: 'Orthodox kickboxer. Measure him with the jab and live at kicking range. Chop his lead leg with low kicks until his stance or his gyro gives, then go upstairs with the head kick. When he walks in behind the guard, front kick him off his base and sprint off the angle. Never stand in the clinch with him. Finish every combination with a kick: jab, cross, hook, low kick.', temperament: 1.1 },
    { design: 'haymaker', skin: 'livery', plan: 'Pressure brawler. Walk him down behind a high guard, chin tucked, and cut off the cage; do not chase, cut the angle. Get inside his kicks and smother him in the clinch. Dig hooks and uppercuts to the body, and when he covers up, load the overhand. If he circles out, chop his leg with a low kick. Every punch is thrown to end it.', temperament: 1.3 },
  ],
  seed: 7,
  timestep: 0.001,
  reactionDelayS: 0.3,
};

// ---------------------------------------------------------------- scene

const stage = await createStage(document.getElementById('stage') as HTMLCanvasElement, {
  requiredLimits: VFX_REQUIRED_LIMITS,
  antialias: false,
});
const arena = buildArenaView(stage);
const post = installPostProcessing(stage, arena, 'high');
const vfx = createVfx(stage);
arena.excludeFromContactShadows(vfx.root);

const worker = new Worker(new URL('./physics/worker.ts', import.meta.url), { type: 'module' });
const send = (m: MainToWorker) => worker.postMessage(m);

// ---------------------------------------------------------------- match state

const link = new JevLink();
let setup: MatchSetup = DEFAULT_SETUP;
let meta: WorldMeta | null = null;
let views: RobotKitView[] = [];
let bodyGroups = new Map<number, THREE.Group>();
let brains: Brain[] = [];
let pendingImpacts: SimEvent[] = [];
let workerPaused = false;
let timescale = 1;
let qualityIndex = 0;

function minds(): Minds {
  return [brains[0]?.latest ?? null, brains[1]?.latest ?? null];
}

function setWorkerPaused(p: boolean) {
  workerPaused = p;
  send({ type: 'pause', paused: p });
}

function buildBrains(m: WorldMeta) {
  for (const b of brains) b.stop();
  brains = ([0, 1] as Corner[]).map((corner) => new Brain({
    corner,
    meta: m,
    fighter: setup.fighters[corner],
    seed: setup.seed,
    link,
    onIntent: (c, intent, issuedAtTick) => send({ type: 'intent', corner: c, intent, issuedAtTick }),
  }));
}

function onPhase(phase: FightPhase) {
  switch (phase) {
    case 'break':
      // Between rounds the fighters stand where they are: physics and minds hold.
      for (const b of brains) b.stop();
      setWorkerPaused(true);
      break;
    case 'fight':
      if (workerPaused) setWorkerPaused(false);
      for (const b of brains) b.start();
      break;
    case 'ko':
    case 'decision':
    case 'over':
      for (const b of brains) b.stop();
      break;
    default:
      break;
  }
}

const broadcast = createBroadcast(stage, {
  initialSetup: DEFAULT_SETUP,
  onStart(s) {
    setup = s;
    timescale = 1;
    vfx.clear();
    send({ type: 'init', setup: s });
  },
  onRelease() {
    send({ type: 'release' });
    for (const b of brains) b.start();
  },
  onPause(p) {
    setWorkerPaused(p);
  },
  onPhase,
  onReplayEvents(events) {
    vfx.onEvents(events);
    queueImpacts(events);
  },
});

// ---------------------------------------------------------------- worker traffic

function queueImpacts(events: readonly SimEvent[]) {
  for (const e of events) {
    if (e.kind === 'impact' && e.victim !== null && e.part) pendingImpacts.push(e);
    else if (e.kind === 'cage') arena.bowFence(e.pos, e.speed / 3);
  }
}

function onReady(m: WorldMeta) {
  for (const v of views) v.dispose();
  meta = m;
  ({ views, bodyGroups } = buildRobotKitViews(m, stage.physicsRoot, [setup.fighters[0].skin, setup.fighters[1].skin]));
  vfx.setWorld(m);
  pendingImpacts = [];
  buildBrains(m);
  broadcast.setWorld(m, setup);
}

function onFrame(msg: FrameMsg) {
  broadcast.onFrame(msg, minds());
  const clock = broadcast.clock();
  for (const b of brains) b.onFrame(msg, clock);
  if (broadcast.replaying()) return;
  vfx.onEvents(msg.events);
  vfx.onTelemetry(msg.telemetry, msg.poses);
  queueImpacts(msg.events);
}

worker.onmessage = (e: MessageEvent<WorkerToMain>) => {
  const msg = e.data;
  if (msg.type === 'ready') onReady(msg.meta);
  else if (msg.type === 'frame') onFrame(msg);
  else if (msg.type === 'error') console.error('[physics]', msg.message);
};

// ---------------------------------------------------------------- input

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (e.code === 'KeyS' && broadcast.phase() === 'fight') {
    timescale = timescale === 1 ? SLOW_MO : 1;
    send({ type: 'timescale', scale: timescale });
  } else if (e.code === 'KeyQ') {
    qualityIndex = (qualityIndex + 1) % QUALITIES.length;
    post.setQuality(QUALITIES[qualityIndex]);
  } else if (e.code === 'KeyR') {
    for (const b of brains) b.stop();
    broadcast.showSelect();
  }
});

// ---------------------------------------------------------------- render loop

const tmpPos = new THREE.Vector3();
const tmpNormal = new THREE.Vector3();

function applyPendingImpacts() {
  if (!pendingImpacts.length) return;
  stage.physicsRoot.updateMatrixWorld();
  for (const e of pendingImpacts) {
    if (e.kind !== 'impact' || e.victim === null || !e.part) continue;
    const view = views.find((v) => v.corner === e.victim);
    if (!view) continue;
    stage.physicsRoot.localToWorld(tmpPos.set(...e.pos));
    tmpNormal.set(...e.normal).transformDirection(stage.physicsRoot.matrixWorld);
    applyImpact(view, e.part, tmpPos, tmpNormal, e.energyJ);
  }
  pendingImpacts = [];
}

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(MAX_DT, (now - last) / 1000);
  last = now;
  broadcast.update(dt);
  const shown = broadcast.displayFrame();
  if (shown && meta) {
    applyPoses(shown.poses, bodyGroups);
    applyPendingImpacts();
    updateRobotKit(views, shown.telemetry, dt);
  }
  const replaying = broadcast.replaying();
  vfx.setReplay(replaying);
  const simDt = workerPaused && !replaying ? 0 : dt * (replaying ? 0.25 : timescale);
  vfx.update(simDt);
  arena.update(dt);
  post.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Debug handle for the console and automated checks.
Object.assign(window, { splitDecision: { stage, broadcast, vfx, arena, link, get brains() { return brains; }, send } });
