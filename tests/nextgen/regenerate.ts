// Writes the NEXT GEN regression-lock fixtures. Run it ONLY for a deliberate change to one of the
// seven existing fighters (an approved actuator swap, a control change that is meant to move them),
// never to make a NEXT GEN edit pass. Say in the commit which change moved which fixture.
//
//   npx tsx tests/nextgen/regenerate.ts --check        # recompute and diff, write nothing
//   npx tsx tests/nextgen/regenerate.ts --mjcf         # rewrite fixtures/modern-mjcf.json
//   npx tsx tests/nextgen/regenerate.ts --behaviour    # rewrite fixtures/behaviour-golden.json
//   npx tsx tests/nextgen/regenerate.ts --mjcf --behaviour [designs]
//
// To lock the COMMITTED seven while other builds have uncommitted edits in src/, run it in a clean
// export of HEAD and copy the fixtures back (this is how the first fixtures were written):
//   git archive HEAD src tests/control | tar -x -C $TMP && cp -r tests/nextgen $TMP/tests/ &&
//   ln -s $PWD/node_modules $TMP/node_modules && (cd $TMP && NEXTGEN_GIT_HEAD=$(git -C $OLDPWD rev-parse --short HEAD) \
//   npx tsx tests/nextgen/regenerate.ts --mjcf --behaviour) && cp $TMP/tests/nextgen/fixtures/*.json tests/nextgen/fixtures/
//
// The behaviour run first replays each trace twice and refuses to write if the two disagree (the
// golden needs a deterministic sim on this machine).
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { BEHAVIOUR_FIXTURE, behaviourTrace, MJCF_FIXTURE, MODERN, mjcfLock, SEVEN, sourceFingerprint, type BehaviourTrace, type MjcfLock } from './lock-lib';

const args = process.argv.slice(2);
const check = args.includes('--check');
const doMjcf = check || args.includes('--mjcf');
const doBehaviour = check || args.includes('--behaviour');
const only = args.find((a) => !a.startsWith('--'))?.split(',');
if (!doMjcf && !doBehaviour) {
  console.log('usage: npx tsx tests/nextgen/regenerate.ts [--check] [--mjcf] [--behaviour] [design,design]');
  process.exit(1);
}

const gitHead = process.env.NEXTGEN_GIT_HEAD ?? (() => { try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'unknown'; } })();
const meta = () => ({ writtenAt: new Date().toISOString(), gitHead, source: sourceFingerprint() });
const read = <T>(p: string): T | null => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as T : null);

if (doMjcf) {
  const old = read<{ designs: Record<string, MjcfLock> }>(MJCF_FIXTURE);
  const designs: Record<string, MjcfLock> = {};
  for (const id of MODERN) for (const corner of [0, 1] as const) designs[`${id}/${corner}`] = mjcfLock(id, corner);
  for (const [k, v] of Object.entries(designs)) {
    const o = old?.designs[k];
    const same = o && o.sha256 === v.sha256 && o.runtimeSha256 === v.runtimeSha256 && o.totalMassKg === v.totalMassKg;
    console.log(`mjcf ${k.padEnd(14)} ${v.sha256.slice(0, 12)} ${v.totalMassKg.toFixed(3)} kg ${o ? (same ? 'unchanged' : 'CHANGED') : 'new'}`);
  }
  if (!check) {
    writeFileSync(MJCF_FIXTURE, `${JSON.stringify({ meta: meta(), designs }, null, 2)}\n`);
    console.log(`wrote ${MJCF_FIXTURE}`);
  }
}

if (doBehaviour) {
  const old = read<{ designs: Record<string, BehaviourTrace> }>(BEHAVIOUR_FIXTURE);
  const designs: Record<string, BehaviourTrace> = { ...(old?.designs ?? {}) };
  for (const id of only ?? SEVEN) {
    const t0 = Date.now();
    const a = await behaviourTrace(id);
    const b = await behaviourTrace(id);
    const firstDiff = a.hashes.findIndex((h, i) => h !== b.hashes[i]);
    if (firstDiff >= 0 || a.steps !== b.steps) {
      console.error(`${id}: NOT DETERMINISTIC run to run (first differing sample ${firstDiff}); refusing to write a golden`);
      process.exit(2);
    }
    const o = old?.designs[id];
    const diff = o ? a.hashes.findIndex((h, i) => h !== o.hashes[i]) : -2;
    console.log(`behaviour ${id.padEnd(12)} ${a.steps} steps, ${a.hashes.length} hashes, fell ${a.final.fell}, jab thrown ${a.final.thrown} landed ${a.final.landed}, ${((Date.now() - t0) / 1000).toFixed(1)} s, ${diff === -2 ? 'new' : diff < 0 ? 'unchanged' : `CHANGED from sample ${diff} (t = ${((diff + 1) * 0.05).toFixed(2)} s)`}`);
    designs[id] = a;
  }
  if (!check) {
    writeFileSync(BEHAVIOUR_FIXTURE, `${JSON.stringify({ meta: meta(), designs }, null, 1)}\n`);
    console.log(`wrote ${BEHAVIOUR_FIXTURE}`);
  }
}
