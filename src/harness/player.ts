// Player harness: a REAL fight in third person. Physics worker + arena + robot kit + VFX, one
// Jev Brain for the opponent, and you on the other corner through src/player (WASD footwork,
// mouse and keys for strikes, over-the-shoulder chase camera; V hands the lens to the director).
// URL: /harness/player.html?me=savate&opp=haymaker&corner=0&delay=0.05&fair=1&seed=7
//   me / opp  design ids · corner 0 red / 1 blue (yours) · delay your reaction delay (s)
//   fair=1    you feel Jev's 0.3 s too · cam=director starts on the broadcast camera
// Keys (harness): ENTER rematch after a KO. Everything else is the player keymap (H shows it).
import * as THREE from 'three/webgpu';
import { Brain, JevLink } from '../brain';
import type { MainToWorker, SimEvent, WorkerToMain, WorldMeta } from '../core/protocol';
import type { Corner, FighterSetup, MatchSetup } from '../core/types';
import { PlayerMode, PLAYER_REACTION_DELAY_S, type PlayerCamera } from '../player';
import { buildArenaView, installPostProcessing } from '../render/arena';
import { CameraRig } from '../render/camera/camera-rig';
import { Director } from '../render/camera/director';
import { CameraShake } from '../render/camera/shake';
import { applyImpact, buildRobotKitViews, updateRobotKit, type RobotKitView } from '../render/robot-kit';
import { applyPoses } from '../render/robot-view';
import { createStage } from '../render/stage';
import { createVfx, VFX_REQUIRED_LIMITS } from '../render/vfx';
import { hitStrength } from '../render/vfx/scaling';
import { DESIGNS, design as getDesign } from '../robots/designs';
import { h, setText, toggleClass } from '../ui/dom';
import { buildSubjects, indexWorld, type WorldIndex } from '../ui/scene-bridge';
import { formatClock } from '../ui/round-clock';

type FrameMsg = Extract<WorkerToMain, { type: 'frame' }>;

const params = new URLSearchParams(location.search);
const MAX_DT = 1 / 20;
const RELEASE_AFTER_S = 1.2; // gantry hang before the bell
const JEV_DELAY_S = 0.3;
const FRAME_SAMPLES = 600;

const PLANS: Record<string, string> = {
  savate: 'Orthodox kickboxer. Measure with the jab, live at kicking range, chop the lead leg with low kicks, then go upstairs with the head kick. Front kick him off his base when he walks in.',
  haymaker: 'Pressure brawler. Walk him down behind a high guard and cut off the cage. Dig hooks and uppercuts to the body; when he covers up, load the overhand. Every punch is thrown to end it.',
};
const plan = (id: string) => PLANS[id] ?? 'Jab to find range, stay off the cage and make him miss. When he commits, punish with the heaviest shot you have.';

function pickDesign(key: string, fallback: string): string {
  const id = params.get(key);
  return id && DESIGNS[id] ? id : fallback;
}

const corner: Corner = params.get('corner') === '1' ? 1 : 0;
const oppCorner: Corner = corner === 0 ? 1 : 0;
const fair = params.get('fair') === '1';
const delayParam = Number(params.get('delay'));
const playerDelay = fair ? JEV_DELAY_S : Number.isFinite(delayParam) && params.has('delay') ? Math.max(0, Math.min(1, delayParam)) : PLAYER_REACTION_DELAY_S;
const meId = pickDesign('me', 'savate');
const oppId = pickDesign('opp', 'haymaker');

function makeSetup(seed: number): MatchSetup {
  const mine: FighterSetup = { design: meId, skin: 'livery', plan: '', temperament: 1, controller: 'player', ...(fair ? {} : { reactionDelayS: playerDelay }) };
  const theirs: FighterSetup = { design: oppId, skin: 'livery', plan: plan(oppId), temperament: 1.2, controller: 'jev' };
  const fighters: [FighterSetup, FighterSetup] = corner === 0 ? [mine, theirs] : [theirs, mine];
  return { fighters, seed, timestep: 0.001, reactionDelayS: JEV_DELAY_S };
}

// ---------------------------------------------------------------- scene

const hudRoot = document.getElementById('hud')!;
hudRoot.classList.add('broadcast');
const stage = await createStage(document.getElementById('stage') as HTMLCanvasElement, { requiredLimits: VFX_REQUIRED_LIMITS, antialias: false });
const arena = buildArenaView(stage);
const post = installPostProcessing(stage, arena, 'high');
const vfx = createVfx(stage);
arena.excludeFromContactShadows(vfx.root);

// Broadcast camera for V: the director + rig (read-only reuse of src/render/camera).
const director = new Director();
const rig = new CameraRig(stage);
const shake = new CameraShake();
director.setMode('idle');

