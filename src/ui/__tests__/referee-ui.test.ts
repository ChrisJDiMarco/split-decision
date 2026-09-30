// The referee break on the broadcast: ticker lines from the break / fight events, the MIND panel's
// break line and real mind title, and the banner with the count.
import { describe, expect, test } from 'vitest';
import type { RefereeTelemetry, RobotTelemetry, SimEvent } from '../../core/protocol';
import { HELD_BY_REFEREE, mindTitle, refereeLine, type MindView } from '../minds';
import { breakBanner } from '../referee-view';
import { TickerFeed } from '../ticker-feed';

const NAMES = ['Savate', 'Haymaker'] as const;
const brk = (down: Array<0 | 1>): SimEvent => ({ kind: 'break', down });
const fight: SimEvent = { kind: 'fight', breakS: 9.4, reason: 'room' };

function view(over: Partial<MindView> = {}): MindView {
  return { source: 'jev', tactic: 'jab', target: 'head', aggression: 0.5, tacticProbs: { jab: 1 }, oppCommit: null, latencyMs: 250, ...over };
}

describe('ticker', () => {
  test('break, double knockdown and FIGHT each call one line', () => {
    const feed = new TickerFeed(NAMES);
    expect(feed.ingest([brk([1])], null, 10).map((i) => i.text)).toEqual(['Referee sends Savate to a neutral corner']);
    expect(feed.ingest([brk([1])], null, 10)[0].corner).toBe(0); // the standing fighter's story
    expect(feed.ingest([brk([0])], null, 11).map((i) => i.text)).toEqual(['Referee sends Haymaker to a neutral corner']);
    expect(feed.ingest([brk([0, 1])], null, 12).map((i) => i.text)).toEqual(['Double knockdown']);
    expect(feed.ingest([fight], null, 20).map((i) => i.text)).toEqual(['FIGHT!']);
  });

  test('the standing man falling after the first is back up is not a double knockdown', () => {
    const feed = new TickerFeed(NAMES);
    // The break's union says both went down, the referee's live roles: Savate down, Haymaker sent away.
    const t = (corner: 0 | 1, role: RefereeTelemetry['role']) => ({ corner, referee: { break: true, role }, parts: [], battery: 1, gyroHealth: 0, gyroSaturation: 0 }) as unknown as RobotTelemetry;
    const tel = [t(0, 'down'), t(1, 'neutral')];
    expect(feed.ingest([brk([0, 1])], tel, 14).map((i) => i.text)).toEqual(['Referee sends Haymaker to a neutral corner']);
    const both = [t(0, 'down'), t(1, 'down')];
    expect(feed.ingest([brk([0, 1])], both, 15).map((i) => i.text)).toEqual(['Double knockdown']);
  });

  test('a fall, the break and FIGHT in order, nothing twice', () => {
    const feed = new TickerFeed(NAMES);
    const lines = feed.ingest([{ kind: 'fall', corner: 1 }, brk([1])], null, 5).map((i) => i.text);
    expect(lines).toEqual(['Haymaker is down!', 'Referee sends Savate to a neutral corner']);
  });
});

describe('MIND panel lines', () => {
  test('the break line follows the referee role, and nothing outside a break', () => {
    const r = (role: RefereeTelemetry['role']): RefereeTelemetry => ({ break: true, role });
    expect(refereeLine(r('neutral'))).toBe('BREAK · NEUTRAL CORNER');
    expect(refereeLine(r('hold'))).toBe('BREAK · WAITING');
    expect(refereeLine(r('down'))).toBe('DOWN · GETTING UP');
    expect(refereeLine({ break: false })).toBeNull();
    expect(refereeLine(null)).toBeNull();
    expect(HELD_BY_REFEREE).toBe('HELD BY REFEREE');
  });

  test('the title names the mind really deciding: JEV, LOCAL or HOUSE', () => {
    expect(mindTitle(null)).toBeNull();
    expect(mindTitle(view())).toBe('JEV');
    expect(mindTitle(view({ link: { kind: 'jev', label: 'JEV' } }))).toBe('JEV');
    expect(mindTitle(view({ link: { kind: 'local', label: 'LOCAL · decider-4b' } }))).toBe('LOCAL');
    expect(mindTitle(view({ source: 'fallback', link: { kind: 'house', label: 'HOUSE' } }))).toBe('HOUSE');
    expect(mindTitle(view({ source: 'fallback', link: { kind: 'offline', label: 'LOCAL OFFLINE → HOUSE' } }))).toBe('HOUSE');
    expect(mindTitle(view({ source: 'fallback' }))).toBe('HOUSE');
  });
});

describe('break banner', () => {
  const tel = (a?: RefereeTelemetry, b?: RefereeTelemetry) =>
    [{ corner: 0, referee: a }, { corner: 1, referee: b }] as [Pick<RobotTelemetry, 'corner' | 'referee'>, Pick<RobotTelemetry, 'corner' | 'referee'>];

  test('shows who is down, who is sent away and the count', () => {
    const b = breakBanner(tel({ break: true, role: 'neutral', breakS: 7.9 }, { break: true, role: 'down', breakS: 7.9 }), NAMES);
    expect(b).toEqual({ count: 7, title: 'BREAK', sub: 'HAYMAKER DOWN · SAVATE TO A NEUTRAL CORNER', corner: 0 });
  });

  test('a double knockdown, the wait for FIGHT, and nothing while they fight', () => {
    expect(breakBanner(tel({ break: true, role: 'down', breakS: 2 }, { break: true, role: 'down', breakS: 2 }), NAMES)?.title).toBe('DOUBLE KNOCKDOWN');
    expect(breakBanner(tel({ break: true, role: 'hold', breakS: 12.2 }, { break: true, role: 'hold', breakS: 12.2 }), NAMES))
      .toEqual({ count: 12, title: 'BREAK', sub: 'WAITING FOR FIGHT', corner: null });
    expect(breakBanner(tel({ break: false }, { break: false }), NAMES)).toBeNull();
    expect(breakBanner(null, NAMES)).toBeNull();
  });
});
