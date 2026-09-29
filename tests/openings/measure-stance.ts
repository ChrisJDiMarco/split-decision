// Headless measurement of how steady the published stance and flashy-move risk bands are in a real
// fight (the sparring stand-in brain drives both robots). Not a test: run it by hand.
// usage: npx tsx tests/openings/measure-stance.ts [red] [blue] [seconds] [seed]
import loadMujoco from '@mujoco/mujoco';
import type { MatchSetup } from '../../src/core/types';
import { riskBand } from '../../src/brain/gambles';
import { sparringIntent } from '../../src/physics/control';
import { moveRisks, snapshot, stanceOf } from '../../src/physics/openings';
import { buildContext } from '../../src/physics/runtime';
import { SYSTEMS } from '../../src/physics/systems';
import { buildTelemetry } from '../../src/physics/systems/telemetry';
import { compileWorld } from '../../src/physics/world';

const [red = 'savate', blue = 'haymaker', secondsArg = '30', seedArg = '7'] = process.argv.slice(2);
const SECONDS = Number(secondsArg);
const INTENT_EVERY_S = 0.5;
const FRAME_S = 1 / 60;
const RISK_MOVE = 'spinning_back_kick';

const setup: MatchSetup = {
  fighters: [
    { design: red, skin: 'factory', plan: '', temperament: 1 },
    { design: blue, skin: 'neon', plan: '', temperament: 1 },
  ],
  seed: Number(seedArg),
  timestep: 0.001,
  reactionDelayS: 0.3,
};

const mj = await loadMujoco();
const ctx = buildContext(mj, compileWorld(setup), setup);
for (const s of SYSTEMS) s.init?.(ctx);
for (const r of ctx.robots) ctx.setEqActive(ctx.eqIndex(r.compiled.gantryWeld), false);
ctx.released = true;

interface Track { rawBand: string | null; rawBandFlips: number; raw: string | null; pub: string | null; band: string | null; rawFlips: number; pubFlips: number; bandFlips: number; frames: number; downFrames: number; offSquare: number; sideOn: number; turned: number; planted: number }
const tracks: Track[] = [0, 1].map(() => ({ rawBand: null, rawBandFlips: 0, raw: null, pub: null, band: null, rawFlips: 0, pubFlips: 0, bandFlips: 0, frames: 0, downFrames: 0, offSquare: 0, sideOn: 0, turned: 0, planted: 0 }));
const steps = Math.round(SECONDS / ctx.dt);
const intentEvery = Math.round(INTENT_EVERY_S / ctx.dt);
const frameEvery = Math.round(FRAME_S / ctx.dt);
let upSeconds = 0;

for (let i = 0; i < steps; i++) {
  if (i % intentEvery === 0) for (const r of ctx.robots) r.intent = sparringIntent(ctx, r);
  for (const s of SYSTEMS) s.pre?.(ctx);
  mj.mj_step(ctx.model, ctx.data);
  ctx.tick++;
  ctx.time += ctx.dt;
  for (const s of SYSTEMS) s.post?.(ctx);
  ctx.events.length = 0;
  if (ctx.robots.some((r) => r.koReason)) break;
  if (i % frameEvery !== 0) continue;
  for (const c of [0, 1] as const) {
    const t = tracks[c];
    const r = ctx.robots[c];
    const tel = buildTelemetry(ctx, r, SYSTEMS);
    t.frames++;
    if (r.down) { t.downFrames++; continue; }
    const me = snapshot(ctx, r);
    const raw = stanceOf(me, snapshot(ctx, ctx.robots[c === 0 ? 1 : 0]));
    if (me.planted) t.planted++;
    if (t.raw !== null && raw !== t.raw) t.rawFlips++;
    if (t.pub !== null && tel.stance !== t.pub) t.pubFlips++;
    const band = riskBand(tel.moveRisk?.[RISK_MOVE] ?? 0);
    if (t.band !== null && band !== t.band) t.bandFlips++;
    const rawBand = riskBand(moveRisks(me)[RISK_MOVE]);
    if (t.rawBand !== null && rawBand !== t.rawBand) t.rawBandFlips++;
    t.rawBand = rawBand;
    t.raw = raw;
    t.pub = tel.stance ?? null;
    t.band = band;
    const off = Math.abs(tel.facingOffDeg ?? 0);
    if (off >= 15) t.offSquare++;
    const oppSees = buildTelemetry(ctx, ctx.robots[c === 0 ? 1 : 0], SYSTEMS).openings ?? [];
    if (oppSees.includes('side_on')) t.sideOn++;
    if (oppSees.includes('turned_away')) t.turned++;
  }
  upSeconds = ctx.time;
}

console.log(`${red} vs ${blue}, seed ${seedArg}: ${upSeconds.toFixed(1)} s simulated`);
for (const c of [0, 1] as const) {
  const t = tracks[c];
  const up = t.frames - t.downFrames;
  const perMin = (n: number) => ((n / Math.max(1e-9, up * FRAME_S)) * 60).toFixed(1);
  const pct = (n: number) => `${((100 * n) / Math.max(1, up)).toFixed(0)}%`;
  console.log(`${ctx.robots[c].design.name}: standing ${(up * FRAME_S).toFixed(1)} s | raw lead-foot flips ${perMin(t.rawFlips)}/min | published stance flips ${perMin(t.pubFlips)}/min | ${RISK_MOVE} band changes live ${perMin(t.rawBandFlips)}/min, published ${perMin(t.bandFlips)}/min | planted ${pct(t.planted)} | off square ${pct(t.offSquare)} | seen side-on ${pct(t.sideOn)} turned away ${pct(t.turned)}`);
}
