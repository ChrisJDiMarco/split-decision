// Types the balance engine shares with the controller, the tracker and the tools
// (docs/design/balance-engine.md §7).
import type { Side } from '../geometry';
import type { FootPlace, P2 } from '../support';

/** Where a footstep comes from (the planner that wrote it). */
export type StepSource = 'walk' | 'shuffle' | 'pivot' | 'arrive' | 'clip' | 'kick' | 'capture' | 'square';

/**
 * One planned footstep: the sole lifts at `lift` and lands on `place` at `land` (sim seconds);
 * while it swings, the centroidal moment pivot (CMP) rolls from cmp[0] to cmp[1] on the stance
 * sole. `clearance` is the swing apex above the canvas.
 */
export interface Footstep {
  side: Side;
  place: FootPlace;
  lift: number;
  land: number;
  cmp: [P2, P2];
  clearance: number;
  source: StepSource;
  /** A clip footstep: its index in the mocap pick (balance/mocap-steps.ts). */
  clipIdx?: number;
}

export type BalanceStateMode = 'steady' | 'absorb' | 'recover' | 'brace' | 'down' | 'rise';

/** Balance → tactics, tracker and openings (the flashy stage reads canStrike / canKick). */
export interface BalanceState {
  xi: P2; // measured DCM (capture point)
  xiRef: P2; // planned DCM
  /** 1 = DCM deep inside the support and the gyro fresh; 0 = falling or down. */
  margin: number;
  /** Share of the gyro's momentum still free (1 − saturation), 0 without a core. */
  gyroReserve: number;
  mode: BalanceStateMode;
  clipRate: number;
  clipSync: { hold: boolean; jumpTo?: number };
  /**
   * Steady on both feet: planted, slow (Euphoria's 0.3 m/s and 0.3 rad/s), the DCM on its plan inside
   * the soles and the gyro in hand. What a kick waits for, and the referee's test for FIGHT.
   */
  steady: boolean;
  /**
   * An arm strike may start now, from the footing the body has (the pace stage): steady; or on two
   * feet still moving with the DCM settled inside the soles; or from a planned step whose landing
   * catches the DCM, the touchdown close (the blow lands with the foot). Never during a capture step.
   */
  canStrike: boolean;
  /** A leg may be lent to a kick now (steady, both soles flat, the gyro's reserve for the kick). */
  canKick: boolean;
  /** Where the DCM will be at the touchdown of the swing in the air (single support); else the DCM. */
  xiTouch: P2;
  /** Seconds to that touchdown (-1 with no swing in the air). */
  touchIn: number;
}

/** What the tools read every control tick (both modes fill it). */
export interface BalanceProbe {
  cop: P2; // centre of pressure the feed-forward plans for
  cmp: P2; // commanded CMP (plan + feedback), before the soles clip it
  xi: P2;
  xiRef: P2;
  /** Footsteps completed (touchdowns) and swings started, cumulative. */
  touchdowns: number;
  lifts: number;
  /** Gait the planner is running: 'legacy', or 'hold' | 'walk' | 'drag' | 'capture' | 'skill'. */
  gait: string;
  /** Gyro momentum free at the last touchdown (1 = empty rotor). */
  reserveAtTouchdown: number;
  /** Mocap footwork (Phase 5): swings that were clip steps, time with a clip driving the feet, time
   *  with the clip style on, picks made and picks that fell back to the procedural steps. */
  clipLifts: number;
  clipTime: number;
  /** Swings and time with the clip's clock following the planner's own steps (style only). */
  followLifts: number;
  followTime: number;
  /** Time with footsteps planned or a foot in the air (the denominator of clipTime). */
  moveTime: number;
  styleTime: number;
  picks: number;
  fallbacks: number;
}

export function newProbe(): BalanceProbe {
  return {
    cop: [0, 0], cmp: [0, 0], xi: [0, 0], xiRef: [0, 0], touchdowns: 0, lifts: 0, gait: 'legacy', reserveAtTouchdown: 1,
    clipLifts: 0, clipTime: 0, followLifts: 0, followTime: 0, moveTime: 0, styleTime: 0, picks: 0, fallbacks: 0,
  };
}
