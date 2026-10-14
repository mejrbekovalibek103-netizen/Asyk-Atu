import { PHYS, THROW_ORIGIN } from '../config';
import type { LevelConfig } from '../types';
import type { Aim } from './aim';
import { throwParams } from './aim';
import { PhysicsWorld, type Piece } from './PhysicsWorld';

export interface SimResult {
  knocked: Piece[];
  sakaEnd: { x: number; y: number };
  durationMs: number;
  settled: boolean;
  world: PhysicsWorld;
}

/**
 * Headless-симуляция одного броска (без рендера). Используется в тестах,
 * чтобы проверить, что результат действительно зависит от угла и силы.
 */
export function simulateThrow(level: LevelConfig, aim: Aim, world?: PhysicsWorld): SimResult {
  const w = world ?? new PhysicsWorld();
  if (!world) {
    w.addObstacles(level.obstacles ?? []);
    w.addAsyks(level.asyks);
  }
  const p = throwParams(aim, Math.random, false);
  w.launchSaka(THROW_ORIGIN, p.angle, p.speed, p.spin);

  const knocked: Piece[] = [];
  let settledFor = 0;
  let t = 0;
  let settled = false;
  while (t < PHYS.maxThrowMs) {
    w.step();
    t += PHYS.stepMs;
    knocked.push(...w.checkKnockouts(level.zone, 1));
    if (w.isSettled()) {
      settledFor += PHYS.stepMs;
      if (settledFor >= PHYS.settleMs) {
        settled = true;
        break;
      }
    } else {
      settledFor = 0;
    }
  }
  const pos = w.saka?.body.position ?? { x: NaN, y: NaN };
  return { knocked, sakaEnd: { x: pos.x, y: pos.y }, durationMs: t, settled, world: w };
}
