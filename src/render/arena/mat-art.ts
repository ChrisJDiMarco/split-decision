// Painted canvas mat artwork: a hand-painted look drawn once into 2D canvases.
// Color: off-white duck canvas, a dark perimeter band, sponsor panels, red/blue corner
// wedges and the big SPLIT DECISION center emblem, then worn paint, scuffs, rubber streaks
// and resin/oil stains. Roughness: the same shapes in gray levels (paint and resin are
// glossier than raw canvas). Coordinates are physics metres (z-up, x right, y away from
// the default camera), mapped by a flipped transform so y points up on the canvas.
import * as THREE from 'three/webgpu';
import { APOTHEM, ARENA, CIRCUMRADIUS, panels, postPositions } from '../../core/arena-spec';
import { DISPLAY_FONT, makeCanvas, seededRandom } from './util';

/** Half-size of the square (in metres) the mat textures cover, centred on the cage. */
export const MAT_EXTENT_M = CIRCUMRADIUS + 0.12;

const COLOR_PX = 4096;
const ROUGH_PX = 1024;
const ART_SEED = 0x5d1e;

const RED = '#b3231b';
const BLUE = '#1d4bb3';
const INK = '#141416';
const BAND = '#1b1b1d';
const CANVAS_BASE = '#d9d3c6';

const ROUGH_CANVAS = 0.95;
const ROUGH_PAINT = 0.78;
const ROUGH_RESIN = 0.5;
const ROUGH_OIL = 0.28;
const RESIN_LAYERS = 4;

const BAND_WIDTH_M = 0.4;
const SPONSOR_RADIUS_M = APOTHEM - 1.3;
const EMBLEM_RADIUS_M = 1.3;

const SPONSORS: Array<{ text: string; style: 'mark' | 'badge'; color: string }> = [
  { text: 'TYPESAFE AI', style: 'mark', color: INK },
  { text: 'JEV', style: 'badge', color: '#d8431f' },
  { text: 'KILN FORGE', style: 'mark', color: INK },
  { text: 'HYDRAULIX', style: 'badge', color: '#0f7f78' },
];

type Mode = 'color' | 'rough';

interface Painter {
  ctx: CanvasRenderingContext2D;
  ppm: number; // pixels per metre
  mode: Mode;
}

