// Physical dents (docs/design/strike-power.md §4.2): what a hit's work does to the shell it lands on.
// A shell yields only when the local (filtered) contact force passes its collapse load P_c AND its
// share of the absorbed work passes its elastic limit E_el (shell.ts); the plastic work then sets a
// permanent depth from P_c·(δ + δ³/3h²) = W − E_el, and the material decides the look: metal dents
// and keeps it, polycarbonate dents, whitens and partly springs back (and cracks when the dent runs
// deep), UHMW gouges and never cracks, carbon does not dent but cracks and delaminates, weakening the
// panel for the next hit. Dents are recorded in the struck part's own frame for the renderer.
// Deterministic: replays and late joiners see the same marks.
import type { DentMode } from '../../core/protocol';
import type { SimContext } from '../sim-context';
import { DAMAGE_TUNING } from './constants';
import { clamp, dentDepth, type Surface } from './shell';
import type { RobotDamage, Tally } from './state';

export type { DentMode };

/** Physical dents kept per robot for telemetry (the renderer applies each seq once). */
export const DENT_RING = 8;

/** What a hit did to one shell: nothing (elastic), or a permanent dent / crack. */
export interface ShellResponse {
  mode: DentMode;
  plasticJ: number;
  /** Permanent (after springback) depth and the plastic zone radius, m. */
  depthM: number;
  radiusM: number;
  cracked: boolean;
  /** 0..1 whitening / fibre fuzz around the dent (render). */
  whiten: number;
  /** Part damage points. */
  points: number;
  severity: number; // plastic work over the zone's elastic limit
}

/**
 * A hit's effect on one surface. `workJ` is this side's share of the absorbed work, `peakN` the peak
 * local contact force, `weakening` the zone's remaining strength after cracks (1 = intact), `spread`
 * the load-spread factor (1 for a strike, DAMAGE_TUNING.worldSpread for a robot-world contact).
 * Returns null while the shell stays elastic: below its collapse load or its elastic work limit.
 */
export function shellResponse(s: Surface, workJ: number, peakN: number, weakening = 1, spread = 1): ShellResponse | null {
  if (s.mode === 'cushion' || !Number.isFinite(s.collapseN)) return null;
  const t = DAMAGE_TUNING;
  const pc = s.collapseN * weakening * spread;
  const eel = s.elasticJ * weakening * weakening * spread * spread;
  if (!(peakN >= pc) || !(workJ > eel)) return null;
  const plasticJ = workJ - eel;
  const severity = plasticJ / Math.max(1e-6, eel);
  const h = s.thicknessM;
  const a = s.radiusM;
  if (s.mode === 'crack') {
    // Carbon does not dent: it cracks and delaminates, and a cracked panel loses stiffness and hp sharply.
    const radiusM = clamp(a * Math.sqrt(Math.min(1, plasticJ / (4 * eel))), 0.015, a);
    return { mode: 'crack', plasticJ, depthM: Math.min(h * 1.5, 0.004), radiusM, cracked: true, whiten: clamp(0.4 + 0.15 * severity, 0, 1), points: plasticJ * t.pointsPerPlasticJ * t.crackPointsFactor, severity };
  }
  const raw = Math.min(dentDepth(plasticJ, pc, h), a);
  const depthM = raw * (1 - (t.springback[s.mode] ?? 0));
  const radiusM = clamp(a * Math.sqrt(raw / (0.25 * a)), 0.012, a);
  const cracked = s.mode === 'whiten' && raw >= t.whitenCrackDepthH * h;
  const whiten = s.mode === 'whiten' ? clamp(0.35 + raw / (6 * h), 0, 1) : s.mode === 'gouge' ? clamp(0.25 + raw / (8 * h), 0, 0.8) : 0;
  const points = plasticJ * t.pointsPerPlasticJ * (cracked ? t.crackPointsFactor : 1);
  return { mode: s.mode, plasticJ, depthM, radiusM, cracked, whiten, points, severity };
}

/** Books a permanent mark: telemetry ring, ledger, and a crack's weakening of its zone. */
export function recordDent(ctx: SimContext, rd: RobotDamage, t: Tally, res: ShellResponse): void {
  const tune = DAMAGE_TUNING;
  const L = rd.ledger.dents;
  L.count++;
  L.byZone[t.zone] = (L.byZone[t.zone] ?? 0) + 1;
  L.maxDepthM = Math.max(L.maxDepthM, res.depthM);
  L.plasticJ += res.plasticJ;
  if (res.cracked) {
    L.cracks++;
    t.info.weakening[t.zone] = Math.max(tune.crackWeakeningFloor, (t.info.weakening[t.zone] ?? 1) * tune.crackWeakening);
  }
  rd.dents.push({
    seq: ++rd.dentSeq,
    part: t.info.def.id,
    pos: t.localPos,
    normal: unit(t.localNormal),
    depthM: res.depthM,
    radiusM: res.radiusM,
    mode: res.mode,
    cracked: res.cracked,
    whiten: res.whiten,
    time: ctx.time,
  });
  if (rd.dents.length > DENT_RING) rd.dents.shift();
}

function unit(v: [number, number, number]): [number, number, number] {
  const m = Math.hypot(v[0], v[1], v[2]);
  return m > 1e-12 ? [v[0] / m, v[1] / m, v[2] / m] : [0, 0, 1];
}
