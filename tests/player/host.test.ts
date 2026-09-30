import { describe, expect, it } from 'vitest';
import { breakRoleOf, inputAllowed, playerHostState } from '../../src/player/host';

describe('player host policy', () => {
  it('input is live only while the fight runs', () => {
    expect(playerHostState('fight', false, false, 'chase').enabled).toBe(true);
    for (const p of ['select', 'intro', 'break', 'ko', 'decision', 'over'] as const) expect(playerHostState(p, false, false, 'chase').enabled).toBe(false);
    expect(playerHostState('fight', true, false, 'chase').enabled).toBe(false); // a replay
    expect(playerHostState('fight', false, true, 'chase').enabled).toBe(false); // sim paused
  });

  it('the director owns the walkout, replays and the winner card; the player picks otherwise', () => {
    expect(playerHostState('intro', false, false, 'chase').camera).toBe('director');
    expect(playerHostState('fight', true, false, 'chase').camera).toBe('director');
    expect(playerHostState('over', false, false, 'chase').camera).toBe('director');
    expect(playerHostState('fight', false, false, 'chase').camera).toBe('chase');
    expect(playerHostState('ko', false, false, 'chase').camera).toBe('chase');
    expect(playerHostState('fight', false, false, 'director').camera).toBe('director');
    expect(playerHostState('over', false, false, 'chase').hud).toBe(false);
    expect(playerHostState('ko', false, false, 'chase').hud).toBe(true);
  });

  it('a referee break holds input until FIGHT, except a downed fighter getting up', () => {
    expect(breakRoleOf({})).toBeNull();
    expect(breakRoleOf({ referee: { break: false } })).toBeNull();
    expect(breakRoleOf({ referee: { break: true, role: 'neutral' } })).toBe('neutral');
    expect(breakRoleOf({ referee: { break: true } })).toBe('hold');
    expect(inputAllowed(true, null)).toBe(true);
    expect(inputAllowed(true, 'down')).toBe(true);
    expect(inputAllowed(true, 'neutral')).toBe(false);
    expect(inputAllowed(true, 'hold')).toBe(false);
    expect(inputAllowed(false, null)).toBe(false);
  });
});
