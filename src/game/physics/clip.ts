import { CURB, SAKA_H, WORLD_W } from '../config';
import type { KonLayout, Vec2 } from '../types';

/** Пересечение луча (origin + t·dir, t ≥ 0) с прямоугольником: минимальное t входа или null. Метод «плит» (slab). */
export function rayRectEntry(origin: Vec2, dir: Vec2, rect: { x0: number; y0: number; x1: number; y1: number }): number | null {
  let tMin = 0;
  let tMax = Infinity;
  for (const [o, d, lo, hi] of [
    [origin.x, dir.x, rect.x0, rect.x1],
    [origin.y, dir.y, rect.y0, rect.y1],
  ] as const) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null; // луч параллелен плите и лежит вне её
    } else {
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return null;
    }
  }
  return tMin;
}

/** Расстояние от точки броска до бордюра по направлению dir (с учётом половины ширины сақа). */
export function distanceToCurb(o: Vec2, dir: Vec2): number {
  const pad = CURB + SAKA_H / 2;
  let t = Infinity;
  if (dir.x > 1e-6) t = Math.min(t, (WORLD_W - pad - o.x) / dir.x);
  if (dir.x < -1e-6) t = Math.min(t, (pad - o.x) / dir.x);
  if (dir.y < -1e-6) t = Math.min(t, (pad - o.y) / dir.y);
  return Math.max(0, t);
}

/**
 * Куда долетит сақа по прямой, прежде чем упрётся в бордюр или камень.
 * Прицел обрывает пунктир в этой точке и рисует метку «удар».
 * Сақа считается кругом радиуса SAKA_H/2: камень «раздувается» на этот радиус.
 */
export function distanceToObstruction(o: Vec2, dir: Vec2, layout: Pick<KonLayout, 'obstacles'>): number {
  let t = distanceToCurb(o, dir);
  const pad = SAKA_H / 2;
  for (const s of layout.obstacles ?? []) {
    const hit = rayRectEntry(o, dir, { x0: s.x - s.w / 2 - pad, y0: s.y - s.h / 2 - pad, x1: s.x + s.w / 2 + pad, y1: s.y + s.h / 2 + pad });
    if (hit !== null && hit < t) t = hit;
  }
  return Math.max(0, t);
}
