// Per-robot decal atlas drawn on a canvas: a 2×2 grid of cells (number, label, warning, serial).
// Red channel = decal fill, green channel = outline. The kit material colours them per skin.
import * as THREE from 'three/webgpu';
import type { SkinParams } from './skins';

const SIZE = 1024;
const CELL = SIZE / 2;
const FAMILY = `'Barlow Condensed', 'Arial Narrow', 'Helvetica Neue', Impact, sans-serif`;
const MONO = `'JetBrains Mono', Menlo, monospace`;
const ROUND_GLYPHS = new Set('0689OQDBPRA'.split(''));

type Ctx = CanvasRenderingContext2D;

function font(skin: SkinParams, px: number): string {
  switch (skin.decalFont) {
    case 'racing': return `italic 800 ${px}px ${FAMILY}`;
    case 'tech': return `600 ${px}px ${MONO}`;
    default: return `800 ${px}px ${FAMILY}`;
  }
}

/** Fit text into a box and return the font size used. */
function fitText(ctx: Ctx, skin: SkinParams, text: string, maxW: number, maxH: number): number {
  let px = maxH;
  ctx.font = font(skin, px);
  const w = ctx.measureText(text).width;
  if (w > maxW) px = Math.floor((px * maxW) / w);
  ctx.font = font(skin, px);
  return px;
}

/** Stencil bridges: cut a band through the middle and bridges through closed glyphs. */
function stencilCuts(ctx: Ctx, text: string, x: number, y: number, px: number): void {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = '#000';
  const total = ctx.measureText(text).width;
  let cx = x - total / 2;
  for (const ch of text) {
    const w = ctx.measureText(ch).width;
    if (ROUND_GLYPHS.has(ch.toUpperCase())) ctx.fillRect(cx + w / 2 - px * 0.035, y - px * 0.75, px * 0.07, px * 0.8);
    cx += w;
  }
  ctx.restore();
}

/** Worn paint: erase random speckles and scuffs. */
function weather(ctx: Ctx, x: number, y: number, w: number, h: number, amount: number, rand: () => number): void {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  const count = Math.floor(amount * 900);
  for (let i = 0; i < count; i++) {
    const r = (0.5 + rand() * rand() * 7) * (w / 512);
    ctx.globalAlpha = 0.4 + rand() * 0.6;
    ctx.beginPath();
    ctx.arc(x + rand() * w, y + rand() * h, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 2;
  for (let i = 0; i < amount * 40; i++) {
    const sx = x + rand() * w;
    const sy = y + rand() * h;
    const a = rand() * Math.PI;
    const l = 20 + rand() * 120;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + Math.cos(a) * l, sy + Math.sin(a) * l * 0.2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawText(ctx: Ctx, skin: SkinParams, text: string, cx: number, cy: number, maxW: number, maxH: number): void {
  const px = fitText(ctx, skin, text, maxW, maxH);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const baseline = cy + px * 0.36;
  if (skin.decalFont === 'racing') {
    ctx.lineJoin = 'round';
    ctx.lineWidth = px * 0.14;
    ctx.strokeStyle = '#00ff00';
    ctx.strokeText(text, cx, baseline);
  }
  ctx.fillStyle = '#ff0000';
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillText(text, cx, baseline);
  ctx.globalCompositeOperation = 'source-over';
  if (skin.decalFont === 'stencil') stencilCuts(ctx, text, cx, baseline, px);
}

function drawWarning(ctx: Ctx, skin: SkinParams, x: number, y: number): void {
  // Hazard triangle + two text lines, outline in green so skins can colour the frame.
  ctx.fillStyle = '#ff0000';
  ctx.strokeStyle = '#00ff00';
  ctx.lineWidth = 14;
  ctx.strokeRect(x + 24, y + 110, CELL - 48, CELL - 220);
  const tx = x + 120;
  const ty = y + CELL / 2;
  ctx.beginPath();
  ctx.moveTo(tx, ty - 70);
  ctx.lineTo(tx + 70, ty + 55);
  ctx.lineTo(tx - 70, ty + 55);
  ctx.closePath();
  ctx.fill();
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillRect(tx - 7, ty - 30, 14, 52);
  ctx.fillRect(tx - 7, ty + 30, 14, 14);
  ctx.restore();
  ctx.textAlign = 'left';
  ctx.font = font(skin, 64);
  ctx.fillText('HIGH', x + 210, ty - 8);
  ctx.fillText('PRESSURE', x + 210, ty + 56);
}

function drawSerial(ctx: Ctx, skin: SkinParams, x: number, y: number, rand: () => number): void {
  ctx.fillStyle = '#ff0000';
  let bx = x + 40;
  while (bx < x + CELL - 40) {
    const w = 3 + Math.floor(rand() * 4) * 3;
    ctx.fillRect(bx, y + 150, w, 150);
    bx += w + 4 + Math.floor(rand() * 3) * 4;
  }
  ctx.textAlign = 'center';
  ctx.font = `600 54px ${MONO}`;
  const serial = `SD-${skin.number.replace(/[^0-9A-Z]/gi, '')}-${Math.floor(1000 + rand() * 8999)}`;
  ctx.fillText(serial, x + CELL / 2, y + 380);
}

export interface DecalAtlas {
  texture: THREE.Texture;
  redraw(): void;
  dispose(): void;
}

/** Blank atlas for headless builds (tests, tools): decals are simply absent. */
function blankAtlas(): DecalAtlas {
  const texture = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  texture.needsUpdate = true;
  return { texture, redraw: () => undefined, dispose: () => texture.dispose() };
}

/** Build the atlas for one robot. `designName` appears on the label cell. */
export function createDecalAtlas(skin: SkinParams, designName: string, seed: number): DecalAtlas {
  if (typeof document === 'undefined') return blankAtlas();
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('robot-kit: 2D canvas unavailable for the decal atlas');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.anisotropy = 8;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  const draw = () => {
    let s = seed >>> 0;
    const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    ctx.clearRect(0, 0, SIZE, SIZE);
    // Cell layout matches the shader: cell i at ((i % 2) * 0.5, floor(i / 2) * 0.5) in uv (v up).
    // Canvas y runs down, so row 0 (v 0..0.5) is the bottom half of the canvas.
    const cellXY = (i: number): [number, number] => [(i % 2) * CELL, (1 - Math.floor(i / 2)) * CELL];
    const [nx, ny] = cellXY(0);
    drawText(ctx, skin, skin.number, nx + CELL / 2, ny + CELL / 2, CELL * 0.86, CELL * 0.78);
    const [lx, ly] = cellXY(1);
    drawText(ctx, skin, skin.label, lx + CELL / 2, ly + CELL * 0.36, CELL * 0.9, CELL * 0.3);
    drawText(ctx, skin, designName.toUpperCase(), lx + CELL / 2, ly + CELL * 0.72, CELL * 0.9, CELL * 0.24);
    const [wx, wy] = cellXY(2);
    drawWarning(ctx, skin, wx, wy);
    const [sx, sy] = cellXY(3);
    drawSerial(ctx, skin, sx, sy, rand);
    const worn = skin.decalFont === 'stencil' ? 0.6 : skin.decalFont === 'racing' ? 0.12 : 0.25;
    weather(ctx, 0, 0, SIZE, SIZE, worn, rand);
    texture.needsUpdate = true;
  };
  draw();
  // Web fonts may still be loading; redraw once they are ready so decals use the real face.
  if (typeof document !== 'undefined' && 'fonts' in document) {
    document.fonts.load(font(skin, 100)).then(draw).catch(() => undefined);
  }
  return { texture, redraw: draw, dispose: () => texture.dispose() };
}
