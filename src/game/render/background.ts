import { CURB, THROW_LINE_Y, THROW_ORIGIN, WORLD_H, WORLD_W } from '../config';
import type { Obstacle, Zone } from '../types';

/** Детерминированный генератор случайных чисел — фон одинаков при каждой перерисовке. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface VisibleRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Меловая линия: несколько «проходов» с дрожанием + крошки мела. */
function chalkStroke(ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[], rnd: () => number, width = 5, alpha = 1) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let pass = 0; pass < 3; pass++) {
    ctx.strokeStyle = `rgba(252, 250, 244, ${(0.34 + pass * 0.12) * alpha})`;
    ctx.lineWidth = width * (1.25 - pass * 0.25);
    ctx.beginPath();
    pts.forEach((p, i) => {
      const jx = (rnd() - 0.5) * 2.4;
      const jy = (rnd() - 0.5) * 2.4;
      if (i === 0) ctx.moveTo(p.x + jx, p.y + jy);
      else ctx.lineTo(p.x + jx, p.y + jy);
    });
    ctx.stroke();
  }
  // крошки
  ctx.fillStyle = `rgba(252, 250, 244, ${0.5 * alpha})`;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    for (let k = 0; k < len / 9; k++) {
      const t = rnd();
      ctx.fillRect(a.x + (b.x - a.x) * t + (rnd() - 0.5) * width * 2.2, a.y + (b.y - a.y) * t + (rnd() - 0.5) * width * 2.2, 1.6, 1.6);
    }
  }
  ctx.restore();
}

function linePts(x0: number, y0: number, x1: number, y1: number, step = 24) {
  const n = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
  return Array.from({ length: n + 1 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n }));
}

export function drawZone(ctx: CanvasRenderingContext2D, zone: Zone, rnd: () => number): void {
  // лёгкая подсветка площади кона
  ctx.save();
  ctx.fillStyle = 'rgba(255, 248, 225, 0.06)';
  if (zone.kind === 'rect') {
    ctx.fillRect(zone.x, zone.y, zone.w, zone.h);
    const { x, y, w, h } = zone;
    chalkStroke(ctx, [...linePts(x, y, x + w, y), ...linePts(x + w, y, x + w, y + h).slice(1), ...linePts(x + w, y + h, x, y + h).slice(1), ...linePts(x, y + h, x, y).slice(1)], rnd, 5);
  } else {
    ctx.beginPath();
    ctx.arc(zone.cx, zone.cy, zone.r, 0, Math.PI * 2);
    ctx.fill();
    const n = 72;
    chalkStroke(
      ctx,
      Array.from({ length: n + 1 }, (_, i) => {
        const a = (i / n) * Math.PI * 2;
        return { x: zone.cx + Math.cos(a) * zone.r, y: zone.cy + Math.sin(a) * zone.r };
      }),
      rnd,
      5,
    );
  }
  // подпись «КОН» мелом
  // подпись снаружи линии, чтобы не лежать под асыками
  const lx = zone.kind === 'rect' ? zone.x + 8 : zone.cx - 34;
  const ly = zone.kind === 'rect' ? zone.y - 12 : zone.cy - zone.r - 14;
  ctx.font = '700 22px Unbounded Variable, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(252, 250, 244, 0.55)';
  ctx.fillText('КОН', lx, ly);
  ctx.restore();
}

/**
 * Камень: неровный валун, вписанный в прямоугольник физического тела (форма и размер совпадают
 * со столкновениями), с тенью, бликом, трещинами и пятнами мха.
 */
