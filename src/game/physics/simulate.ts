import { playThrow } from '../sim/runThrow';
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
 * Headless-симуляция одного броска (без рендера). Используется в тестах и решателе,
 * чтобы проверить, что результат действительно зависит от угла и силы.
 *
 * Тонкая обёртка над циклом серверного броска (sim/runThrow.ts → playThrow): бросок без разброса руки,
 * в переданном мире (или в новом), мир остаётся вызывающему.
 */
export function simulateThrow(level: LevelConfig, aim: Aim, world?: PhysicsWorld): SimResult {
  const w = world ?? new PhysicsWorld();
  if (!world) {
    w.addObstacles(level.obstacles ?? []);
    w.addAsyks(level.asyks);
  }
  const r = playThrow(w, level.zone, throwParams(aim, Math.random, false), 1);
  const pos = w.saka?.body.position ?? { x: NaN, y: NaN };
  return { knocked: r.knocked, sakaEnd: { x: pos.x, y: pos.y }, durationMs: r.durationMs, settled: r.settled, world: w };
}
