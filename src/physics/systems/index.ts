// Physics systems in execution order. `pre` hooks run top to bottom before mj_step,
// `post` hooks run top to bottom after it.
//   intents   → applies delayed brain decisions
//   control   → balance, locomotion and skills write joint targets / feed-forward / gyro torque
//   motors    → torque-speed, heat, damage and pressure limits on every servo
//   (mj_step)
//   damage    → contacts → impacts, breaks, joint wear, smoke, leaks, KO
import type { SimSystem } from '../sim-context';
import { intentSystem } from './intents';
import { motorSystem } from './motors';
import { controlSystem } from '../control';
import { damageSystem } from '../damage';

export const SYSTEMS: readonly SimSystem[] = [intentSystem, controlSystem, motorSystem, damageSystem];
