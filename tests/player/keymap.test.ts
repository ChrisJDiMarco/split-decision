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
    expect(heldActionFor(map, 'KeyG')).toBe('guard');
    expect(heldActionFor(map, 'ControlLeft')).toBeNull();
    expect(heldActionFor(map, 'KeyC')).toBe('clinch');
    expect(heldActionFor(map, 'KeyQ')).toBeNull();
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyR', 'KeyF', 'KeyZ', 'KeyX', 'Tab', 'Space', 'KeyV', 'KeyH', 'KeyC', 'KeyG']) {
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

  it('never binds Ctrl, Alt or Cmd (browser and OS shortcuts)', () => {
    const all = Object.values(fresh()).flat();
    expect(all.some((b) => /Control|Alt|Meta/.test(b))).toBe(false);
    expect(rebind(fresh(), 'guard', 'ControlLeft').guard).toEqual(['KeyG']);
    expect(rebind(fresh(), 'jab', 'Shift+AltLeft').jab).toEqual(['Mouse0']);
    // The host's own keys stay free in player mode (main.ts T/L/N, the broadcast's O/I, P replay, M mute).
    for (const code of ['KeyT', 'KeyL', 'KeyN', 'KeyO', 'KeyI', 'KeyP', 'KeyM']) expect(isBoundCode(fresh(), code)).toBe(false);
  });

  it('migrates a saved keymap that still guards on Ctrl', () => {
    // Saved before the move: every action stored, guard on both Ctrl keys.
    const old = { ...fresh(), guard: ['ControlLeft', 'ControlRight'] };
    const migrated = mergeKeymap(JSON.parse(JSON.stringify(old)));
    expect(migrated.guard).toEqual(['KeyG']);
    expect(heldActionFor(migrated, 'KeyG')).toBe('guard');
    // G was already rebound to feint: guard takes the first free fallback, feint keeps G.
    const taken = mergeKeymap({ ...old, feint: ['KeyG'] });
    expect(taken.feint).toEqual(['KeyG']);
    expect(taken.guard).toEqual(['KeyY']);
    expect(pressActionFor(taken, 'KeyG', false)).toBe('feint');
    // A Ctrl binding next to a good one: only the Ctrl binding goes.
    expect(mergeKeymap({ guard: ['ControlLeft', 'KeyV'], toggle_camera: ['KeyK'] }).guard).toEqual(['KeyV']);
    // Defaults filled in beside saved rebinds keep their Shift chords (low kick R, head kick Shift+R).
    const partial = mergeKeymap({ jab: ['KeyJ'] });
    expect(partial.low_kick).toEqual(['KeyR']);
    expect(partial.head_kick).toEqual(['Shift+KeyR']);
    expect(partial.uppercut).toEqual(['Shift+Mouse0']);
  });

  it('labels bindings for the hints', () => {
    expect(bindingLabel('Shift+Mouse0')).toBe('SHIFT + LMB');
    expect(bindingLabel('KeyQ')).toBe('Q');
    expect(bindingLabel('ControlLeft')).toBe('CTRL');
  });
});
