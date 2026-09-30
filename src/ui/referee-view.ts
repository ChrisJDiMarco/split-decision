// The referee break as the broadcast shows it: a clean banner with the count while the fight is
// held (src/physics/systems/referee.ts, RobotTelemetry.referee). Pure logic (no DOM), unit-tested.
import type { RobotTelemetry } from '../core/protocol';
import type { Corner } from '../core/types';

export interface BreakBanner {
  count: number; // whole seconds since the break started (referee.breakS)
  title: string; // 'BREAK' or 'DOUBLE KNOCKDOWN'
  sub: string; // 'HAYMAKER DOWN · SAVATE TO A NEUTRAL CORNER', 'WAITING FOR FIGHT'
  corner: Corner | null; // whose colour the banner takes: the fighter sent to the neutral corner
}

type RefView = Pick<RobotTelemetry, 'corner' | 'referee'>;

/** The banner for this frame's telemetry, or null while they fight. */
export function breakBanner(tel: readonly [RefView, RefView] | null, names: readonly [string, string]): BreakBanner | null {
  const ref = tel?.find((t) => t.referee?.break)?.referee;
  if (!tel || !ref) return null;
  const count = Math.max(0, Math.floor(ref.breakS ?? 0));
  const role = (c: Corner) => tel[c].referee?.role ?? null;
  const down = ([0, 1] as Corner[]).filter((c) => role(c) === 'down');
  const neutral = ([0, 1] as Corner[]).filter((c) => role(c) === 'neutral');
  if (down.length === 2) return { count, title: 'DOUBLE KNOCKDOWN', sub: 'BOTH GETTING UP', corner: null };
  const corner = neutral[0] ?? null;
  const parts = [
    ...down.map((c) => `${names[c].toUpperCase()} DOWN`),
    ...neutral.map((c) => `${names[c].toUpperCase()} TO A NEUTRAL CORNER`),
  ];
  return { count, title: 'BREAK', sub: parts.length ? parts.join(' · ') : 'WAITING FOR FIGHT', corner };
}
