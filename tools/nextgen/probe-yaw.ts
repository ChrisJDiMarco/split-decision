// Probe: P's support-hip saturations sit on hip yaw (AKE90, 170 N·m). P with a twin-AKE90 hip yaw
// (323 N·m, gains by the builder rule; its extra 1.5 kg is NOT added, so this isolates torque).
//   npx tsx tools/nextgen/probe-yaw.ts
import { MOTORS } from '../../src/robots/catalog';
import { hold } from './tests-kick';
import { KICKS } from './poses';
import { buildVariant } from './variants';
const v = buildVariant('P');
MOTORS['ng0.qdd.ake90x2'] ??= { ...MOTORS['qdd.ake90x2'], id: 'ng0.qdd.ake90x2', massKg: 0 };
for (const p of v.design.parts) for (const j of p.joints ?? []) if (j.name.startsWith('hip_yaw_')) {
  j.motor = 'ng0.qdd.ake90x2';
  j.kp = MOTORS['qdd.ake90x2'].stallTorqueNm / 0.07; j.kd = j.kp * 0.045; j.frictionloss = MOTORS['qdd.ake90x2'].stallTorqueNm * 0.004;
}
v.label = 'P (yaw ake90x2)';
for (const kid of ['front', 'side', 'high_side']) {
  const k = KICKS.find((x) => x.id === kid)!;
  const rs = [];
  for (let s = 1; s <= 5; s++) rs.push(await hold(v, k, s));
  console.log(`${v.label} ${kid}: held ${rs.filter((r) => r.ok).length}/5; ${rs.map((r) => r.ok ? `lean ${r.maxLeanDeg.toFixed(0)}° τ ${r.supportTauFrac.toFixed(2)}` : r.why).join(' | ')}`);
}
