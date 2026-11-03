/**
 * Рука мальчика, держащая сақа (вид сверху, правая рука ладонью вниз).
 *
 * Плоский рисунок с ровным контуром, без теней и прожилок. Кисть собрана: четыре пальца лежат на сақа,
 * большой прижимает его слева. Чтобы кисть читалась как рука, а не стопа: пальцы длинные и разной длины
 * (средний длиннее всех, мизинец короче и растёт ниже), большой палец отделён промежутком, запястье уже
 * ладони и сразу уходит в рукав чапана с каймой цвета игрока.
 *
 * Локальные координаты: (0, 0) — центр сақа в руке, «вперёд» — это −Y. Рисуется векторно, поэтому
 * одинаково чётко выглядит на любом экране.
 */

const SKIN = { fill: '#f3c8a4', line: '#b07450' };
const SLEEVE = { cloth: '#2c4f7c', line: '#1b3150', trim: '#e3b341', ornament: 'rgba(255, 230, 160, 0.95)' };
const LINE_W = 2.2;

type Pt = readonly [number, number];

export interface HandPose {
  /** Раскрытие пальцев при выпуске 0…1. */
  open: number;
}

/**
 * Палец: осевая линия — квадратичная кривая [основание, изгиб, кончик] в позе «держит» и «отпустил»,
 * толщина у основания и у кончика.
 */
interface Finger {
  closed: [Pt, Pt, Pt];
  open: [Pt, Pt, Pt];
  w: [number, number];
}

/** От указательного к мизинцу; при выпуске кончики уходят вперёд и чуть расходятся. */
const FINGERS: Finger[] = [
  { closed: [[-16, 46], [-15, 24], [-13, 2]], open: [[-16, 46], [-18, 18], [-20, -12]], w: [14, 12] },
  { closed: [[-1, 43], [-1, 18], [-1, -6]], open: [[-1, 43], [-1, 12], [-1, -20]], w: [14.5, 12.5] },
  { closed: [[14, 46], [14, 25], [12, 4]], open: [[14, 46], [16, 19], [18, -10]], w: [13.5, 11.5] },
  { closed: [[27, 53], [26, 38], [23, 22]], open: [[27, 53], [30, 34], [32, 10]], w: [11.5, 10] },
];

/** Большой палец прижимает сақа слева; при выпуске отходит в сторону. */
const THUMB: Finger = { closed: [[-24, 102], [-38, 66], [-26, 20]], open: [[-24, 102], [-44, 68], [-38, 22]], w: [18, 14] };

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpPt = (a: Pt, b: Pt, t: number): Pt => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];

/** Плавная линия через точки (концы точно, середины — сглаженно). */
function smoothTo(p: Path2D, pts: Pt[]): void {
  for (let i = 1; i < pts.length - 1; i++) {
    p.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
  }
  const last = pts[pts.length - 1];
  p.lineTo(last[0], last[1]);
}

/**
 * Контур пальца: `fill` — замкнутый (для заливки и тени), `edge` — без основания: обводка не даёт шва
 * там, где палец растёт из кисти.
 */
function fingerPaths(f: Finger, open: number): { fill: Path2D; edge: Path2D } {
  const [a, c, b] = [0, 1, 2].map((i) => lerpPt(f.closed[i], f.open[i], open));
  const N = 7;
  const pts: Pt[] = [];
  const w: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const u = 1 - t;
    pts.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
    w.push(lerp(f.w[0], f.w[1], t));
  }
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i < N; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[Math.min(N - 1, i + 1)];
    const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
    const dx = (p1[0] - p0[0]) / len;
    const dy = (p1[1] - p0[1]) / len;
    const h = w[i] / 2;
    left.push([pts[i][0] + dy * h, pts[i][1] - dx * h]);
    right.push([pts[i][0] - dy * h, pts[i][1] + dx * h]);
  }
  const tip = pts[N - 1];
  const before = pts[N - 2];
  const dir = Math.atan2(tip[1] - before[1], tip[0] - before[0]);
  const build = (closed: boolean) => {
    const p = new Path2D();
    if (closed) {
      p.moveTo(right[0][0], right[0][1]);
      p.lineTo(left[0][0], left[0][1]);
    } else {
      p.moveTo(left[0][0], left[0][1]);
    }
    smoothTo(p, left);
    p.arc(tip[0], tip[1], w[N - 1] / 2, dir - Math.PI / 2, dir + Math.PI / 2);
    smoothTo(p, [...right].reverse());
    if (closed) p.closePath();
    return p;
  };
  return { fill: build(true), edge: build(false) };
}

