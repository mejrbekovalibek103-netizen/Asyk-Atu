import { PHYS } from '../config';

/** Отношение шага симуляции к базовому кадру 1/60 с (скорости Matter.js заданы «за 1/60 с»). */
export const STEP_K = PHYS.stepMs / (1000 / 60);

/**
 * Модель трения о землю за один подшаг.
 *
 * 1) постоянное замедление `decel` (кулоново трение скольжения: не зависит от скорости);
 * 2) небольшое пропорциональное затухание `linearDamping`;
 * 3) если скорость стала совсем маленькой — объект останавливается полностью.
 *
 * Эта же функция используется и в мире Matter.js, и в прогнозе дальности броска,
 * поэтому пунктир прицела точно совпадает с реальным скольжением (без столкновений).
 */
export function frictionStep(speed: number, decel: number): number {
  let s = speed - decel * STEP_K;
  if (s <= 0) return 0;
  s *= 1 - PHYS.linearDamping * STEP_K;
  return s < PHYS.stopSpeed ? 0 : s;
}

export function angularFrictionStep(av: number): number {
  const sign = Math.sign(av);
  let a = Math.abs(av) - PHYS.angularDecel * STEP_K;
  if (a <= 0) return 0;
  a *= 1 - PHYS.angularDamping * STEP_K;
  return a < PHYS.stopAngular ? 0 : a * sign;
}

/** Дистанция, которую проскользит тело с начальной скоростью v0 (без столкновений). */
export function slideDistance(v0: number, decel: number): number {
  let s = v0;
  let d = 0;
  for (let i = 0; i < 100000 && s > 0; i++) {
    s = frictionStep(s, decel);
    d += s * STEP_K; // перемещение за подшаг = скорость(за 1/60 с) × долю кадра
  }
  return d;
}

/** Обратная задача: какая нужна скорость, чтобы проскользить `distance`. Бинарный поиск. */
export function speedForDistance(distance: number, decel: number): number {
  if (distance <= 0) return 0;
  let lo = 0;
  let hi = 5;
  while (slideDistance(hi, decel) < distance && hi < 500) hi *= 2;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (slideDistance(mid, decel) < distance) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
