// Compatibility hash of a design's polish (move-polish.md §6): everything the stored rollouts depended
// on that the runtime can see. A polish whose hash differs from the one computed here was optimised on
// another robot, another motor table or other physics, and must not play (the move plays raw).
// The source hashes of motors.ts, gyro.ts and the player are checked offline (tests/polish), since a
// browser cannot read source files.
import { motor } from '../../catalog';
import { compileRobot } from '../../compile-mjcf';
import { design } from '../../designs';
import { PLAYER_VERSION, hashString } from './format';

/**
 * The physics option block and canvas of the game world (src/physics/world.ts), verbatim. A test
 * asserts compileWorld() still contains both strings, so they cannot drift apart silently.
 */
export const PHYSICS_OPTION = '<option timestep="0.001" integrator="implicitfast" cone="elliptic" solver="Newton" iterations="30" ls_iterations="10">';
export const CANVAS_CONTACT = 'friction="0.9 0.005 0.0001" solref="0.004 1"';

/** The compiled robot as the polish rollouts saw it (corner 0, canonical spawn). */
export function polishRobot(designId: string) {
  const d = design(designId);
  return compileRobot(d, 0, { pos: [0, 0, d.rootHeight + 0.02], yaw: 0 });
}

export function compatHash(designId: string): string {
  const d = design(designId);
  const r = polishRobot(designId);
  const motors = r.joints.map((j) => JSON.stringify({ j: j.name, kp: j.kp, kd: j.kd, m: motor(j.motor) }));
  return hashString([
    r.bodyXml, r.actuatorXml, r.equalityXml, r.debrisXml,
    motors.join('\n'),
    JSON.stringify(d.gyro ?? null),
    PHYSICS_OPTION, CANVAS_CONTACT, PLAYER_VERSION,
  ].join('\n'));
}