function gray(v: number): string {
  const c = Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgb(${c},${c},${c})`;
}

function painterFor(canvas: HTMLCanvasElement, mode: Mode): Painter {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('arena: 2D canvas context unavailable');
  const ppm = canvas.width / (MAT_EXTENT_M * 2);
  ctx.setTransform(ppm, 0, 0, -ppm, MAT_EXTENT_M * ppm, MAT_EXTENT_M * ppm);
  return { ctx, ppm, mode };
}

/** Draws upright text centred at (x, y) whose "up" points along angle `upAngle` (physics radians). */
function text(p: Painter, s: string, x: number, y: number, upAngle: number, heightM: number, maxWidthM: number, fill: string, weight = 800, italic = true): void {
  const { ctx, ppm } = p;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(upAngle - Math.PI / 2);
  ctx.scale(1 / ppm, -1 / ppm);
  const px = heightM * ppm * 1.32; // cap height is ~0.76 of the font size
  ctx.font = `${italic ? 'italic ' : ''}${weight} ${px.toFixed(1)}px ${DISPLAY_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(s).width;
  const squeeze = Math.min(1, (maxWidthM * ppm) / Math.max(w, 1));
  ctx.scale(squeeze, 1);
  ctx.fillStyle = fill;
  ctx.fillText(s, 0, 0);
  ctx.restore();
}

function polygonPath(ctx: CanvasRenderingContext2D, radius: number, rotation = 0): void {
  for (let i = 0; i <= ARENA.SIDES; i++) {
    const a = ((i + 0.5) / ARENA.SIDES) * Math.PI * 2 + rotation;
    const x = Math.cos(a) * radius;
    const y = Math.sin(a) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

// ------------------------------------------------------------------ base canvas

function drawBase(p: Painter, rnd: () => number): void {
  const { ctx, mode } = p;
  ctx.fillStyle = mode === 'color' ? CANVAS_BASE : gray(ROUGH_CANVAS);
  ctx.fillRect(-MAT_EXTENT_M, -MAT_EXTENT_M, MAT_EXTENT_M * 2, MAT_EXTENT_M * 2);
  if (mode !== 'color') return;
  // Low-frequency tonal blotches: canvas is never an even white.
  for (let i = 0; i < 70; i++) {
    const x = (rnd() * 2 - 1) * MAT_EXTENT_M;
    const y = (rnd() * 2 - 1) * MAT_EXTENT_M;
    const r = 0.3 + rnd() * 1.4;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const warm = rnd() < 0.7;
    g.addColorStop(0, warm ? `rgba(140,112,70,${0.04 + rnd() * 0.05})` : `rgba(255,255,250,${0.05 + rnd() * 0.05})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

// ------------------------------------------------------------------ paint layer

function drawBand(p: Painter): void {
  const { ctx } = p;
  ctx.beginPath();
  polygonPath(ctx, MAT_EXTENT_M * 1.2);
  polygonPath(ctx, (APOTHEM - BAND_WIDTH_M) / Math.cos(Math.PI / ARENA.SIDES));
  ctx.fillStyle = p.mode === 'color' ? BAND : gray(ROUGH_PAINT);
  ctx.fill('evenodd');
  panels().forEach((pn, i) => {
    const r = APOTHEM - BAND_WIDTH_M / 2;
    const [cx, cy] = [Math.cos(pn.normalAngle) * r, Math.sin(pn.normalAngle) * r];
    const label = i % 2 === 0 ? 'SPLIT DECISION' : 'POWERED BY JEV';
    text(p, label, cx, cy, pn.normalAngle, 0.15, pn.length * 0.55, p.mode === 'color' ? 'rgba(236,232,222,0.78)' : gray(ROUGH_PAINT), 700, false);
  });
}

function drawCornerWedges(p: Painter): void {
  const posts = postPositions();
  const corners: Array<{ index: number; color: string }> = [
    { index: ARENA.SIDES / 2, color: RED },
    { index: 0, color: BLUE },
  ];
  const { ctx } = p;
  for (const c of corners) {
    const [px, py] = posts[c.index];
    const prev = posts[(c.index + ARENA.SIDES - 1) % ARENA.SIDES];
    const next = posts[(c.index + 1) % ARENA.SIDES];
    const reach = 1.05;
    const along = (to: [number, number]): [number, number] => {
      const dx = to[0] - px;
      const dy = to[1] - py;
      const l = Math.hypot(dx, dy);
      return [px + (dx / l) * reach, py + (dy / l) * reach];
    };
    const a = along(prev);
    const b = along(next);
    ctx.beginPath();
    ctx.moveTo(px * 1.02, py * 1.02);
    ctx.lineTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.closePath();
    ctx.fillStyle = p.mode === 'color' ? c.color : gray(ROUGH_PAINT);
    ctx.fill();
  }
}

function drawSponsor(p: Painter, s: (typeof SPONSORS)[number], angle: number): void {
  const { ctx } = p;
  const x = Math.cos(angle) * SPONSOR_RADIUS_M;
  const y = Math.sin(angle) * SPONSOR_RADIUS_M;
  const paint = p.mode === 'color';
  if (s.style === 'badge') {
    const w = 1.25;
    const h = 0.52;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle - Math.PI / 2);
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, 0.07);
    ctx.fillStyle = paint ? s.color : gray(ROUGH_PAINT);
    ctx.fill();
    ctx.restore();
    text(p, s.text, x, y, angle, 0.3, w * 0.8, paint ? '#f4f1ea' : gray(ROUGH_PAINT));
  } else {
    text(p, s.text, x, y, angle, 0.32, 1.7, paint ? s.color : gray(ROUGH_PAINT));
  }
}

function drawEmblem(p: Painter): void {
  const { ctx } = p;
  const paint = p.mode === 'color';
  const r = EMBLEM_RADIUS_M;
  // Outer white ring and dark keyline.
  ctx.beginPath();
  ctx.arc(0, 0, r + 0.08, 0, Math.PI * 2);
  ctx.fillStyle = paint ? '#f1eee6' : gray(ROUGH_PAINT);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = paint ? INK : gray(ROUGH_PAINT);
  ctx.fill();
  // Split disc: red corner half on -x, blue on +x, separated by a slanted gap.
  const inner = r - 0.05;
  const slant = 0.32; // x offset of the split line per metre of y
  const gap = 0.05;
  for (const side of [-1, 1] as const) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, inner, 0, Math.PI * 2);
    ctx.clip();
    ctx.beginPath();
    const off = side * gap;
    ctx.moveTo(off + slant * inner * 1.2, inner * 1.2);
    ctx.lineTo(side * inner * 1.5, inner * 1.2);
    ctx.lineTo(side * inner * 1.5, -inner * 1.2);
    ctx.lineTo(off - slant * inner * 1.2, -inner * 1.2);
    ctx.closePath();
    ctx.fillStyle = paint ? (side < 0 ? RED : BLUE) : gray(ROUGH_PAINT);
    ctx.fill();
    ctx.restore();
  }
  // Wordmark, outlined so it reads over both halves and the raw canvas beyond the disc.
  const up = Math.PI / 2;
  const outline = paint ? INK : gray(ROUGH_PAINT);
  const fill = paint ? '#f6f3ec' : gray(ROUGH_PAINT);
  for (const [dx, dy] of [[0.035, -0.035], [-0.02, 0.02], [0.02, 0.02], [-0.02, -0.02]] as const) {
    text(p, 'SPLIT', dx - 0.18, 0.3 + dy, up, 0.78, 2.1, outline, 800);
    text(p, 'DECISION', dx + 0.1, -0.48 + dy, up, 0.56, 3.3, outline, 800);
  }
  text(p, 'SPLIT', -0.18, 0.3, up, 0.78, 2.1, fill, 800);
  text(p, 'DECISION', 0.1, -0.48, up, 0.56, 3.3, fill, 800);
  text(p, 'CAGE 01  ·  JEV FIGHT SERIES', 0, -1.05, up, 0.085, 1.6, fill, 700, false);
}

function drawGuideRing(p: Painter): void {
  const { ctx } = p;
  ctx.save();
  ctx.setLineDash([0.12, 0.09]);
  ctx.lineWidth = 0.028;
  ctx.strokeStyle = p.mode === 'color' ? 'rgba(20,20,22,0.55)' : gray(ROUGH_PAINT);
  ctx.beginPath();
  ctx.arc(0, 0, 1.95, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** Paint wears off in specks and scratches, heaviest where the fighters work (the centre). */
function erodePaint(p: Painter, rnd: () => number): void {
  const { ctx } = p;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 6000; i++) {
    const r = Math.pow(rnd(), 0.8) * MAT_EXTENT_M;
    const a = rnd() * Math.PI * 2;
    const traffic = 1 - Math.min(1, r / (APOTHEM - 0.3));
    if (rnd() > 0.25 + traffic * 0.75) continue;
    const size = 0.0012 + Math.pow(rnd(), 4) * 0.012;
    ctx.globalAlpha = 0.15 + rnd() * 0.45;
    ctx.beginPath();
    ctx.ellipse(Math.cos(a) * r, Math.sin(a) * r, size, size * (0.4 + rnd() * 0.6), rnd() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.lineCap = 'round';
  for (let i = 0; i < 420; i++) {
    const r = Math.pow(rnd(), 0.7) * (APOTHEM - 0.2);
    const a = rnd() * Math.PI * 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    const len = 0.04 + rnd() * 0.35;
    const dir = rnd() * Math.PI * 2;
    ctx.globalAlpha = 0.3 + rnd() * 0.6;
    ctx.lineWidth = 0.0015 + rnd() * 0.005;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + Math.cos(dir + 0.4) * len * 0.5, y + Math.sin(dir + 0.4) * len * 0.5, x + Math.cos(dir) * len, y + Math.sin(dir) * len);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPaintLayer(p: Painter, rnd: () => number): void {
  drawBand(p);
  drawGuideRing(p);
  panels().forEach((pn, i) => {
    // Sectors facing the fighters' corners stay clean; sponsors fill the rest.
    const facesCorner = Math.abs(Math.cos(pn.normalAngle)) > 0.92;
    if (facesCorner) return;
    drawSponsor(p, SPONSORS[i % SPONSORS.length], pn.normalAngle);
  });
  drawCornerWedges(p);
  drawEmblem(p);
  erodePaint(p, rnd);
}

// ------------------------------------------------------------------ grime, stains, scuffs

function blob(ctx: CanvasRenderingContext2D, rnd: () => number, x: number, y: number, r: number): void {
  const n = 14;
  const phase = rnd() * 10;
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (0.7 + 0.3 * Math.sin(a * 3 + phase) * Math.cos(a * 2 - phase) + rnd() * 0.15);
    if (i === 0) ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    else ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
}

function drawGrime(p: Painter): void {
  if (p.mode !== 'color') return;
  const { ctx } = p;
  const g = ctx.createRadialGradient(0, 0, APOTHEM * 0.55, 0, 0, MAT_EXTENT_M);
  g.addColorStop(0, 'rgba(70,58,44,0)');
  g.addColorStop(1, 'rgba(70,58,44,0.22)');
  ctx.fillStyle = g;
  ctx.fillRect(-MAT_EXTENT_M, -MAT_EXTENT_M, MAT_EXTENT_M * 2, MAT_EXTENT_M * 2);
}

function drawStains(p: Painter, rnd: () => number): void {
  const { ctx } = p;
  const color = p.mode === 'color';
  ctx.save();
  if (color) ctx.globalCompositeOperation = 'multiply';
  for (let i = 0; i < 26; i++) {
    const r = Math.sqrt(rnd()) * (APOTHEM - 0.3);
    const a = rnd() * Math.PI * 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    const size = 0.08 + Math.pow(rnd(), 2) * 0.45;
    const alpha = 0.035 + rnd() * 0.04;
    // Stacked shrinking fills give a soft-edged, darker-centred stain.
    for (let layer = 0; layer < RESIN_LAYERS; layer++) {
      blob(ctx, seededRandom(i * 97 + 13), x, y, size * (1 - layer * 0.14));
      ctx.fillStyle = color ? `rgba(190,146,84,${alpha})` : gray(ROUGH_RESIN);
      ctx.fill();
    }
    if (color) {
      blob(ctx, seededRandom(i * 97 + 13), x, y, size);
      ctx.lineWidth = 0.004 + rnd() * 0.006;
      ctx.strokeStyle = 'rgba(140,96,48,0.12)';
      ctx.stroke();
    }
  }
  for (let i = 0; i < 8; i++) {
    const r = Math.sqrt(rnd()) * (APOTHEM - 0.6);
    const a = rnd() * Math.PI * 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    const size = 0.05 + rnd() * 0.18;
    blob(ctx, rnd, x, y, size);
    ctx.fillStyle = color ? `rgba(58,48,40,${0.45 + rnd() * 0.25})` : gray(ROUGH_OIL);
    ctx.fill();
    for (let d = 0; d < 14; d++) {
      const da = rnd() * Math.PI * 2;
      const dr = size * (1.1 + rnd() * 2.2);
      ctx.beginPath();
      ctx.arc(x + Math.cos(da) * dr, y + Math.sin(da) * dr, 0.004 + rnd() * 0.014, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawScuffs(p: Painter, rnd: () => number): void {
  const { ctx } = p;
  const color = p.mode === 'color';
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 0; i < 1900; i++) {
    const r = Math.pow(rnd(), 1.3) * (APOTHEM - 0.1);
    const a = rnd() * Math.PI * 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    const rubber = rnd() < 0.18;
    const light = !rubber && rnd() < 0.2;
    const len = rubber ? 0.2 + rnd() * 0.7 : 0.03 + rnd() * 0.3;
    const dir = rnd() * Math.PI * 2;
    const bend = (rnd() - 0.5) * 0.9;
    if (color) {
      ctx.strokeStyle = light
        ? `rgba(255,252,244,${0.05 + rnd() * 0.08})`
        : `rgba(${rubber ? '22,20,18' : '48,40,32'},${rubber ? 0.08 + rnd() * 0.16 : 0.04 + rnd() * 0.1})`;
    } else {
      ctx.strokeStyle = gray(rubber ? 0.72 : 0.95);
    }
    ctx.lineWidth = rubber ? 0.01 + rnd() * 0.035 : 0.003 + rnd() * 0.015;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(
      x + Math.cos(dir + bend) * len * 0.5, y + Math.sin(dir + bend) * len * 0.5,
      x + Math.cos(dir) * len, y + Math.sin(dir) * len,
    );
    ctx.stroke();
  }
  ctx.restore();
}

// ------------------------------------------------------------------ assembly

function paintInto(target: HTMLCanvasElement, layer: HTMLCanvasElement, mode: Mode): void {
  const main = painterFor(target, mode);
  const paint = painterFor(layer, mode);
  paint.ctx.save();
  paint.ctx.setTransform(1, 0, 0, 1, 0, 0);
  paint.ctx.clearRect(0, 0, layer.width, layer.height);
  paint.ctx.restore();

  drawBase(main, seededRandom(ART_SEED));
  drawPaintLayer(paint, seededRandom(ART_SEED + 1));
  main.ctx.save();
  main.ctx.setTransform(1, 0, 0, 1, 0, 0);
  main.ctx.drawImage(layer, 0, 0, target.width, target.height);
  main.ctx.restore();
  drawGrime(main);
  drawStains(main, seededRandom(ART_SEED + 2));
  drawScuffs(main, seededRandom(ART_SEED + 3));
}

export interface MatTextures {
  color: THREE.CanvasTexture;
  roughness: THREE.CanvasTexture;
  /** Re-paints both textures (call once the display font has loaded). */
  redraw(): void;
}

export function createMatTextures(): MatTextures {
  const colorCanvas = makeCanvas(COLOR_PX, COLOR_PX);
  const roughCanvas = makeCanvas(ROUGH_PX, ROUGH_PX);
  if (!colorCanvas || !roughCanvas) throw new Error('arena: mat art needs a DOM canvas');

  const color = new THREE.CanvasTexture(colorCanvas);
  color.colorSpace = THREE.SRGBColorSpace;
  const roughness = new THREE.CanvasTexture(roughCanvas);
  roughness.colorSpace = THREE.NoColorSpace;

  // The paint layers are scratch space: made per redraw so a 4096² canvas (64 MB) is not
  // kept alive for the page's lifetime.
  const redraw = () => {
    const colorLayer = makeCanvas(COLOR_PX, COLOR_PX);
    const roughLayer = makeCanvas(ROUGH_PX, ROUGH_PX);
    if (!colorLayer || !roughLayer) throw new Error('arena: mat art needs a DOM canvas');
    paintInto(colorCanvas, colorLayer, 'color');
    paintInto(roughCanvas, roughLayer, 'rough');
    color.needsUpdate = true;
    roughness.needsUpdate = true;
  };
  redraw();
  return { color, roughness, redraw };
}
