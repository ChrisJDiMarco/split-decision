// Broadcast harness: the fight-night UI, camera director, replay and audio driven by a
// fake fight (kinematic fighters, scripted events, drifting minds). No physics worker.
// URL params: ?round=30 (round length s), ?intro=3 (walkout s), ?break=2 (between rounds s), ?auto=1 (skip select),
//   ?script=ko|head|damage (fire triggers on a fixed timeline after the opening bell).
// Keys (broadcast): C free orbit · P replay · H HUD density · M mute. Harness panel: triggers.
import type { MatchSetup } from '../core/types';
import { buildArena } from '../render/arena-view';
import { createStage } from '../render/stage';
import { createBroadcast } from '../ui/broadcast';
import { FakeFight, type FakeTrigger } from '../ui/dev/fake-fight';
import { FakeRobotView } from '../ui/dev/fake-robot-view';
import { h } from '../ui/dom';

const params = new URLSearchParams(location.search);
const num = (k: string) => (params.has(k) ? Number(params.get(k)) : undefined);
const MAX_DT = 0.1;

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

let fake = new FakeFight(setup);
let view = new FakeRobotView(stage.physicsRoot, fake.meta, setup);

const bc = createBroadcast(stage, {
  initialSetup: setup,
  roundSeconds: num('round'),
  introSeconds: num('intro'),
  breakSeconds: num('break'),
  onStart(s) {
    view.dispose();
    fake = new FakeFight(s);
    view = new FakeRobotView(stage.physicsRoot, fake.meta, s);
    bc.setWorld(fake.meta, s);
  },
  onRelease: () => fake.release(),
  onPause: (p) => { fake.paused = p; },
});
bc.setWorld(fake.meta, setup);

// ---------------------------------------------------------------- trigger panel
const TRIGGERS: Array<[FakeTrigger, string]> = [
  ['bigHit', 'Big hit'], ['headOff', 'Head off'], ['kneeFail', 'Knee fails'], ['fall', 'Knockdown'],
  ['ko', 'KO'], ['smoke', 'Smoke'], ['leak', 'Oil leak'], ['offline', 'Jev offline'],
];
const panel = h('div', { style: 'position:fixed;left:18px;top:108px;width:250px;display:flex;flex-wrap:wrap;gap:5px;z-index:5' });
for (const [kind, label] of TRIGGERS) {
  const b = h('button', { class: 'btn', style: 'padding:7px 10px;font-size:12px' }, label);
  b.addEventListener('click', () => { fake.trigger(kind); b.blur(); });
  panel.append(b);
}
const replayBtn = h('button', { class: 'btn', style: 'padding:7px 10px;font-size:12px' }, 'Replay (P)');
replayBtn.addEventListener('click', () => { bc.replay(); replayBtn.blur(); });
panel.append(replayBtn);
document.body.append(panel);

/** Seconds after the opening bell → trigger. */
const SCRIPTS: Record<string, Array<[number, FakeTrigger]>> = {
  ko: [[1, 'bigHit'], [2, 'ko']],
  head: [[1, 'headOff']],
  damage: [[0.5, 'kneeFail'], [1, 'kneeFail'], [1.2, 'smoke'], [1.4, 'leak'], [1.6, 'offline']],
};
const script = [...(SCRIPTS[params.get('script') ?? ''] ?? [])];
let fightT = 0;

if (params.get('auto') === '1') (document.querySelector('.fight-btn') as HTMLButtonElement | null)?.click();

// ---------------------------------------------------------------- loop
// rAF drives the harness while visible. The shared Browser pane is often hidden (rAF stops
// there), so a tiny worker keeps ticking it at ~60 Hz while the document is hidden.
const HIDDEN_TICK_MS = 16;
let last = performance.now();
function tick(now: number) {
  const dt = Math.min(MAX_DT, (now - last) / 1000);
  last = now;
  if (bc.phase() === 'fight' || bc.phase() === 'ko') {
    fightT += dt;
    while (script.length && fightT >= script[0][0]) fake.trigger(script.shift()![1]);
  }
  const out = fake.step(dt);
  if (out) bc.onFrame(out.frame, out.minds);
  bc.update(dt);
  panel.style.display = bc.phase() === 'select' || bc.replaying() ? 'none' : 'flex';
  const f = bc.displayFrame();
  if (f) view.apply(f.poses);
  stage.render();
}
const raf = (now: number) => {
  if (!document.hidden) tick(now);
  requestAnimationFrame(raf);
};
requestAnimationFrame(raf);
const hiddenTicker = new Worker(URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${HIDDEN_TICK_MS})`], { type: 'text/javascript' })));
hiddenTicker.onmessage = () => {
  if (document.hidden) tick(performance.now());
};

// Other modules' builders edit shared code while this harness runs; accept those updates
// without a full page reload so a long fight/replay check isn't cut short. Reload manually
// to pick up changes.
import.meta.hot?.accept(['../render/arena-view', '../render/stage', '../ui/broadcast', '../ui/dev/fake-fight', '../ui/dev/fake-robot-view', '../ui/dom'], () => {});
