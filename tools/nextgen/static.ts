// Phase 0 static measurements for every variant (seconds, one process):
//   npx tsx tools/nextgen/static.ts            → tools/nextgen/out/static.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { kickFits, kickPathSigma, massAndInertia, pivotFits, reachHeights } from './kinematics';
import { buildVariant, VARIANTS } from './variants';

const out: Record<string, unknown> = {};
for (const id of VARIANTS) {
  const v = buildVariant(id);
  const mi = await massAndInertia(v);
  const kicks = kickFits(v).map((k) => ({ ...k, pathSigmaMin: kickPathSigma(v, k.q) }));
  const reach = reachHeights(v);
  const pivots = pivotFits(v);
  out[id] = { label: v.label, layout: v.layout, drives: v.drives, mass: mi, kicks, reach, pivots };
  console.log(`\n== ${v.label} (${v.layout}) total ${mi.totalMassKg.toFixed(2)} kg, leg ${mi.legMassKg.toFixed(2)} kg (drives ${mi.legDriveMassKg.toFixed(2)}), foot ${mi.footMassKg.toFixed(2)} kg`);
  console.log(`   swing inertia kg·m²: hip pitch ${mi.inertia.hipPitch.toFixed(3)}, roll ${mi.inertia.hipRoll.toFixed(3)}, yaw ${mi.inertia.hipYaw.toFixed(3)}, knee ${mi.inertia.knee.toFixed(3)}; armature ${JSON.stringify(Object.fromEntries(Object.entries(mi.armature).map(([k, a]) => [k, +(a as number).toFixed(4)])))}`);
  for (const k of kicks) console.log(`   ${k.kick.padEnd(11)} fit ${k.errDeg.toFixed(1).padStart(5)}° (thigh ${k.thighErrDeg.toFixed(1)}°, knee axis ${k.kneeAxisErrDeg.toFixed(1)}°) at P ${k.angles.p} R ${k.angles.r} Y ${k.angles.y}; σmin pose ${k.sigmaMin.toFixed(2)} path ${k.pathSigmaMin.toFixed(2)}`);
  for (const [id2, r] of Object.entries(reach)) console.log(`   reach ${id2.padEnd(10)} up to ${r.elevDeg}° above level → ankle ${Number.isFinite(r.ankleHeightM) ? r.ankleHeightM.toFixed(2) : '—'} m`);
  for (const p of pivots.rows) console.log(`   pivot flex ${p.flexDeg}° turn ${p.turnDeg}°: ${p.errDeg.toFixed(1)}° using ${p.jointsUsed} (P ${p.angles.p} R ${p.angles.r} Y ${p.angles.y})`);
  console.log(`   pivot path (30° flex, 0→180°) σmin ${pivots.pathSigmaMin.toFixed(2)}`);
}
mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
writeFileSync(new URL('./out/static.json', import.meta.url), JSON.stringify(out, null, 1));
