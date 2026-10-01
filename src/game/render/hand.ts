/**
 * Рука мальчика, держащая сақа (вид сверху, правая рука ладонью вниз).
 *
 * Локальные координаты: (0, 0) — центр сақа в руке, «вперёд» — это −Y.
 * Рисуется векторно, поэтому одинаково чётко выглядит на любом экране.
 */

const SKIN = {
  light: '#f3c7a0',
  base: '#e0a67a',
  shade: '#c0845a',
  outline: 'rgba(105, 58, 28, 0.55)',
  crease: 'rgba(120, 66, 34, 0.35)',
};

interface Finger {
  x: number;
  w: number;
  /** y основания (у костяшек) */
  base: number;
  /** y кончика в покое */
  tip: number;
}

const FINGERS: Finger[] = [
  { x: -21, w: 19, base: 52, tip: 5 }, // указательный
  { x: -2, w: 20, base: 50, tip: 1 }, // средний
  { x: 17, w: 18, base: 52, tip: 11 }, // безымянный
  { x: 33, w: 15, base: 56, tip: 25 }, // мизинец
];

function capsule(x: number, y1: number, y2: number, w: number): Path2D {
  const p = new Path2D();
  const r = w / 2;
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);
  p.moveTo(x - r, bottom);
  p.lineTo(x - r, top + r);
  p.arc(x, top + r, r, Math.PI, 0);
  p.lineTo(x + r, bottom);
  p.closePath();
  return p;
}

function forearmPath(): Path2D {
  const p = new Path2D();
  p.moveTo(-31, 112);
  p.bezierCurveTo(-36, 260, -48, 600, -58, 1400);
  p.lineTo(62, 1400);
  p.bezierCurveTo(52, 600, 40, 260, 35, 112);
  p.closePath();
  return p;
}

function dorsumPath(): Path2D {
  const p = new Path2D();
  p.moveTo(-32, 118);
  p.bezierCurveTo(-44, 104, -50, 82, -46, 62);
  p.bezierCurveTo(-42, 46, -30, 38, -12, 38);
  p.lineTo(26, 38);
  p.bezierCurveTo(40, 40, 46, 50, 45, 66);
  p.bezierCurveTo(44, 88, 42, 104, 36, 118);
  p.closePath();
  return p;
}

function thumbPath(open: number): Path2D {
  // большой палец идёт вдоль левого края сақа и прижимает его
  const spread = open * 7;
  const p = new Path2D();
  p.moveTo(-50, 86);
  p.bezierCurveTo(-54, 56, -40 - spread, 20, -30 - spread, -2);
  p.bezierCurveTo(-26 - spread, -12, -14 - spread, -12, -12 - spread, -2);
  p.bezierCurveTo(-14 - spread, 18, -22, 44, -24, 72);
  p.closePath();
  return p;
}

export interface HandPose {
  /** Раскрытие пальцев при выпуске 0…1. */
  open: number;
}

function fingerPaths(open: number): Path2D[] {
  return FINGERS.map((f, i) => capsule(f.x + (i - 1.5) * open * 2.2, f.base, f.tip - open * 12, f.w));
}

/** Тень руки на земле (рисуется до самой руки, со смещением от солнца). */
export function drawHandShadow(ctx: CanvasRenderingContext2D, pose: HandPose): void {
  ctx.save();
  ctx.fillStyle = 'rgba(25, 18, 8, 0.2)';
  ctx.fill(forearmPath());
  ctx.fill(dorsumPath());
  for (const f of fingerPaths(pose.open)) ctx.fill(f);
  ctx.fill(thumbPath(pose.open));
  ctx.restore();
}

function skinFill(ctx: CanvasRenderingContext2D, x0: number, x1: number): CanvasGradient {
  const g = ctx.createLinearGradient(x0, 0, x1, 0);
  g.addColorStop(0, SKIN.shade);
  g.addColorStop(0.35, SKIN.light);
  g.addColorStop(0.7, SKIN.base);
  g.addColorStop(1, SKIN.shade);
  return g;
}