/** Тыльная сторона кисти: от запястья к костяшкам (верхний край закрыт основаниями пальцев). */
function dorsumPath(): Path2D {
  const p = new Path2D();
  p.moveTo(-19, 114);
  p.bezierCurveTo(-24, 96, -26, 78, -24, 62);
  p.bezierCurveTo(-23, 52, -21, 46, -17, 41);
  p.quadraticCurveTo(-2, 34, 15, 40);
  p.quadraticCurveTo(28, 44, 33, 54);
  p.bezierCurveTo(37, 72, 35, 96, 31, 114);
  p.closePath();
  return p;
}

/** Рукав чапана от запястья и дальше за край экрана (виден, когда рука повёрнута вбок). */
function sleevePath(): Path2D {
  const p = new Path2D();
  p.moveTo(-25, 106);
  p.quadraticCurveTo(6, 96, 37, 106);
  p.bezierCurveTo(48, 400, 60, 900, 72, 1400);
  p.lineTo(-62, 1400);
  p.bezierCurveTo(-50, 900, -38, 400, -25, 106);
  p.closePath();
  return p;
}

/** Тень руки на земле (рисуется до самой руки, со смещением от солнца). */
export function drawHandShadow(ctx: CanvasRenderingContext2D, pose: HandPose): void {
  ctx.save();
  ctx.fillStyle = 'rgba(25, 18, 8, 0.2)';
  ctx.fill(sleevePath());
  ctx.fill(dorsumPath());
  for (const f of [...FINGERS, THUMB]) ctx.fill(fingerPaths(f, pose.open).fill);
  ctx.restore();
}

/** Кисть и рукав с каймой цвета игрока (под сақа). */
export function drawHandBack(ctx: CanvasRenderingContext2D, playerColor = '#c8372d'): void {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const back = dorsumPath();
  ctx.fillStyle = SKIN.fill;
  ctx.fill(back);
  ctx.strokeStyle = SKIN.line;
  ctx.lineWidth = LINE_W;
  ctx.stroke(back);

  const sleeve = sleevePath();
  ctx.save();
  ctx.fillStyle = SLEEVE.cloth;
  ctx.fill(sleeve);
  ctx.clip(sleeve);
  // кайма цвета игрока с узором «уголками» и золотая тесьма под ней
  ctx.fillStyle = playerColor;
  ctx.fillRect(-60, 90, 150, 24);
  ctx.strokeStyle = SLEEVE.ornament;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = -60; x < 90; x += 12) {
    ctx.moveTo(x, 108);
    ctx.lineTo(x + 6, 100);
    ctx.lineTo(x + 12, 108);
  }
  ctx.stroke();
  ctx.fillStyle = SLEEVE.trim;
  ctx.fillRect(-60, 114, 150, 4);
  ctx.restore();
  ctx.strokeStyle = SLEEVE.line;
  ctx.lineWidth = LINE_W;
  ctx.stroke(sleeve);
  ctx.restore();
}

/**
 * Пальцы поверх сақа (рисуются ПОСЛЕ сақа, чтобы держать его): от мизинца к указательному, у каждого
 * свой контур — собранная кисть не сливается в «варежку». Большой палец — последним.
 */
export function drawHandFingers(ctx: CanvasRenderingContext2D, pose: HandPose): void {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = SKIN.line;
  ctx.lineWidth = LINE_W;
  ctx.fillStyle = SKIN.fill;
  for (const f of [...[...FINGERS].reverse(), THUMB]) {
    const { fill, edge } = fingerPaths(f, pose.open);
    ctx.fill(fill);
    ctx.stroke(edge);
  }
  ctx.restore();
}
