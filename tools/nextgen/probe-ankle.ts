// Probe: is P+ak's hold failure the ankle torque or the ankle servo stiffness? P+ak with its AKE90
// ankles but P's ankle gains (kp 1200 N·m/rad, the RS04's stall / 0.1): more torque, same stiffness.
//   npx tsx tools/nextgen/probe-ankle.ts
import { hold } from './tests-kick';
import { KICKS } from './poses';
import { buildVariant } from './variants';
const v = buildVariant('PA');
const ref = buildVariant('P');
for (const p of v.design.parts) for (const j of p.joints ?? []) if (j.name.startsWith('ankle_')) {
  const r = ref.design.parts.flatMap((x) => x.joints ?? []).find((x) => x.name === j.name)!;
  j.kp = r.kp; j.kd = r.kd;
}
v.label = 'P+ak (P ankle gains)';
for (const kid of ['front', 'high_side']) {
  const k = KICKS.find((x) => x.id === kid)!;
  const rs = [];
  for (let s = 1; s <= 5; s++) rs.push(await hold(v, k, s));
  console.log(`${v.label} ${kid}: held ${rs.filter((r) => r.ok).length}/5; ${rs.map((r) => r.ok ? `lean ${r.maxLeanDeg.toFixed(0)}° support τ ${r.supportTauFrac.toFixed(2)}` : r.why).join(' | ')}`);
}
