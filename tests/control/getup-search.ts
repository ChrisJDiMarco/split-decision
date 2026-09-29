// Offline get-up search (not a test; run with npx tsx): for every design, lying orientation and
// mocap get-up variant (clip × mirror × playback options), knock the robot down that way and time a
// single attempt. The ranking it prints is what src/physics/control/mocap/getup-plan.ts stores.
//   npx tsx tests/control/getup-search.ts [designs] [seeds]
import { controllerOf } from '../../src/physics/control';
import { ClipGetUp } from '../../src/physics/control/mocap/getup';
import { mocapSet } from '../../src/physics/control/mocap/library';
import { makeSim, pelvisPos, torsoUp } from './helpers';

const ORIENTS: Record<string, [number, number, number, number]> = {
  face_down: [Math.cos(Math.PI / 4), 0, Math.sin(Math.PI / 4), 0],
  back: [Math.cos(-Math.PI / 4), 0, Math.sin(-Math.PI / 4), 0],
  side_l: [Math.cos(-Math.PI / 4), Math.sin(-Math.PI / 4), 0, 0],
  side_r: [Math.cos(Math.PI / 4), Math.sin(Math.PI / 4), 0, 0],
};
const OPTS = {
  plain: { projectFeet: false, projectHands: false, footWait: false, handGate: false },
  hands: { projectFeet: false, projectHands: true, footWait: false, handGate: true },
};
const ATTEMPT_S = 14;

interface Trial { ok: boolean; s: number; why: string }

async function trial(design: string, orient: string, id: string, mirror: boolean, opts: keyof typeof OPTS, seed: number): Promise<Trial> {
  ClipGetUp.force = id;
  ClipGetUp.forceMirror = mirror;
  Object.assign(ClipGetUp.opts, OPTS[opts]);
  const sim = await makeSim({ design, x: 0, y: 0, yaw: 0 }, { design: 'striker', x: 8, y: 0, yaw: Math.PI }, { seed });
  const parked = controllerOf(sim.ctx.robots[1]);
  if (parked) parked.enabled = false;
  sim.seconds(0.3);
  sim.release(0);
  const { ctx } = sim;
  const r = ctx.robots[0];
  const c = controllerOf(r)!;
  const a = r.rootQadr;
  const q = ORIENTS[orient];
  ctx.data.qpos[a + 2] = 0.28 + 0.08 * (seed - 1);
  for (let i = 0; i < 4; i++) ctx.data.qpos[a + 3 + i] = q[i];
  ctx.mj.mj_forward(ctx.model, ctx.data);
  let started = -1, up = -1, why = '';
  const n = Math.round(ATTEMPT_S / ctx.dt);
  for (let i = 0; i < n; i++) {
    sim.step();
    const cl = c.getUp.clip;
    if (started < 0 && cl?.stage === 'play') started = ctx.time;
    if (cl?.reason) { why = cl.reason; break; }
    let got = false;
    for (const e of ctx.events) if (e.kind === 'getup' && e.corner === 0) got = true;
    ctx.events.length = 0;
    if (got) { up = ctx.time; break; }
    if (started < 0 && c.getUp.phase !== 'settle' && c.getUp.phase !== 'clip' && c.getUp.active) { why = `not chosen (${c.getUp.phase})`; break; }
  }
  // Still standing 2.5 s after balance took over?
  if (up > 0) {
    sim.seconds(2.5);
    const standing = !r.down && torsoUp(ctx, r) > 0.8 && pelvisPos(ctx, r)[2] > 0.8 * c.stance.pelvisHeight;
    if (!standing) why = 'fell after the rise';
    sim.dispose();
    return { ok: standing, s: up - (started > 0 ? started : 0), why };
  }
  sim.dispose();
  return { ok: false, s: Infinity, why: why || 'timeout' };
}

const designs = (process.argv[2] ?? 'firecracker,savate,haymaker,pylon').split(',');
const seeds = Number(process.argv[3] ?? '2');
const out: Record<string, Record<string, Array<{ id: string; mirror: boolean; opts: string; ok: number; s: number }>>> = {};
for (const design of designs) {
  // The library is read straight from disk here; the controller would do the same.
  const probe = await makeSim({ design, x: 0, y: 0, yaw: 0 }, { design: 'striker', x: 8, y: 0, yaw: Math.PI });
  const set = mocapSet(probe.ctx.robots[0])!;
  probe.dispose();
  out[design] = {};
  for (const orient of Object.keys(ORIENTS)) {
    const labels = orient === 'face_down' ? ['getup_face_down'] : orient === 'back' ? ['getup_back', 'getup_side'] : ['getup_side', 'getup_back'];
    const rows: Array<{ id: string; mirror: boolean; opts: string; ok: number; s: number }> = [];
    for (const label of labels) {
      for (const move of set.byLabel.get(label as never) ?? []) {
        for (const mirror of [false, true]) {
          for (const opts of Object.keys(OPTS) as Array<keyof typeof OPTS>) {
            const res: Trial[] = [];
            for (let seed = 1; seed <= seeds; seed++) res.push(await trial(design, orient, move.id, mirror, opts, seed));
            const ok = res.filter((x) => x.ok).length;
            const t = res.filter((x) => x.ok).reduce((m, x) => m + x.s, 0) / Math.max(1, ok);
            if (res.some((x) => x.why.startsWith('not chosen'))) continue;
            rows.push({ id: move.id, mirror, opts, ok, s: ok ? t : Infinity });
            console.log(`${design} ${orient} ${move.id}${mirror ? ' (mirror)' : ''} ${opts}: ${ok}/${seeds}${ok ? ` in ${t.toFixed(1)} s` : ''}  ${res.map((x) => x.why).filter(Boolean).join(' | ')}`);
          }
        }
      }
    }
    rows.sort((a, b) => b.ok - a.ok || a.s - b.s);
    out[design][orient] = rows.filter((x) => x.ok > 0);
  }
}
console.log('\nPLAN ' + JSON.stringify(out));
