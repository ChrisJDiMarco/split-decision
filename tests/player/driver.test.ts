import { describe, expect, it } from 'vitest';
import type { Intent } from '../../src/core/protocol';
import { BUFFER_TTL_S, START_TIMEOUT_S } from '../../src/player/config';
import { CIRCLE_TO, footworkTactic, moveFrom, PlayerDriver, type SelfState } from '../../src/player/driver';
import type { HeldAction } from '../../src/player/keymap';

const stand: SelfState = { skill: 'stance', skillPhase: 0, down: false };
const running = (skill: string, skillPhase: number): SelfState => ({ skill, skillPhase, down: false });

/** Drive until the next intent is emitted (or null). */
function step(d: PlayerDriver, t: number, s: SelfState | null = stand): Intent | null {
  return d.update(t, s);
}

describe('footwork mapping', () => {
  const m = (...held: HeldAction[]) => moveFrom(new Set(held));
  it('WASD is a unit-bounded vector relative to the opponent', () => {
    expect(m('move_forward')).toEqual({ forward: 1, strafe: 0 });
    expect(m('move_right')).toEqual({ forward: 0, strafe: 1 });
    const diag = m('move_forward', 'move_left');
    expect(Math.hypot(diag.forward, diag.strafe)).toBeCloseTo(1);
    expect(m('move_forward', 'move_back')).toEqual({ forward: 0, strafe: 0 });
  });
  it('maps onto today\'s footwork tactics', () => {
    expect(footworkTactic(m())).toBe('hold_range');
    expect(footworkTactic(m('move_forward'))).toBe('close_distance');
    expect(footworkTactic(m('move_back'))).toBe('retreat');
    expect(footworkTactic(m('move_back', 'move_left'))).toBe('retreat');
    expect(footworkTactic(m('move_left'))).toBe(CIRCLE_TO.left);
    expect(footworkTactic(m('move_forward', 'move_right'))).toBe(CIRCLE_TO.right);
    // Measured in physics: control's circle_left steps to the fighter's own right.
    expect(CIRCLE_TO.left).toBe('circle_right');
  });
});

