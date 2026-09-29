import { compileRobot } from '../src/robots/compile-mjcf';
import { DESIGNS } from '../src/robots/designs';
for (const d of Object.values(DESIGNS)) {
  const r = compileRobot(d, 0, { pos: [0, 0, 1], yaw: 0 });
  console.log(d.id, r.totalMassKg.toFixed(0), 'kg:', r.parts.map((p) => `${p.id}=${p.massKg.toFixed(0)}`).join(' '));
}
