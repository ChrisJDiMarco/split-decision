// Brain harness: two Brains fight a top-down puppet sim. Default is a mock Jev (random
// but state-aware distributions with realistic latency); tick "Live Jev" to use /api/jev.
import { APOTHEM, postPositions } from '../core/arena-spec';
import type { WorldMeta } from '../core/protocol';
import type { Corner, FighterSetup } from '../core/types';
import { Brain } from '../brain/brain';
import type { JevQuestion, JevResult } from '../brain/jev-client';
import { JevLink } from '../brain/link';
import type { FightState } from '../brain/serializer';
import { DESIGNS } from '../robots/designs';
import { PuppetFight } from './brain-puppet';

const FIGHTERS: [FighterSetup, FighterSetup] = [
  { design: 'bruiser', skin: 'factory', temperament: 1, plan: 'Walk him down. Jab to set up the overhand. Punish every kick with a body shot.' },
  { design: 'striker', skin: 'neon', temperament: 1.2, plan: 'Stay long. Low kicks to the lead leg until it fails, then head kick.' },
];
const SEED = 7;
const COLORS = ['#e0452b', '#2f7bff'];
const STRIKE_WORDS = /jab|cross|hook|uppercut|overhand|kick|smash|bash|punch|crush|lunge|ram/;

function mockAnswer(state: FightState, questions: Record<string, JevQuestion>): JevResult {
  const close = /clinch|striking/.test(state.geometry.distance);
  const winding = /winding/.test(state.opponent.phase);
  const answers: JevResult['answers'] = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === 'choice') {
      const keys = Object.keys(q.criteria);
      const w = keys.map((k) => {
        let base = 0.3;
        if (id === 'tactic') {
          if (close && STRIKE_WORDS.test(k)) base = 1.4;
          if (winding && (k === 'sidestep_counter' || k === 'guard')) base = 2;
          if (!close && k === 'close_distance') base = 1.6;
          if (!close && k === 'hold_range') base = 0.8;
        }
        return base * (0.4 + Math.random());
      });
      const sum = w.reduce((a, b) => a + b, 0);
      const probabilities = Object.fromEntries(keys.map((k, i) => [k, w[i] / sum]));
      const top = keys[w.indexOf(Math.max(...w))];
      answers[id] = { type: 'choice', choice: top, confidence: Math.min(0.95, (Math.max(...w) / sum) * 2.2), probabilities };
    } else if (q.type === 'noul') {
      answers[id] = { type: 'noul', noul: winding ? 0.8 : 0.15 + Math.random() * 0.3 };
    } else {
      const score = Math.min(q.criteria.length - 1, Math.max(0, 2 + (Math.random() - 0.5) * 2.5));
      answers[id] = { type: 'score', score, confidence: 0.5, probabilities: {} };
    }
  }
  return { answers, latencyMs: 0, inputTokens: 0, outputTokens: 0 };
}

function mockAsk(state: unknown, questions: Record<string, JevQuestion>): Promise<JevResult> {
  const latency = 90 + Math.random() * 170;
  return new Promise((resolve) => setTimeout(() => resolve({ ...mockAnswer(state as FightState, questions), latencyMs: latency, inputTokens: 1100 }), latency));
}

const meta: WorldMeta = {
  nbody: 0, timestep: 0.001, props: [],
  robots: FIGHTERS.map((f, i) => ({ corner: i as Corner, design: f.design, prefix: `f${i}_`, parts: [] })),
};

let fight = new PuppetFight(DESIGNS[FIGHTERS[0].design], DESIGNS[FIGHTERS[1].design]);
let brains: Brain[] = [];
let link: JevLink;

function boot(live: boolean) {
  fight = new PuppetFight(DESIGNS[FIGHTERS[0].design], DESIGNS[FIGHTERS[1].design]);
  brains.forEach((b) => b.stop());
  link = live ? new JevLink() : new JevLink({ ask: mockAsk });
  brains = FIGHTERS.map((f, i) => new Brain({
    corner: i as Corner, meta, fighter: f, seed: SEED, link,
    onIntent: (c, intent, tick) => fight.pushIntent(c, intent, tick),
  }));
  brains.forEach((b) => b.start());
  document.getElementById('mode')!.textContent = live ? 'LIVE JEV' : 'MOCK JEV';
}

// ------------------------------------------------------------------ drawing

const canvas = document.getElementById('arena') as HTMLCanvasElement;
const g = canvas.getContext('2d')!;

