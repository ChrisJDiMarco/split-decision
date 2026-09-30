import { describe, expect, it } from 'vitest';
import { GLOBAL_MINDS, onSettingsChange, setSetting, settings } from '../../src/core/settings';

describe('MINDS and FAIR MODE settings', () => {
  it('default to PER CORNER and off, and notify listeners on change', () => {
    expect(settings().minds).toBe('corner');
    expect(settings().fairMode).toBe(false);
    expect(GLOBAL_MINDS).toEqual(['corner', 'jev', 'local', 'house']);
    const seen: string[] = [];
    const off = onSettingsChange((s) => seen.push(`${s.minds}/${s.fairMode}`));
    setSetting('minds', 'house');
    setSetting('minds', 'house'); // unchanged: no event
    setSetting('fairMode', true);
    off();
    setSetting('minds', 'corner');
    expect(seen).toEqual(['house/false', 'house/true']);
    setSetting('fairMode', false);
  });
});
