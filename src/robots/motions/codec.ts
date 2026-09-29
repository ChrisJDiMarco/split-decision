// Compact channel encoding for the library JSON: little-endian int16 / uint8 in base64.
// Hand-rolled base64 so the same code runs in Node, the browser and the physics worker.
import type { Quat } from '../../core/types';
import { QUANT } from './types';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Uint8Array(128).fill(255);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += `${ALPHABET[n >> 18]}${ALPHABET[(n >> 12) & 63]}==`;
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += `${ALPHABET[n >> 18]}${ALPHABET[(n >> 12) & 63]}${ALPHABET[(n >> 6) & 63]}=`;
  }
  return out;
}

export function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0, buf = 0, bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = LOOKUP[clean.charCodeAt(i)];
    if (v === 255 || v === undefined) throw new Error(`invalid base64 at ${i}`);
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 255;
    }
  }
  return out;
}

function int16Bytes(values: ArrayLike<number>, step: number): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  for (let i = 0; i < values.length; i++) {
    const v = Math.max(-32767, Math.min(32767, Math.round(values[i] / step)));
    out[i * 2] = v & 255;
    out[i * 2 + 1] = (v >> 8) & 255;
  }
  return out;
}

function bytesInt16(bytes: Uint8Array, step: number): Float32Array {
  const out = new Float32Array(bytes.length >> 1);
  for (let i = 0; i < out.length; i++) {
    let v = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
    if (v >= 32768) v -= 65536;
    out[i] = v * step;
  }
  return out;
}

export const encodeAngles = (q: ArrayLike<number>): string => bytesToBase64(int16Bytes(q, QUANT.angle));
export const decodeAngles = (s: string): Float32Array => bytesInt16(base64ToBytes(s), QUANT.angle);

/** Root channels: frames × 7 (x, y, z, qw, qx, qy, qz); position and quaternion quantize separately. */
export function encodeRoot(root: ArrayLike<number>): string {
  const n = root.length / 7;
  const bytes = new Uint8Array(root.length * 2);
  for (let f = 0; f < n; f++) {
    for (let c = 0; c < 7; c++) {
      const step = c < 3 ? QUANT.pos : QUANT.quat;
      const v = Math.max(-32767, Math.min(32767, Math.round(root[f * 7 + c] / step)));
      const o = (f * 7 + c) * 2;
      bytes[o] = v & 255;
      bytes[o + 1] = (v >> 8) & 255;
    }
  }
  return bytesToBase64(bytes);
}

export function decodeRoot(s: string): Float32Array {
  const bytes = base64ToBytes(s);
  const out = new Float32Array(bytes.length >> 1);
  for (let i = 0; i < out.length; i++) {
    let v = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
    if (v >= 32768) v -= 65536;
    out[i] = v * (i % 7 < 3 ? QUANT.pos : QUANT.quat);
  }
  // Re-normalize quaternions after quantization.
  for (let f = 0; f < out.length / 7; f++) {
    const o = f * 7 + 3;
    const q: Quat = [out[o], out[o + 1], out[o + 2], out[o + 3]];
    const nq = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    for (let k = 0; k < 4; k++) out[o + k] = q[k] / nq;
  }
  return out;
}

export const encodeBytes = (b: ArrayLike<number>): string => bytesToBase64(Uint8Array.from(b));
export const decodeBytes = (s: string): Uint8Array => base64ToBytes(s);