function drawArena() {
  const dpr = window.devicePixelRatio || 1;
  const size = canvas.clientWidth;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  const s = (size * dpr) / (APOTHEM * 2.4);
  g.setTransform(s, 0, 0, -s, (size * dpr) / 2, (size * dpr) / 2);
  g.clearRect(-10, -10, 20, 20);
  g.fillStyle = '#16171a';
  g.strokeStyle = '#3a3c42';
  g.lineWidth = 0.05;
  g.beginPath();
  postPositions().forEach(([x, y], i) => (i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)));
  g.closePath();
  g.fill();
  g.stroke();
  for (const p of fight.pucks) {
    g.fillStyle = COLORS[p.corner];
    g.globalAlpha = p.downT > 0 ? 0.35 : 1;
    g.beginPath(); g.arc(p.x, p.y, 0.28, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 0.25;
    g.strokeStyle = COLORS[p.corner];
    g.lineWidth = 0.02;
    g.beginPath(); g.arc(p.x, p.y, p.reach, 0, Math.PI * 2); g.stroke();
    g.globalAlpha = 1;
    g.strokeStyle = '#f2efe8';
    g.lineWidth = 0.05 + (p.strikeT >= 0 ? 0.06 : 0);
    g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(p.x + Math.cos(p.heading) * 0.5, p.y + Math.sin(p.heading) * 0.5); g.stroke();
  }
}

function pct(x: number | null | undefined) { return x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`; }

function renderPanel(i: number) {
  const b = brains[i];
  const d = b.latest;
  const st = b.statsSnapshot;
  const el = document.getElementById(`mind${i}`)!;
  const probs = Object.entries(d?.tacticProbs ?? {}).sort((a, c) => c[1] - a[1]).slice(0, 7);
  const bars = probs.map(([k, p]) => `<div class="bar${k === d?.tactic ? ' on' : ''}"><span>${k.replace(/_/g, ' ')}</span><i style="width:${Math.round(p * 100)}%"></i><b>${pct(p)}</b></div>`).join('');
  el.innerHTML = `
    <div class="name" style="color:${COLORS[i]}">${DESIGNS[FIGHTERS[i].design].name}</div>
    <div class="badge ${d?.source ?? ''}">${d ? d.source.toUpperCase() : 'WAITING'}${d?.source === 'fallback' ? ' · HOUSE MIND' : ''}</div>
    <div class="tactic">${d ? d.tactic.replace(/_/g, ' ') : '—'}</div>
    <div class="row">target <b>${d?.target.replace(/_/g, ' ') ?? '—'}</b> · mode <b>${d?.mode ?? '—'}</b> · conf <b>${pct(d?.confidence)}</b></div>
    <div class="bars">${bars}</div>
    <div class="row">read (opp commits) <b>${pct(d?.oppCommit)}</b> · aggression <b>${pct(d?.aggression)}</b> · winning <b>${pct(d?.winning)}</b></div>
    <div class="row">counter if lunge <b>${d?.counterIfLunge?.replace(/_/g, ' ') ?? '—'}</b></div>
    <div class="row dim">${d ? `${d.trigger} · ${d.reason}` : ''}</div>
    <div class="row dim">req ${st.requests} · ok ${st.answered} · stale ${st.droppedStale} · local ${st.settledLocal} · fb ${st.fallbackDecisions}</div>
    <div class="row dim">latency p50 ${st.latency.p50.toFixed(0)} · p90 ${st.latency.p90.toFixed(0)} ms · ${st.inputTokens} tok</div>`;
}

function renderStatus() {
  const retry = link.offline ? ` · retry in ${(link.retryInMs() / 1000).toFixed(0)} s` : '';
  document.getElementById('status')!.textContent =
    `jev ${link.status}${retry} · ${link.recentRate}/s · t=${fight.time.toFixed(1)} s${link.lastError ? ` · ${link.lastError}` : ''}`;
}

let last = performance.now();
let acc = 0;
function loop(now: number) {
  acc += Math.min(0.1, (now - last) / 1000);
  last = now;
  while (acc >= 1 / 60) {
    const frame = fight.step();
    brains.forEach((b) => b.onFrame(frame));
    acc -= 1 / 60;
  }
  drawArena();
  renderPanel(0);
  renderPanel(1);
  renderStatus();
  requestAnimationFrame(loop);
}

const liveBox = document.getElementById('live') as HTMLInputElement;
liveBox.addEventListener('change', () => boot(liveBox.checked));
document.getElementById('restart')!.addEventListener('click', () => boot(liveBox.checked));
boot(false);
requestAnimationFrame(loop);