const worker = new Worker(new URL('../physics/worker.ts', import.meta.url), { type: 'module' });
const send = (m: MainToWorker) => worker.postMessage(m);

let setup = makeSetup(Number(params.get('seed') ?? 7) || 7);
const designs = [getDesign(setup.fighters[0].design), getDesign(setup.fighters[1].design)] as const;

const player = new PlayerMode({
  stage,
  corner,
  designs,
  hudRoot,
  camera: params.get('cam') === 'director' ? 'director' : 'chase',
  send: (intent, issuedAtTick) => send({ type: 'intent', corner, intent, issuedAtTick }),
  onCamera: (mode: PlayerCamera) => {
    if (mode === 'director') director.setMode('live');
  },
});

// ---------------------------------------------------------------- harness overlay

const banner = h('div', 'ph-banner', '');
const perf = h('div', 'hud-perf', '');
hudRoot.append(banner, perf);
const bannerStyle = document.createElement('style');
bannerStyle.textContent = `.ph-banner { position:absolute; left:50%; top:30%; transform:translate(-50%,-50%) skewX(var(--skew)); font:800 64px/1 var(--cond); letter-spacing:.1em; color:var(--ink); text-shadow:0 0 30px rgba(0,0,0,.8); transition:opacity .3s ease; pointer-events:none; text-align:center; }
.ph-banner small { display:block; font:600 14px/1.6 var(--mono); letter-spacing:.14em; color:var(--gold); }
.ph-banner.hidden { opacity:0; }`;
document.head.append(bannerStyle);

function showBanner(title: string, sub = ''): void {
  banner.replaceChildren(title, ...(sub ? [h('small', {}, sub)] : []));
  toggleClass(banner, 'hidden', false);
}
const hideBanner = () => toggleClass(banner, 'hidden', true);

// ---------------------------------------------------------------- match state

const link = new JevLink();
let meta: WorldMeta | null = null;
let world: WorldIndex | null = null;
let views: RobotKitView[] = [];
let bodyGroups = new Map<number, THREE.Group>();
let brain: Brain | null = null;
let latest: FrameMsg | null = null;
let pendingImpacts: SimEvent[] = [];
let releaseAt: number | null = null;
let fightStart: number | null = null;
let over = false;
let endTime: number | null = null; // sim time of the KO (the clock stops)

function start(): void {
  over = false;
  endTime = null;
  latest = null;
  releaseAt = null;
  fightStart = null;
  vfx.clear();
  player.setEnabled(false);
  showBanner('WALKOUT', `YOU: ${designs[corner].name} · JEV: ${designs[oppCorner].name}${fair ? ' · FAIR MODE' : ''}`);
  send({ type: 'init', setup });
}

function onReady(m: WorldMeta): void {
  for (const v of views) v.dispose();
  meta = m;
  world = indexWorld(m);
  ({ views, bodyGroups } = buildRobotKitViews(m, stage.physicsRoot, [setup.fighters[0].skin, setup.fighters[1].skin]));
  vfx.setWorld(m);
  pendingImpacts = [];
  brain?.stop();
  brain = new Brain({
    corner: oppCorner,
    meta: m,
    fighter: setup.fighters[oppCorner],
    seed: setup.seed,
    link,
    onIntent: (c, intent, issuedAtTick) => send({ type: 'intent', corner: c, intent, issuedAtTick }),
  });
  player.setWorld(m);
  releaseAt = performance.now() + RELEASE_AFTER_S * 1000;
}

function release(): void {
  send({ type: 'release' });
  brain?.start();
  player.setEnabled(true);
  fightStart = latest?.time ?? 0;
  director.setMode('live');
  showBanner('FIGHT!');
  setTimeout(hideBanner, 1100);
}

function onFrame(msg: FrameMsg): void {
  latest = msg;
  brain?.onFrame(msg);
  player.onFrame(msg, brain?.latest ?? null);
  director.onEvents(msg.events);
  for (const e of msg.events) {
    if (e.kind === 'impact') {
      const strike = e.striker !== null && e.victim !== null && e.striker !== e.victim;
      const s = strike ? hitStrength(e.energyJ, e.impulseNs, e.speed) : 0;
      shake.add(Math.max(CameraShake.forEnergy(e.energyJ), CameraShake.forStrength(s)));
      if (e.victim !== null && e.part) pendingImpacts.push(e);
    } else if (e.kind === 'cage') arena.bowFence(e.pos, e.speed / 3);
    else if (e.kind === 'ko' && !over) onKO(e.corner);
  }
  vfx.onEvents(msg.events);
  vfx.onTelemetry(msg.telemetry, msg.poses);
}

function onKO(loser: Corner): void {
  over = true;
  endTime = latest?.time ?? null;
  brain?.stop();
  player.setEnabled(false);
  showBanner(loser === corner ? 'YOU GOT KO\'D' : 'KNOCKOUT!', `${loser === corner ? 'JEV WINS' : 'YOU WIN'} · ENTER FOR A REMATCH`);
}

