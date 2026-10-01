import type { AsykFace } from '../types';
import { asykPathD, PALETTES, type AsykPalette } from './asykShape';

const pathCache = new Map<string, Path2D>();

export function asykPath(w: number, h: number): Path2D {
  const key = `${w}x${h}`;
  let p = pathCache.get(key);
  if (!p) {
    p = new Path2D(asykPathD(w, h));
    pathCache.set(key, p);
  }
  return p;
}

/**
 * Мягкая тень асыка. Рисуется в мировых координатах со смещением, НЕ поворачиваясь
 * вместе с солнцем (свет всегда сверху-слева).
 */
export function drawAsykShadow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  w: number,
  h: number,
  alpha = 1,
  lift = 0,
): void {
  const path = asykPath(w, h);
  const off = 4 + lift * 16;
  ctx.save();
  ctx.globalAlpha = 0.16 * alpha * (1 - lift * 0.4);
  ctx.fillStyle = '#1c1408';
  ctx.translate(x + off * 0.8, y + off);
  ctx.rotate(angle);
  ctx.scale(1.08 + lift * 0.1, 1.12 + lift * 0.1);
  ctx.fill(path);
  ctx.globalAlpha = 0.18 * alpha * (1 - lift * 0.5);
  ctx.scale(0.94, 0.92);
  ctx.fill(path);
  ctx.restore();
}

/** Сам асык/сақа: объёмная заливка + детали стороны («алшы», «тәйкі», «бүк», «шік»). */
export function drawAsyk(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  w: number,
  h: number,
  palette: AsykPalette,
  face: AsykFace,
  alpha = 1,
  scale = 1,
): void {
  const path = asykPath(w, h);
  const pal = PALETTES[palette];
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.rotate(angle);
  if (scale !== 1) ctx.scale(scale, scale);

  // основной объём: свет сверху-слева в мировых координатах → поворачиваем градиент обратно
  const la = -angle - Math.PI * 0.75;
  const gx = Math.cos(la) * w * 0.5;
  const gy = Math.sin(la) * h * 0.6;
  const g = ctx.createLinearGradient(gx, gy, -gx, -gy);
  g.addColorStop(0, pal.light);
  g.addColorStop(0.5, pal.mid);
  g.addColorStop(1, pal.dark);
  ctx.fillStyle = g;
  ctx.fill(path);

  ctx.lineWidth = 1.4;
  ctx.strokeStyle = pal.stroke;
  ctx.stroke(path);

  ctx.clip(path);
  switch (face) {
    case 'buk': {
      // выпуклая сторона: мягкий блик-горб
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.ellipse(-w * 0.06, -h * 0.08, w * 0.3, h * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'shik': {
      // вогнутая сторона: углубление
      ctx.fillStyle = 'rgba(90, 60, 25, 0.28)';
      ctx.beginPath();
      ctx.ellipse(0, h * 0.02, w * 0.2, h * 0.17, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(0, h * 0.05, w * 0.2, h * 0.17, 0, 0.2, Math.PI - 0.2);
      ctx.stroke();
      break;
    }
    case 'alshy':
    case 'taiky': {
      // боковая сторона: S-образная бороздка
      const dir = face === 'alshy' ? 1 : -1;
      ctx.strokeStyle = 'rgba(90, 60, 25, 0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-w * 0.28, -h * 0.05 * dir);
      ctx.bezierCurveTo(-w * 0.1, -h * 0.3 * dir, w * 0.1, h * 0.3 * dir, w * 0.28, h * 0.05 * dir);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      ctx.beginPath();
      ctx.ellipse(-w * 0.18, -h * 0.22, w * 0.14, h * 0.1, -0.3, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
  }
  if (palette === 'saka') {
    // «құйма сақа» — сақа, утяжелённый свинцом: маленькая металлическая заливка
    ctx.fillStyle = '#9aa3ad';
    ctx.beginPath();
    ctx.ellipse(w * 0.2, h * 0.04, w * 0.07, h * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath();
    ctx.ellipse(w * 0.185, h * 0.0, w * 0.025, h * 0.04, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // общий блик
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath();
  ctx.ellipse(-w * 0.25, -h * 0.3, w * 0.22, h * 0.12, -0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
