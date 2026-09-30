import { describe, expect, test } from 'vitest';
import type { FighterSetup, MatchSetup } from '../../core/types';
import { PLAYER_REACTION_DELAY_S } from '../../player/config';
import { cornerPick, effectiveMind, finalizeSetup, isOverridden, localStatusLine, pickMind, playerCornerOf } from '../mind-picks';

const f = (over: Partial<FighterSetup> = {}): FighterSetup => ({ design: 'savate', skin: 'livery', plan: 'jab', temperament: 1, ...over });
const match = (a: FighterSetup, b: FighterSetup): MatchSetup => ({ fighters: [a, b], seed: 7, timestep: 0.001, reactionDelayS: 0.3 });

describe('mind picks', () => {
  test('a corner with no pick is JEV, and PER CORNER keeps each pick', () => {
    expect(cornerPick(f())).toBe('jev');
    expect(effectiveMind(f(), 'corner')).toBe('jev');
    expect(effectiveMind(f({ mind: 'local' }), 'corner')).toBe('local');
    expect(effectiveMind(f({ mind: 'house' }), 'corner')).toBe('house');
  });

  test('ALL JEV / ALL LOCAL / ALL HOUSE override every corner except YOU', () => {
    for (const g of ['jev', 'local', 'house'] as const) {
      expect(effectiveMind(f({ mind: 'local' }), g)).toBe(g);
      expect(effectiveMind(f({ controller: 'player', mind: 'house' }), g)).toBe('you');
    }
    expect(isOverridden(f({ mind: 'local' }), 'house')).toBe(true);
    expect(isOverridden(f({ mind: 'house' }), 'house')).toBe(false);
    expect(isOverridden(f({ controller: 'player' }), 'house')).toBe(false);
    expect(isOverridden(f({ mind: 'local' }), 'corner')).toBe(false);
  });

  test('at most one YOU: picking YOU sends the other corner back to its previous mind', () => {
    let fs = pickMind([f({ mind: 'local' }), f({ mind: 'house' })], 1, 'you');
    expect(fs.map(cornerPick)).toEqual(['local', 'you']);
    expect(fs[1].mind).toBe('house'); // kept for when YOU is dropped
    fs = pickMind(fs, 0, 'you');
    expect(fs.map(cornerPick)).toEqual(['you', 'house']);
    expect(fs[1].controller).toBeUndefined();
    fs = pickMind(fs, 0, 'jev');
    expect(fs.map(cornerPick)).toEqual(['jev', 'house']);
    expect(playerCornerOf({ fighters: fs })).toBe(-1);
  });

  test('pickMind never mutates its input', () => {
    const before: [FighterSetup, FighterSetup] = [f(), f({ controller: 'player', reactionDelayS: 0.05 })];
    const copy = JSON.parse(JSON.stringify(before));
    const out = pickMind(before, 1, 'house');
    expect(before).toEqual(copy);
    expect(out[1]).toEqual({ ...f(), mind: 'house' });
  });

  test('a fight between two minds starts from the very same setup (JEV v JEV unchanged)', () => {
    const s = match(f(), f({ design: 'haymaker' }));
    expect(finalizeSetup(s, false)).toBe(s);
    expect(finalizeSetup(s, true)).toBe(s);
  });

  test('YOU gets the player delay; FAIR MODE leaves Jev\'s', () => {
    const s = match(f(), f({ controller: 'player', reactionDelayS: 0.2 }));
    expect(finalizeSetup(s, false).fighters[1].reactionDelayS).toBe(PLAYER_REACTION_DELAY_S);
    expect('reactionDelayS' in finalizeSetup(s, true).fighters[1]).toBe(false);
    expect(finalizeSetup(s, true).fighters[0]).toBe(s.fighters[0]);
    expect(playerCornerOf(s)).toBe(1);
  });

  test('the LOCAL status line reads ready, or why not', () => {
    expect(localStatusLine(null).ok).toBeNull();
    expect(localStatusLine({ ok: true, model: 'decider-4b', latencyMs: 480.4 })).toEqual({ ok: true, text: 'READY · decider-4b · 480 MS' });
    expect(localStatusLine({ ok: false, error: 'model hf.co/Mapika/decider-4b-GGUF:Q4_K_M is not pulled (ollama pull ...)' }).text).toBe('NOT RUNNING · MODEL NOT PULLED');
    expect(localStatusLine({ ok: false, error: 'local runtime unreachable at http://127.0.0.1:11434 (fetch failed)' }).text).toBe('NOT RUNNING · RUNTIME NOT RUNNING');
    expect(localStatusLine({ ok: false, error: 'health HTTP 404' }).text).toBe('NOT RUNNING · NO LOCAL BRIDGE');
    expect(localStatusLine({ ok: false, error: 'health unreachable: Failed to fetch' }).text).toBe('NOT RUNNING · NO LOCAL BRIDGE');
  });
});