worker.onmessage = (e: MessageEvent<WorkerToMain>) => {
  const msg = e.data;
  if (msg.type === 'ready') onReady(msg.meta);
  else if (msg.type === 'frame') onFrame(msg);
  else if (msg.type === 'error') console.error('[physics]', msg.message);
};

window.addEventListener('keydown', (e) => {
  if (e.code === 'Enter' && over) {
    setup = { ...setup, seed: setup.seed + 1 };
    start();
  }
});

// ---------------------------------------------------------------- loop

const tmpPos = new THREE.Vector3();
const tmpNormal = new THREE.Vector3();
const frameMs: number[] = []; // rAF interval (or the hidden ticker's)
const cpuMs: number[] = []; // main-thread work per frame (poses, kit, cameras, HUD, VFX, render submit)

function applyPendingImpacts(): void {
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

function pct(xs: readonly number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

let last = performance.now();
let perfT = 0;
function tick(now: number): void {
  const cpu0 = performance.now();
  frame(now);
  cpuMs.push(performance.now() - cpu0);
  if (cpuMs.length > FRAME_SAMPLES) cpuMs.shift();
}

function frame(now: number): void {
  const rawMs = now - last;
  const dt = Math.min(MAX_DT, rawMs / 1000);
  last = now;
  frameMs.push(rawMs);
  if (frameMs.length > FRAME_SAMPLES) frameMs.shift();
  if (releaseAt !== null && now >= releaseAt && latest) {
    releaseAt = null;
    release();
  }
  if (latest && meta) {
    applyPoses(latest.poses, bodyGroups);
    applyPendingImpacts();
    updateRobotKit(views, latest.telemetry, dt);
  }
  // The director always runs (so V cuts to a live shot); the chase camera overwrites it while active.
  director.aspect = stage.camera.aspect;
  const out = director.update(dt, buildSubjects(world, latest?.telemetry ?? null, latest?.poses ?? null));
  const shakeOffset = shake.update(dt);
  if (player.camera === 'director') rig.apply(out, dt, shakeOffset);
  player.update(dt);
  const clock = fightStart !== null && latest ? formatClock((endTime ?? latest.time) - fightStart) : '0:00';
  player.hud.setClock(clock, over ? 'KO' : fightStart === null ? 'WALKOUT' : fair ? 'FAIR MODE' : `YOU ${Math.round(playerDelay * 1000)} MS · JEV ${JEV_DELAY_S * 1000} MS`);
  vfx.update(dt);
  arena.update(dt);
  post.render();
  perfT += dt;
  if (perfT > 0.5) {
    perfT = 0;
    const s = player.stats;
    setText(perf, `frame p50 ${pct(frameMs, 0.5).toFixed(1)} ms · p95 ${pct(frameMs, 0.95).toFixed(1)} ms · cpu p50 ${pct(cpuMs, 0.5).toFixed(1)} ms · phys ${(latest?.stepMs ?? 0).toFixed(3)} ms/step · strike ${s.strikeStartMs.length ? pct(s.strikeStartMs, 0.5).toFixed(0) : '—'} ms · move ${s.moveStartMs.length ? pct(s.moveStartMs, 0.5).toFixed(0) : '—'} ms · jev ${link.offline ? 'OFFLINE (house mind)' : 'on'}`);
  }
}

const raf = (now: number) => {
  if (!document.hidden) tick(now);
  requestAnimationFrame(raf);
};
requestAnimationFrame(raf);
// rAF stops in a hidden tab; a tiny worker keeps the fight ticking so automated checks can run.
const hiddenTicker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 16)'], { type: 'text/javascript' })));
hiddenTicker.onmessage = () => {
  if (document.hidden) tick(performance.now());
};

start();

// Debug handle for the console and automated checks.
Object.assign(window, {
  jkdPlayer: {
    player, stage, director, link, send,
    get brain() { return brain; },
    get latest() { return latest; },
    frameStats: () => ({ p50: pct(frameMs, 0.5), p95: pct(frameMs, 0.95), cpuP50: pct(cpuMs, 0.5), cpuP95: pct(cpuMs, 0.95), n: frameMs.length, hidden: document.hidden }),
  },
});

// Other agents edit shared modules while this harness runs; accept those updates without a full
// reload so a long play-test isn't cut short (reload by hand to pick them up).
import.meta.hot?.accept([
  '../brain', '../player', '../render/arena', '../render/camera/camera-rig', '../render/camera/director', '../render/camera/shake',
  '../render/robot-kit', '../render/robot-view', '../render/stage', '../render/vfx', '../render/vfx/scaling', '../robots/designs',
  '../ui/dom', '../ui/scene-bridge', '../ui/round-clock',
], () => {});
