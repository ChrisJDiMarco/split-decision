// Loosely typed TSL surface for the kit's procedural shader graphs. The r184 TSL typings reject
// ordinary graphs (nested select unions, color vs vec3, missing dFdx), so graph code goes
// through this one module, the same way the physics side treats the MuJoCo bindings.
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as TSL from 'three/tsl';

export type Nd = any;
type TslFn = (...args: any[]) => Nd;

const T = TSL as unknown as Record<string, TslFn & Nd>;

export const abs: TslFn = T.abs;
export const attribute: TslFn = T.attribute;
export const clamp: TslFn = T.clamp;
export const color: TslFn = T.color;
export const float: TslFn = T.float;
export const floor: TslFn = T.floor;
export const fract: TslFn = T.fract;
export const length: TslFn = T.length;
export const max: TslFn = T.max;
export const min: TslFn = T.min;
export const mix: TslFn = T.mix;
export const mod: TslFn = T.mod;
export const mx_fractal_noise_float: TslFn = T.mx_fractal_noise_float;
export const mx_noise_float: TslFn = T.mx_noise_float;
export const select: TslFn = T.select;
export const sin: TslFn = T.sin;
export const smoothstep: TslFn = T.smoothstep;
export const step: TslFn = T.step;
export const texture: TslFn = T.texture;
export const uniform: TslFn = T.uniform;
export const vec2: TslFn = T.vec2;
export const vec3: TslFn = T.vec3;
export const vec4: TslFn = T.vec4;

export const positionLocal: Nd = T.positionLocal;
export const positionWorld: Nd = T.positionWorld;
export const normalLocal: Nd = T.normalLocal;
export const positionView: Nd = T.positionView;
export const normalView: Nd = T.normalView;
export const faceDirection: Nd = T.faceDirection;
export const time: Nd = T.time;
