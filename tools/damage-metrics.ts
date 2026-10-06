// Damage metrics for tools/fight-metrics.ts and tools/strike-bench.ts (docs/design/strike-power.md
// §5.1): what the strikes delivered and what the damage model did with them, per fighter.
//   strikes    as the striker: landed strike episodes, clean share (a striking surface at clean-hit
//              speed), push episodes; contact speed by striking surface; impulse, absorbed work and
//              presentation energy per strike
//   joints     health lost by channel (gear, bearing, hyperextension, housing, detach) and by role
//              (hurt as the victim, or by its own strike), failures by kind (seize, strip, slip,
//              bend, hyperextension, fault, seal), joints injured (degraded or worse), channel peaks
//   shells     dents and cracks, by zone; deepest; plastic work
//   get-ups    seconds from each fall to its get-up
// The numbers come from the damage model's own ledger (src/physics/damage/state.ts DamageLedger) and
// from the events, so before/after runs with the same seeds compare like with like.
import type { JointCause, JointFailure, JointRole, SimEvent } from '../src/core/protocol';
import { damageState, type DamageLedger } from '../src/physics/damage';
import type { SimContext } from '../src/physics/sim-context';

export type Surface = 'fist' | 'foot' | 'shin' | 'other';

export interface Dist { n: number; p50: number; p90: number; max: number }

export interface FighterDamage {
  strikes: {
    landed: number; // strike episodes on the other robot (pushes excluded)
    clean: number;
    pushes: number;
    speedBySurface: Partial<Record<Surface, Dist>>; // closing speed at first touch
    impulse: Dist;
    workJ: Dist;
    energyJ: Dist;
    peakForceKN: Dist;
  };
  ledger: DamageLedger;
  getUpS: number[];
}

const pick = (xs: number[], q: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length - 1) * q))] : 0);
export const dist = (xs: number[]): Dist => ({ n: xs.length, p50: pick(xs, 0.5), p90: pick(xs, 0.9), max: xs.length ? Math.max(...xs) : 0 });

export function surfaceOf(part: string | null | undefined): Surface {
  if (!part) return 'other';
  if (part.startsWith('fist') || part.startsWith('finger')) return 'fist';
  if (part.startsWith('foot')) return 'foot';
  if (part.startsWith('shin')) return 'shin';
  return 'other';
}

interface StrikeRow { surface: Surface; speed: number; impulse: number; work: number; energy: number; peak: number; clean: boolean }

export class DamageRecorder {
  private rows: [StrikeRow[], StrikeRow[]] = [[], []];
  private pushes = [0, 0];
  private fellAt: Array<number | null> = [null, null];
  private getUps: [number[], number[]] = [[], []];

  constructor(private readonly ctx: SimContext) {}

  onEvent(e: SimEvent, time: number): void {
    if (e.kind === 'impact' && e.striker !== null && e.victim !== null && e.striker !== e.victim) {
      if (e.push) {
        this.pushes[e.striker]++;
        return;
      }
      this.rows[e.striker].push({
        surface: surfaceOf(e.strikerPart), speed: e.speed, impulse: e.impulseNs, work: e.workJ ?? 0, energy: e.energyJ,
        peak: (e.peakForceN ?? 0) / 1000, clean: !!e.clean,
      });
    } else if (e.kind === 'fall') this.fellAt[e.corner] = time;
    else if (e.kind === 'getup' && this.fellAt[e.corner] !== null) {
      this.getUps[e.corner].push(time - this.fellAt[e.corner]!);
      this.fellAt[e.corner] = null;
    }
  }

  fighter(c: 0 | 1): FighterDamage {
    const rows = this.rows[c];
    const bySurface: Partial<Record<Surface, Dist>> = {};
    for (const s of ['fist', 'foot', 'shin', 'other'] as Surface[]) {
      const v = rows.filter((r) => r.surface === s).map((r) => r.speed);
      if (v.length) bySurface[s] = dist(v);
    }
    return {
      strikes: {
        landed: rows.length,
        clean: rows.filter((r) => r.clean).length,
        pushes: this.pushes[c],
        speedBySurface: bySurface,
        impulse: dist(rows.map((r) => r.impulse)),
        workJ: dist(rows.map((r) => r.work)),
        energyJ: dist(rows.map((r) => r.energy)),
        peakForceKN: dist(rows.map((r) => r.peak)),
      },
      ledger: structuredClone(damageState(this.ctx).robots[c].ledger),
      getUpS: [...this.getUps[c]],
    };
  }
}

const CAUSES: JointCause[] = ['gear', 'bearing', 'hyperextension', 'housing', 'detach', 'thermal'];
const ROLES: JointRole[] = ['victim', 'striker', 'none'];
const FAILURES: JointFailure[] = ['seize', 'strip', 'slip', 'bend', 'hyperextension', 'fault', 'seal'];

