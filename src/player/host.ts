// What the host (main.ts) and PlayerMode decide from the fight's state, as pure functions so the
// rules are testable without a browser: when player input is live, which camera drives the lens,
// and how a referee break gates input.
import type { RobotTelemetry } from '../core/protocol';

export type PlayerCameraMode = 'chase' | 'director';
/** The broadcast's fight phases (src/ui/broadcast.ts FightPhase). */
export type HostPhase = 'select' | 'intro' | 'fight' | 'break' | 'ko' | 'decision' | 'over';
/** The referee's break as the player sees it: null (fighting), or this fighter's role in the break. */
export type BreakRole = 'down' | 'neutral' | 'hold' | null;

export interface PlayerHostState {
  /** Player input on: only while the live fight runs. */
  enabled: boolean;
  /** The walkout, replays and the winner card belong to the director; the fight and the KO to the player's choice. */
  camera: PlayerCameraMode;
  /** The player HUD steps aside for the winner card and the select screen. */
  hud: boolean;
}

export function playerHostState(phase: HostPhase, replaying: boolean, simPaused: boolean, chosen: PlayerCameraMode): PlayerHostState {
  const directorOnly = replaying || phase === 'intro' || phase === 'over' || phase === 'select';
  return {
    enabled: phase === 'fight' && !replaying && !simPaused,
    camera: directorOnly ? 'director' : chosen,
    hud: phase !== 'over' && phase !== 'select',
  };
}

/** This fighter's role in a referee break (RobotTelemetry.referee), or null with no break. */
export function breakRoleOf(me: Pick<RobotTelemetry, 'referee'>): BreakRole {
  const ref = me.referee;
  return ref?.break ? ref.role ?? 'hold' : null;
}

/**
 * Input during a referee break: the body obeys the referee over any intent, so input waits for
 * FIGHT; a downed fighter keeps it, so Space can still pick the kip-up while it gets up.
 */
export function inputAllowed(hostEnabled: boolean, role: BreakRole): boolean {
  return hostEnabled && (role === null || role === 'down');
}