function drawObstacles(ctx: CanvasRenderingContext2D, obstacles: readonly Obstacle[]): void {
  obstacles.forEach((o, i) => {
    const rnd = mulberry32(777 + i * 131 + Math.round(o.x * 3 + o.y));
    const hw = o.w / 2;
    const hh = o.h / 2;
    const r = Math.min(o.w, o.h) * 0.32;
    // контур: скруглённый прямоугольник с лёгкой неровностью
    const blob = (dx: number, dy: number, grow = 0) => {
      ctx.beginPath();
      ctx.roundRect(o.x - hw + dx - grow, o.y - hh + dy - grow, o.w + grow * 2, o.h + grow * 2, r + grow);
    };
    ctx.save();
    // тень
    ctx.fillStyle = 'rgba(25, 20, 12, 0.3)';
    blob(11, 15, 3);
    ctx.fill();
    // основной объём
    const g = ctx.createLinearGradient(o.x - hw, o.y - hh, o.x + hw, o.y + hh);
    g.addColorStop(0, '#c9c7c0');
    g.addColorStop(0.55, '#9b9992');
    g.addColorStop(1, '#6f6d68');
    ctx.fillStyle = g;
    blob(0, 0);
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(40, 38, 34, 0.55)';
    ctx.stroke();
    ctx.clip();
    // грани и трещины
    ctx.strokeStyle = 'rgba(50, 48, 44, 0.4)';
    ctx.lineWidth = 2;
    for (let k = 0; k < 3; k++) {
      ctx.beginPath();
      let x = o.x - hw + rnd() * o.w;
      let y = o.y - hh + rnd() * o.h;
      ctx.moveTo(x, y);
      for (let s = 0; s < 4; s++) {
        x += (rnd() - 0.5) * 36;
        y += (rnd() - 0.2) * 22;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // мох сверху-слева
    ctx.fillStyle = 'rgba(96, 140, 60, 0.55)';
    for (let k = 0; k < 6; k++) {
      ctx.beginPath();
      ctx.ellipse(o.x - hw * 0.7 + rnd() * hw * 1.2, o.y - hh * 0.8 + rnd() * hh * 0.5, 8 + rnd() * 12, 4 + rnd() * 6, rnd() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    // блик
    ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.beginPath();
    ctx.ellipse(o.x - hw * 0.35, o.y - hh * 0.45, hw * 0.4, hh * 0.22, -0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });
}

function drawTreeCanopy(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, rnd: () => number) {
  ctx.save();
  // тень кроны
  ctx.fillStyle = 'rgba(20, 45, 20, 0.28)';
  for (let i = 0; i < 9; i++) {
    const a = rnd() * Math.PI * 2;
    const d = rnd() * r * 0.55;
    ctx.beginPath();
    ctx.arc(cx + 30 + Math.cos(a) * d, cy + 40 + Math.sin(a) * d, r * (0.45 + rnd() * 0.25), 0, Math.PI * 2);
    ctx.fill();
  }
  const cols = ['#3f7f3a', '#4d9443', '#5aa64d', '#6db85b'];
  for (let layer = 0; layer < 4; layer++) {
    ctx.fillStyle = cols[layer];
    for (let i = 0; i < 8; i++) {
      const a = rnd() * Math.PI * 2;
      const d = rnd() * r * (0.6 - layer * 0.1);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * d - layer * 6, cy + Math.sin(a) * d - layer * 7, r * (0.42 - layer * 0.06) * (0.8 + rnd() * 0.4), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawBench(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.fillRect(10, 14, 90, 250);
  ctx.fillStyle = '#5b5f66';
  ctx.fillRect(-4, 20, 98, 12);
  ctx.fillRect(-4, 220, 98, 12);
  const planks = ['#b8763f', '#a86a37', '#c07f46', '#ad6f3b'];
  planks.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.fillRect(i * 23, 0, 19, 250);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(i * 23 + 2, 0, 3, 250);
  });
  ctx.restore();
}

function drawBall(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.ellipse(x + 10, y + 12, 30, 26, 0, 0, Math.PI * 2);
  ctx.fill();
  const g = ctx.createRadialGradient(x - 10, y - 10, 4, x, y, 30);
  g.addColorStop(0, '#fff3a8');
  g.addColorStop(0.5, '#ffcf3a');
  g.addColorStop(1, '#e09a12');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, 28, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(30, 110, 170, 0.9)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(x, y, 28, -0.6, 1.1);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x - 8, y + 4, 20, 2.2, 3.9);
  ctx.stroke();
  ctx.restore();
}

/** Меловые «классики» — узнаваемая деталь двора. */
function drawHopscotch(ctx: CanvasRenderingContext2D, x: number, y: number, rnd: () => number) {
  const s = 52;
  const cells: [number, number, string][] = [
    [0, 0, '1'],
    [0, -1, '2'],
    [0, -2, '3'],
    [-0.5, -3, '4'],
    [0.5, -3, '5'],
    [0, -4, '6'],
    [-0.5, -5, '7'],
    [0.5, -5, '8'],
  ];
  ctx.save();
  ctx.globalAlpha = 0.42;
  for (const [cx, cy, label] of cells) {
    const x0 = x + cx * s - s / 2;
    const y0 = y + cy * s;
    chalkStroke(ctx, [...linePts(x0, y0, x0 + s, y0, 20), ...linePts(x0 + s, y0, x0 + s, y0 + s, 20).slice(1), ...linePts(x0 + s, y0 + s, x0, y0 + s, 20).slice(1), ...linePts(x0, y0 + s, x0, y0, 20).slice(1)], rnd, 3);
    ctx.font = '700 22px Unbounded Variable, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(252,250,244,0.9)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x0 + s / 2, y0 + s / 2);
  }
  ctx.restore();
}

function drawChalkSun(ctx: CanvasRenderingContext2D, x: number, y: number, rnd: () => number) {
  ctx.save();
  ctx.globalAlpha = 0.5;
  const n = 36;
  chalkStroke(
    ctx,
    Array.from({ length: n + 1 }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      return { x: x + Math.cos(a) * 34, y: y + Math.sin(a) * 34 };
    }),
    rnd,
    3.5,
    0.9,
  );
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    chalkStroke(ctx, linePts(x + Math.cos(a) * 46, y + Math.sin(a) * 46, x + Math.cos(a) * 66, y + Math.sin(a) * 66, 10), rnd, 3.5, 0.9);
  }
  ctx.restore();
  // жёлтый мелок внутри
  ctx.save();
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = '#ffd84d';
  ctx.beginPath();
  ctx.arc(x, y, 28, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * Рисует статичный фон двора в мировых координатах (контекст уже с трансформацией камеры).
 * Результат кешируется в offscreen-canvas и перерисовывается только при resize/смене уровня.
 */
export function drawCourtyard(ctx: CanvasRenderingContext2D, zone: Zone, obstacles: readonly Obstacle[], vis: VisibleRect): void {
  // отдельный поток случайных чисел на каждый слой: размер экрана (количество травинок)
  // не должен менять расположение трещин, деревьев и мела
  const stream = (n: number) => mulberry32(20260930 + n * 7919);
  let rnd = stream(1);

  // 1) трава вокруг площадки
  ctx.fillStyle = '#79ad4f';
  ctx.fillRect(vis.x0, vis.y0, vis.x1 - vis.x0, vis.y1 - vis.y0);
  const grassCols = ['#6a9d44', '#88bc5c', '#5f913c', '#93c566'];
  const area = (vis.x1 - vis.x0) * (vis.y1 - vis.y0);
  const blades = Math.min(9000, area / 90);
  ctx.lineWidth = 2;
  for (let i = 0; i < blades; i++) {
    const x = vis.x0 + rnd() * (vis.x1 - vis.x0);
    const y = vis.y0 + rnd() * (vis.y1 - vis.y0);
    if (x > -10 && x < WORLD_W + 10 && y > -10) continue; // под асфальтом не рисуем
    ctx.strokeStyle = grassCols[i % grassCols.length];
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rnd() - 0.5) * 6, y - 5 - rnd() * 7);
    ctx.stroke();
  }
  // одуванчики
  rnd = stream(2);
  for (let i = 0; i < area / 9000; i++) {
    const x = vis.x0 + rnd() * (vis.x1 - vis.x0);
    const y = vis.y0 + rnd() * (vis.y1 - vis.y0);
    if (x > -20 && x < WORLD_W + 20 && y > -20) continue;
    ctx.fillStyle = rnd() > 0.35 ? '#ffd23f' : '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, 3 + rnd() * 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // 2) асфальт двора
  const ground = ctx.createLinearGradient(0, 0, WORLD_W, WORLD_H);
  ground.addColorStop(0, '#9a948b');
  ground.addColorStop(1, '#827c74');
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, WORLD_W, WORLD_H + 400);

  // заплатки
  rnd = stream(3);
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = rnd() > 0.5 ? 'rgba(60, 55, 50, 0.12)' : 'rgba(255, 250, 240, 0.05)';
    const x = rnd() * WORLD_W;
    const y = rnd() * WORLD_H;
    ctx.beginPath();
    ctx.roundRect(x, y, 80 + rnd() * 160, 60 + rnd() * 120, 10);
    ctx.fill();
  }
  // зерно асфальта
  const grains = (WORLD_W * WORLD_H) / 55;
  for (let i = 0; i < grains; i++) {
    const v = rnd();
    ctx.fillStyle = v > 0.55 ? `rgba(255,255,255,${0.05 + rnd() * 0.1})` : `rgba(30,26,22,${0.06 + rnd() * 0.12})`;
    const s = 1 + rnd() * 2.2;
    ctx.fillRect(rnd() * WORLD_W, rnd() * (WORLD_H + 200), s, s);
  }
  // трещины
  rnd = stream(4);
  ctx.strokeStyle = 'rgba(40, 34, 28, 0.35)';
  ctx.lineWidth = 1.6;
  for (let i = 0; i < 5; i++) {
    let x = rnd() * WORLD_W;
    let y = 150 + rnd() * (WORLD_H - 200);
    let a = rnd() * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let k = 0; k < 14; k++) {
      a += (rnd() - 0.5) * 1.1;
      x += Math.cos(a) * 14;
      y += Math.sin(a) * 14;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // опавшие листья
  for (let i = 0; i < 9; i++) {
    const x = CURB + 20 + rnd() * (WORLD_W - 2 * CURB - 40);
    const y = 40 + rnd() * (WORLD_H - 300);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rnd() * Math.PI * 2);
    ctx.fillStyle = rnd() > 0.5 ? 'rgba(118, 150, 60, 0.75)' : 'rgba(186, 150, 60, 0.7)';
    ctx.beginPath();
    ctx.ellipse(0, 0, 9, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 3) мел: классики, солнце, линия броска, кон
  rnd = stream(5);
  drawHopscotch(ctx, 96, 930, rnd);
  drawChalkSun(ctx, 690, 120, rnd);

  const tl = linePts(250, THROW_LINE_Y, 550, THROW_LINE_Y, 20);
  chalkStroke(ctx, tl, rnd, 4.5, 0.85);
  ctx.save();
  ctx.font = '600 18px Manrope Variable, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(252,250,244,0.5)';
  ctx.textAlign = 'center';
  ctx.fillText('сызық', THROW_ORIGIN.x - 196, THROW_LINE_Y + 6);
  ctx.restore();

  drawZone(ctx, zone, rnd);
  drawObstacles(ctx, obstacles);

  // 4) бордюр
  ctx.fillStyle = '#d3cec4';
  ctx.fillRect(-4, -4, CURB + 4, WORLD_H + 400);
  ctx.fillRect(WORLD_W - CURB, -4, CURB + 4, WORLD_H + 400);
  ctx.fillRect(-4, -4, WORLD_W + 8, CURB + 4);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(CURB, CURB, 4, WORLD_H + 400);
  ctx.fillRect(WORLD_W - CURB - 4, CURB, 4, WORLD_H + 400);
  ctx.fillRect(CURB, CURB, WORLD_W - 2 * CURB, 4);
  ctx.fillStyle = 'rgba(80,70,60,0.35)';
  for (let y = 60; y < WORLD_H + 300; y += 96) {
    ctx.fillRect(-4, y, CURB + 4, 2);
    ctx.fillRect(WORLD_W - CURB, y, CURB + 4, 2);
  }
  for (let x = 60; x < WORLD_W; x += 96) ctx.fillRect(x, -4, 2, CURB + 4);

  // 5) деревья, скамейка, мяч — только за пределами площадки
  rnd = stream(6);
  drawTreeCanopy(ctx, -150, 140, 190, rnd);
  drawTreeCanopy(ctx, WORLD_W + 170, 420, 210, rnd);
  drawTreeCanopy(ctx, -190, 980, 170, rnd);
  if (vis.x0 < -150) drawBench(ctx, -170, 520);
  if (vis.x1 > WORLD_W + 120) drawBall(ctx, WORLD_W + 110, 880);

  // 6) пятна тени от листвы на асфальте (летний полдень)
  ctx.save();
  ctx.beginPath();
  ctx.rect(CURB, CURB, WORLD_W - 2 * CURB, WORLD_H);
  ctx.clip();
  rnd = stream(7);
  ctx.fillStyle = 'rgba(28, 38, 48, 0.1)';
  const clusters = [
    { x: 30, y: 140, r: 200 },
    { x: WORLD_W - 10, y: 470, r: 200 },
    { x: 20, y: 990, r: 160 },
  ];
  for (const c of clusters) {
    for (let i = 0; i < 26; i++) {
      const a = rnd() * Math.PI * 2;
      const d = Math.sqrt(rnd()) * c.r;
      ctx.beginPath();
      ctx.ellipse(c.x + Math.cos(a) * d, c.y + Math.sin(a) * d, 14 + rnd() * 30, 10 + rnd() * 20, rnd() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();

  // 7) тёплый солнечный свет
  const sun = ctx.createRadialGradient(WORLD_W * 0.2, -100, 50, WORLD_W * 0.3, WORLD_H * 0.3, WORLD_H);
  sun.addColorStop(0, 'rgba(255, 230, 160, 0.22)');
  sun.addColorStop(1, 'rgba(255, 230, 160, 0)');
  ctx.fillStyle = sun;
  ctx.fillRect(vis.x0, vis.y0, vis.x1 - vis.x0, vis.y1 - vis.y0);
}
