import { PHYS, THROW_JITTER } from '../config';
import type { Vec2 } from '../types';
import { speedForDistance } from './friction';

export interface Aim {
  /** Угол от направления «вперёд» (вверх), + вправо, радианы. */
  angle: number;
  /** Сила 0…1. */
  power: number;
  /** Дистанция скольжения без столкновений (единицы мира). */
  slide: number;
  /** Достаточно ли силы для броска. */
  valid: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function aimFromAnglePower(angle: number, power: number): Aim {
  const p = clamp(power, 0, 1);
  const slide = p * PHYS.maxSlide;
  return {
    angle: clamp(angle, -PHYS.maxAimAngle, PHYS.maxAimAngle),
    power: p,
    slide,
    valid: slide >= PHYS.minSlide,
  };
}

/**
 * Прицел по положению указателя: направление — от сақа к пальцу/курсору,
 * длина натяжения — сила (maxDrag = 100 %). Дальность скольжения пропорциональна силе,
 * поэтому метка остановки лежит дальше пальца и не закрывается им на телефоне.
 */
export function aimFromPoint(origin: Vec2, p: Vec2, fallbackAngle = 0): Aim {
  const dx = p.x - origin.x;
  const dy = p.y - origin.y;
  if (dy > -6) {
    // тянут назад/вбок ниже руки — бросок невозможен (отмена)
    return { angle: fallbackAngle, power: 0, slide: 0, valid: false };
  }
  const angle = Math.atan2(dx, -dy);
  const dist = Math.hypot(dx, dy);
  return aimFromAnglePower(angle, dist / PHYS.maxDrag);
}

export function aimDirection(angle: number): Vec2 {
  return { x: Math.sin(angle), y: -Math.cos(angle) };
}

export function landingPoint(origin: Vec2, aim: Aim): Vec2 {
  const d = aimDirection(aim.angle);
  return { x: origin.x + d.x * aim.slide, y: origin.y + d.y * aim.slide };
}

/** Нормальное распределение (Box–Muller). */
function gaussian(rng: () => number): number {
  const u = Math.max(1e-9, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface ThrowParams {
  angle: number;
  speed: number;
  spin: number;
}

/**
 * Превращает прицел в реальные параметры броска.
 * Добавляет небольшой «человеческий» разброс: чем сильнее бросок, тем чуть больше отклонение.
 */
export function throwParams(aim: Aim, rng: () => number = Math.random, jitter = true): ThrowParams {
  const sigma = THROW_JITTER.angleMin + (THROW_JITTER.angleMax - THROW_JITTER.angleMin) * aim.power;
  const dAngle = jitter ? clamp(gaussian(rng) * sigma, -2.5 * sigma, 2.5 * sigma) : 0;
  const dPower = jitter ? (rng() * 2 - 1) * THROW_JITTER.power : 0;
  const slide = clamp(aim.slide * (1 + dPower), PHYS.minSlide, PHYS.maxSlide * 1.02);
  return {
    angle: aim.angle + dAngle,
    speed: speedForDistance(slide, PHYS.decel.saka),
    spin: jitter ? (rng() * 2 - 1) * 0.008 : 0,
  };
}
