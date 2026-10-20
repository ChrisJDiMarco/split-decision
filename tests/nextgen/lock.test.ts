// NEXT GEN regression lock (docs/design/next-gen-chassis.md §4.3 and the Phase 0 section): the
// seven existing fighters must not change while the NEXT GEN era is built next to them.
//  · the modern four compile to the same MJCF bytes and runtime fields (the iron three have their
//    own byte fixture in tests/roster/fixtures/iron-age-baseline.json);
//  · all seven replay the same fixed-seed behaviour trace (qpos hashed every 50 ms).
//
//   npx vitest run tests/nextgen/lock.test.ts                 # both locks (~1 min)
//   npx vitest run tests/nextgen/lock.test.ts -t mjcf          # bytes only (instant)
//
// A failure means something moved one of the seven. If that was NOT deliberate, find it: a NEXT GEN
// edit must never do this. If it WAS deliberate (an approved actuator swap, a control change meant to
// move the existing fighters), regenerate with tests/nextgen/regenerate.ts and say so in the commit.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BEHAVIOUR_FIXTURE, behaviourTrace, MJCF_FIXTURE, MODERN, mjcfLock, SEVEN, sourceFingerprint, type BehaviourTrace, type MjcfLock } from './lock-lib';

type Meta = { source: { sha256: string } };
const mjcf = JSON.parse(readFileSync(MJCF_FIXTURE, 'utf8')) as { meta: Meta; designs: Record<string, MjcfLock> };
const golden = JSON.parse(readFileSync(BEHAVIOUR_FIXTURE, 'utf8')) as { meta: Meta; designs: Record<string, BehaviourTrace> };

const hint = (meta: Meta) => {
  const now = sourceFingerprint().sha256;
  return now === meta.source.sha256
    ? 'sources are byte-identical to when the fixture was written: look at MuJoCo / Node, not the code'
    : 'src/robots, src/physics or src/core changed since the fixture was written; if deliberate, run npx tsx tests/nextgen/regenerate.ts';
};

describe('nextgen lock: modern four mjcf', () => {
  for (const id of MODERN) {
    for (const corner of [0, 1] as const) {
      it(`${id} (corner ${corner}) compiles to the locked MJCF and runtime fields`, () => {
        const want = mjcf.designs[`${id}/${corner}`];
        const got = mjcfLock(id, corner);
        const msg = `${id}/${corner}: ${hint(mjcf.meta)}`;
        expect(got.length, msg).toBe(want.length);
        expect(got.sha256, msg).toBe(want.sha256);
        expect(got.totalMassKg, msg).toBe(want.totalMassKg);
        expect(got.runtimeSha256, msg).toBe(want.runtimeSha256);
      });
    }
  }
});

describe('nextgen lock: behaviour golden', () => {
  for (const id of SEVEN) {
    it(`${id} replays its fixed-seed stand / shove / jab trace exactly`, async () => {
      const want = golden.designs[id];
      expect(want, `${id}: no golden; run npx tsx tests/nextgen/regenerate.ts --behaviour ${id}`).toBeTruthy();
      const got = await behaviourTrace(id);
      const first = got.hashes.findIndex((h, i) => h !== want.hashes[i]);
      const msg = first < 0 ? '' : `${id} diverges at sample ${first} (t = ${((first + 1) * 0.05).toFixed(2)} s of the trace); final pelvis ${got.final.pelvis} vs ${want.final.pelvis}. ${hint(golden.meta)}`;
      expect(got.steps).toBe(want.steps);
      expect(first, msg).toBe(-1);
      expect(got.final).toEqual(want.final);
    }, 120_000);
  }
});