/** Summary lines over a set of fights (append to tools/fight-metrics.ts's summary). */
export function damageSummary(fights: Array<{ length: number; fighters: Array<{ design: string; damage?: FighterDamage }> }>): string[] {
  const fs = fights.flatMap((f) => f.fighters.filter((x) => x.damage).map((x) => ({ f, x, d: x.damage! })));
  if (!fs.length) return [];
  const n = fights.length;
  const loss: Record<string, number> = {};
  let total = 0;
  for (const { d } of fs) for (const c of CAUSES) for (const r of ROLES) {
    const v = d.ledger.jointLoss[c]?.[r] ?? 0;
    loss[`${c}.${r}`] = (loss[`${c}.${r}`] ?? 0) + v;
    total += v;
  }
  const byRole = (r: JointRole) => CAUSES.reduce((a, c) => a + (loss[`${c}.${r}`] ?? 0), 0);
  const fails: Record<string, number> = {};
  for (const { d } of fs) for (const k of FAILURES) fails[k] = (fails[k] ?? 0) + (d.ledger.failures[k] ?? 0);
  const injuredFights = fights.filter((f) => f.fighters.some((x) => (x.damage?.ledger.injured.length ?? 0) > 0)).length;
  const injured = fs.reduce((a, { d }) => a + d.ledger.injured.length, 0);
  const wrecked = fights.filter((f) => f.fighters.some((x) => x.damage && (x.damage.ledger.failures.seize + x.damage.ledger.failures.strip + x.damage.ledger.failures.bend + x.damage.ledger.failures.seal) > 0)).length;
  const dentsBy = new Map<string, { dents: number; cracks: number; n: number }>();
  for (const { x, d } of fs) {
    const e = dentsBy.get(x.design) ?? { dents: 0, cracks: 0, n: 0 };
    e.dents += d.ledger.dents.count;
    e.cracks += d.ledger.dents.cracks;
    e.n++;
    dentsBy.set(x.design, e);
  }
  const all = (sel: (d: FighterDamage) => number[]) => fs.flatMap(({ d }) => sel(d));
  const landed = fs.reduce((a, { d }) => a + d.strikes.landed, 0);
  const clean = fs.reduce((a, { d }) => a + d.strikes.clean, 0);
  const pushes = fs.reduce((a, { d }) => a + d.strikes.pushes, 0);
  const getups = all((d) => d.getUpS);
  // Failures by joint and cause, with the role (what broke, where, and whose fault it was).
  const byJoint = new Map<string, number>();
  for (const { x, d } of fs) {
    for (const e of d.ledger.log ?? []) {
      if (e.failure === 'wear') continue;
      const k = `${x.design}.${e.joint} ${e.cause}/${e.failure} (${e.role})`;
      byJoint.set(k, (byJoint.get(k) ?? 0) + 1);
    }
  }
  const f1 = (v: number) => v.toFixed(1);
  const f3 = (v: number) => v.toFixed(3);
  const surfaces = (['fist', 'foot', 'shin', 'other'] as Surface[]).map((s) => {
    const sp = fs.flatMap(({ d }) => (d.strikes.speedBySurface[s] ? [d.strikes.speedBySurface[s]!] : []));
    if (!sp.length) return null;
    // Weighted by count: rebuild an approximate pooled p50 / p90 from per-fighter quantiles.
    const nn = sp.reduce((a, q) => a + q.n, 0);
    const p50 = sp.reduce((a, q) => a + q.p50 * q.n, 0) / nn;
    const p90 = sp.reduce((a, q) => a + q.p90 * q.n, 0) / nn;
    return `${s} ${f1(p50)}/${f1(p90)} m/s (${nn})`;
  }).filter(Boolean).join(', ');
  const pooled = (k: 'impulse' | 'workJ' | 'energyJ' | 'peakForceKN') => {
    const qs = fs.map(({ d }) => d.strikes[k]).filter((q) => q.n);
    const nn = qs.reduce((a, q) => a + q.n, 0);
    return nn ? `${f1(qs.reduce((a, q) => a + q.p50 * q.n, 0) / nn)}/${f1(qs.reduce((a, q) => a + q.p90 * q.n, 0) / nn)}` : '-';
  };
  return [
    'damage (docs/design/strike-power.md §4-5; thresholds PROVISIONAL until after P3):',
    `  strike episodes landed ${landed}, clean ${landed ? ((100 * clean) / landed).toFixed(0) : 0}%, push episodes ${pushes}`,
    `  contact speed by surface p50/p90   ${surfaces || '-'}`,
    `  per strike p50/p90: impulse ${pooled('impulse')} N·s, absorbed work ${pooled('workJ')} J, presentation energy ${pooled('energyJ')} J, peak force ${pooled('peakForceKN')} kN`,
    `  joint health lost ${f3(total)} (${f3(total / n)} per fight): victim ${f3(byRole('victim'))}, striker ${f3(byRole('striker'))} (${total > 0 ? ((100 * byRole('striker')) / total).toFixed(0) : 0}% self), none ${f3(byRole('none'))}`,
    `  by channel: ${CAUSES.map((c) => `${c} ${f3(ROLES.reduce((a, r) => a + (loss[`${c}.${r}`] ?? 0), 0))}`).join(', ')}`,
    `  failures: ${FAILURES.map((k) => `${k} ${fails[k]}`).join(', ')}   seizes per fight ${f3(fails.seize / n)}   target <= 0.2`,
    `  fights with a joint injury (degraded or worse) ${injuredFights}/${n} (${((100 * injuredFights) / n).toFixed(0)}%), injured joints ${injured} (${f3(injured / n)} per fight)   target 25-50% of full fights`,
    `  fights with a joint wrecked (seize, strip, bend, seal) ${wrecked}/${n}   target <= 1 per 3 fights`,
    `  failures by joint: ${[...byJoint].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join(', ') || 'none'}`,
    `  dents per fight by design: ${[...dentsBy].map(([k, v]) => `${k} ${f1(v.dents / v.n)}${v.cracks ? ` (${v.cracks} cracks)` : ''}`).join(', ')}`,
    `  get-up seconds median/p90 ${getups.length ? `${f1(pick(getups, 0.5))}/${f1(pick(getups, 0.9))} (${getups.length})` : '-'}`,
  ];
}
