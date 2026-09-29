import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEYMAP, bindingLabel, chordOf, heldActionFor, isBoundCode, loadKeymap, mergeKeymap, pressActionFor, rebind, saveKeymap, type Keymap,
} from '../../src/player/keymap';

const fresh = (): Keymap => mergeKeymap(null);

describe('player keymap', () => {
  it('maps the default presses, Shift chords first and plain bindings as the fallback', () => {
    const map = fresh();
    expect(pressActionFor(map, 'Mouse0', false)).toBe('jab');
    expect(pressActionFor(map, 'Mouse2', false)).toBe('cross');
    expect(pressActionFor(map, 'Mouse0', true)).toBe('uppercut');
    expect(pressActionFor(map, 'Mouse2', true)).toBe('overhand');
    expect(pressActionFor(map, 'KeyR', false)).toBe('low_kick');
    expect(pressActionFor(map, 'KeyR', true)).toBe('head_kick');
    expect(pressActionFor(map, 'KeyF', true)).toBe('front_kick');
    expect(pressActionFor(map, 'Space', false)).toBe('slip');
    expect(pressActionFor(map, 'KeyP', false)).toBeNull();
  });

  it('held actions ignore modifiers and every default key is swallowed', () => {
    const map = fresh();
    expect(heldActionFor(map, 'KeyW')).toBe('move_forward');
    expect(heldActionFor(map, 'ControlLeft')).toBe('guard');
    expect(heldActionFor(map, 'KeyC')).toBe('clinch');
    expect(heldActionFor(map, 'KeyQ')).toBeNull();
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyR', 'KeyF', 'KeyZ', 'KeyX', 'Tab', 'Space', 'KeyV', 'KeyH', 'KeyC']) {
      expect(isBoundCode(map, code)).toBe(true);
    }
    expect(chordOf('ShiftLeft', true)).toBe('ShiftLeft');
  });

  it('rebinding takes the key away from whatever had it', () => {
    let map = rebind(fresh(), 'jab', 'KeyQ');
    expect(map.jab).toEqual(['KeyQ']);
    expect(map.hook_lead).toEqual([]);
    expect(pressActionFor(map, 'KeyQ', false)).toBe('jab');
    // A held key owns its code with and without Shift.
    map = rebind(map, 'move_forward', 'Shift+KeyR');
    expect(map.move_forward).toEqual(['KeyR']);
    expect(map.low_kick).toEqual([]);
    expect(map.head_kick).toEqual([]);
    expect(map.move_back).toEqual(['KeyS']);
    // Invalid bindings are refused.
    expect(rebind(map, 'jab', 'not a key!')).toBe(map);
  });

  it('merges stored overrides over the defaults and survives broken storage', () => {
    const merged = mergeKeymap({ jab: ['KeyJ'], cross: ['<script>'], bogus: ['KeyK'] });
    expect(merged.jab).toEqual(['KeyJ']);
    expect(merged.cross).toEqual(DEFAULT_KEYMAP.cross);
    expect('bogus' in merged).toBe(false);
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadKeymap(throwing).jab).toEqual(['Mouse0']);
    expect(saveKeymap(fresh(), throwing)).toBe(false);
    const store = new Map<string, string>();
    const mem = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(saveKeymap(rebind(fresh(), 'feint', 'KeyG'), mem)).toBe(true);
    expect(loadKeymap(mem).feint).toEqual(['KeyG']);
  });

  it('labels bindings for the hints', () => {
    expect(bindingLabel('Shift+Mouse0')).toBe('SHIFT + LMB');
    expect(bindingLabel('KeyQ')).toBe('Q');
    expect(bindingLabel('ControlLeft')).toBe('CTRL');
  });
});