describe('PlayerDriver', () => {
  it('starts on hold_range with the move vector and a player source', () => {
    const d = new PlayerDriver();
    const i = step(d, 0)!;
    expect(i.tactic).toBe('hold_range');
    expect(i.source).toBe('player');
    expect(i.move).toEqual({ forward: 0, strafe: 0 });
    expect(step(d, 0.1)).toBeNull(); // unchanged: nothing resent
    d.setHeld(['move_forward']);
    expect(step(d, 0.2)!.tactic).toBe('close_distance');
  });

  it('holds a strike until it starts and passes its commit point, then returns to footwork', () => {
    const d = new PlayerDriver();
    step(d, 0);
    const started: number[] = [];
    d.onStrikeStarted = (p, s) => started.push(s - p);
    d.press('jab', 1);
    const jab = step(d, 1)!;
    expect(jab).toMatchObject({ tactic: 'jab', hand: 'lead', target: 'head', aggression: 1 });
    expect(jab.combo).toBeUndefined();
    expect(step(d, 1.02, stand)).toBeNull();
    expect(step(d, 1.05, running('jab', 0.1))).toBeNull(); // in its windup: a footwork intent would cancel it
    expect(started).toHaveLength(1);
    expect(started[0]).toBeCloseTo(0.05);
    expect(step(d, 1.1, running('jab', 0.3))!.tactic).toBe('hold_range');
  });

  it('chains presses within the combo window and sequences them step by step', () => {
    const d = new PlayerDriver();
    step(d, 0);
    d.press('jab', 1);
    d.press('cross', 1.1);
    d.press('hook_lead', 1.3);
    const a = step(d, 1.3)!;
    expect(a.tactic).toBe('jab');
    expect(a.combo).toEqual(['jab', 'cross', 'hook']);
    expect(a.comboPlan?.step).toBe(0);
    expect(d.view().buffer).toEqual(['cross', 'hook']);
    step(d, 1.35, running('jab', 0.1));
    const b = step(d, 1.4, running('jab', 0.3))!;
    expect(b.tactic).toBe('cross');
    expect(b.combo).toEqual(['jab', 'cross', 'hook']);
    expect(b.comboPlan?.step).toBe(1);
    step(d, 1.6, running('stance', 0));
    step(d, 1.9, running('cross', 0.1));
    const c = step(d, 1.95, running('cross', 0.4))!;
    expect(c).toMatchObject({ tactic: 'hook', hand: 'lead', comboPlan: { step: 2 } });
  });

  it('presses further apart than the window are separate strikes, not a combo', () => {
    const d = new PlayerDriver();
    step(d, 0);
    d.press('jab', 1);
    d.press('low_kick', 1.5);
    expect(step(d, 1.5)!.combo).toBeUndefined();
    step(d, 1.6, running('jab', 0.1));
    const kick = step(d, 1.7, running('jab', 0.4))!;
    expect(kick.tactic).toBe('low_kick');
    expect(kick.target).toBe('left_leg');
    expect(kick.combo).toBeUndefined();
  });

  it('abandons a strike that never starts and drops stale presses', () => {
    const d = new PlayerDriver();
    step(d, 0);
    d.press('cross', 1);
    expect(step(d, 1)!.tactic).toBe('cross');
    expect(step(d, 1 + START_TIMEOUT_S + 0.01)!.tactic).toBe('hold_range');
    const e = new PlayerDriver();
    e.press('jab', 0);
    expect(step(e, BUFFER_TTL_S + 0.1)!.tactic).toBe('hold_range');
  });

  it('guard and clinch are held; strikes still go first; slip and feint stand briefly', () => {
    const d = new PlayerDriver();
    d.setHeld(['guard']);
    expect(step(d, 0)!.tactic).toBe('guard');
    d.press('uppercut', 0.1);
    expect(step(d, 0.1)!.tactic).toBe('uppercut');
    step(d, 0.15, running('uppercut', 0.1));
    expect(step(d, 0.2, running('uppercut', 0.35))!.tactic).toBe('guard');
    d.setHeld([]);
    d.press('slip', 1);
    expect(step(d, 1)!.tactic).toBe('sidestep_counter');
    expect(step(d, 2.5)!.tactic).toBe('hold_range');
    d.press('feint', 3);
    expect(step(d, 3)!.tactic).toBe('feint');
    d.setHeld(['clinch']);
    expect(step(d, 3.1)!.tactic).toBe('clinch');
  });

  it('aims punches at the body on B, and asks for a kip-up when Space is pressed while down', () => {
    const d = new PlayerDriver();
    d.press('aim_body', 0);
    d.press('jab', 0);
    expect(step(d, 0)!.target).toBe('torso');
    const down: SelfState = { skill: 'getup_prone', skillPhase: 0, down: true };
    expect(step(d, 1, down)).toMatchObject({ tactic: 'hold_range', getupStyle: 'safe' });
    d.press('slip', 1.1, down);
    expect(step(d, 1.1, down)!.getupStyle).toBe('kip_up');
    expect(d.view().buffer).toEqual([]);
  });

  it('keeps at most four strikes buffered', () => {
    const d = new PlayerDriver();
    for (let i = 0; i < 7; i++) d.press('jab', i * 0.05);
    step(d, 0.35);
    expect(d.view().buffer.length).toBe(3); // one sent, three waiting
  });
});

describe('PlayerDriver on a robot without a clinch', () => {
  it('does not send clinch (control would jab instead for as long as C is held)', () => {
    const d = new PlayerDriver();
    d.abilities = new Set(['jab', 'cross', 'hook', 'front_kick', 'low_kick', 'head_kick']);
    d.setHeld(['clinch']);
    expect(step(d, 0)!.tactic).toBe('hold_range');
    d.setHeld(['clinch', 'guard']);
    expect(step(d, 0.1)!.tactic).toBe('guard');
    d.abilities = new Set(['jab', 'clinch']);
    expect(step(d, 0.2)!.tactic).toBe('clinch');
  });
});
