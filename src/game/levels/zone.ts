import type { Vec2, Zone } from '../types';

/** Находится ли точка внутри меловой зоны (кона). */
export function zoneContains(zone: Zone, p: Vec2): boolean {
  if (zone.kind === 'rect') {
    return p.x >= zone.x && p.x <= zone.x + zone.w && p.y >= zone.y && p.y <= zone.y + zone.h;
  }
  const dx = p.x - zone.cx;
  const dy = p.y - zone.cy;
  return dx * dx + dy * dy <= zone.r * zone.r;
}

/** Ближайшая к точке позиция на границе зоны (для эффекта «пересечения линии»). */
export function zoneEdgePoint(zone: Zone, p: Vec2): Vec2 {
  if (zone.kind === 'rect') {
    const x = Math.min(Math.max(p.x, zone.x), zone.x + zone.w);
    const y = Math.min(Math.max(p.y, zone.y), zone.y + zone.h);
    // точка вне прямоугольника — клампинг уже даёт точку на границе
    return { x, y };
  }
  const dx = p.x - zone.cx;
  const dy = p.y - zone.cy;
  const d = Math.hypot(dx, dy) || 1;
  return { x: zone.cx + (dx / d) * zone.r, y: zone.cy + (dy / d) * zone.r };
}

export function zoneCenter(zone: Zone): Vec2 {
  return zone.kind === 'rect'
    ? { x: zone.x + zone.w / 2, y: zone.y + zone.h / 2 }
    : { x: zone.cx, y: zone.cy };
}
