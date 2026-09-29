// Physics systems in execution order. `pre` hooks run top to bottom before mj_step,
// `post` hooks run top to bottom after it.
//   intents   → applies delayed brain decisions
//   control   → balance, locomotion and skills write joint targets / feed-forward / gyro torque
//   gaze      → head tracking: overwrites only the neck targets (track, threat, aim, down, scan)
//   hands     → grip drive of dexterous hands (fist, grab, spread, relaxed); no-op for stock fists
//   motors    → torque-speed, heat, damage and pressure limits on every servo
//   (mj_step)
//   damage    → contacts → impacts, breaks, joint wear, smoke, leaks, KO
//   openings  → hard-hit memory; at telemetry time openings, moveRisk, stance, facing
import type { SimSystem } from '../sim-context';
import { intentSystem } from './intents';
import { motorSystem } from './motors';
import { controlSystem } from '../control';
import { gazeSystem } from './gaze';
import { handsSystem } from './hands';
import { damageSystem } from '../damage';
import { openingsSystem } from '../openings';

export const SYSTEMS: readonly SimSystem[] = [intentSystem, controlSystem, gazeSystem, handsSystem, motorSystem, damageSystem, openingsSystem];