/** Предплечье, браслет и тыльная сторона ладони (под сақа). */
export function drawHandBack(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.lineJoin = 'round';

  const arm = forearmPath();
  ctx.fillStyle = skinFill(ctx, -50, 55);
  ctx.fill(arm);
  ctx.strokeStyle = SKIN.outline;
  ctx.lineWidth = 2;
  ctx.stroke(arm);

  // браслет-плетёнка с бусиной цвета неба
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(-36, 116, 74, 14, 7);
  ctx.fillStyle = '#c8372d';
  ctx.fill();
  ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 2.2;
  for (let x = -40; x < 44; x += 9) {
    ctx.beginPath();
    ctx.moveTo(x, 132);
    ctx.lineTo(x + 8, 114);
    ctx.stroke();
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(2, 123, 6.5, 0, Math.PI * 2);
  ctx.fillStyle = '#1fa9c9';
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath();
  ctx.arc(0, 121, 2, 0, Math.PI * 2);
  ctx.fill();

  const back = dorsumPath();
  ctx.fillStyle = skinFill(ctx, -48, 46);
  ctx.fill(back);
  ctx.strokeStyle = SKIN.outline;
  ctx.lineWidth = 2;
  ctx.stroke(back);

  // сухожилия/объём тыльной стороны
  ctx.strokeStyle = 'rgba(255, 230, 205, 0.45)';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (const x of [-18, -2, 14]) {
    ctx.beginPath();
    ctx.moveTo(x * 0.6, 108);
    ctx.quadraticCurveTo(x, 80, x, 56);
    ctx.stroke();
  }
  ctx.restore();
}

/** Пальцы поверх сақа (рисуются ПОСЛЕ сақа, чтобы «обхватывать» его). */
export function drawHandFingers(ctx: CanvasRenderingContext2D, pose: HandPose): void {
  ctx.save();
  ctx.lineJoin = 'round';
  const paths = fingerPaths(pose.open);
  // от мизинца к указательному — указательный сверху
  for (let i = paths.length - 1; i >= 0; i--) {
    const f = FINGERS[i];
    const p = paths[i];
    ctx.fillStyle = skinFill(ctx, f.x - f.w / 2, f.x + f.w / 2);
    ctx.fill(p);
    ctx.strokeStyle = SKIN.outline;
    ctx.lineWidth = 1.8;
    ctx.stroke(p);
    // складки суставов
    ctx.strokeStyle = SKIN.crease;
    ctx.lineWidth = 1.4;
    const tip = f.tip - pose.open * 12;
    for (const t of [0.45, 0.72]) {
      const y = tip + (f.base - tip) * t;
      ctx.beginPath();
      ctx.moveTo(f.x - f.w * 0.28, y);
      ctx.quadraticCurveTo(f.x, y + 2.5, f.x + f.w * 0.28, y);
      ctx.stroke();
    }
  }
  // костяшки
  ctx.fillStyle = 'rgba(255, 235, 215, 0.35)';
  for (const f of FINGERS) {
    ctx.beginPath();
    ctx.ellipse(f.x, f.base - 2, f.w * 0.32, 4, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  const thumb = thumbPath(pose.open);
  ctx.fillStyle = skinFill(ctx, -52, -12);
  ctx.fill(thumb);
  ctx.strokeStyle = SKIN.outline;
  ctx.lineWidth = 1.8;
  ctx.stroke(thumb);
  // ноготь большого пальца
  const s = pose.open * 7;
  ctx.beginPath();
  ctx.ellipse(-21 - s, 2, 6, 8, 0.25, 0, Math.PI * 2);
  ctx.fillStyle = '#f6d2bd';
  ctx.fill();
  ctx.strokeStyle = 'rgba(150, 90, 60, 0.45)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}
