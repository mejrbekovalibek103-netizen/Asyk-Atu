import { describe, expect, it } from 'vitest';
import { aimFromAnglePower } from '../physics/aim';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { simulateThrow } from '../physics/simulate';
import type { KonLayout, LevelConfig } from '../types';
import { LEVELS } from './levels';
import { MATCH_LAYOUTS } from './matchLayouts';

/**
 * Проходимость: «жадный бот» перебирает сетку (угол × сила) и на каждом броске берёт лучший.
 * Бот без случайного разброса — тест детерминирован. Если бот не справляется, уровень с большой
 * вероятностью непроходим (асыки спрятаны за камнем и недостижимы).
 */
const ANGLES = Array.from({ length: 37 }, (_, i) => -36 + i * 2);
const POWERS = [0.75, 0.9, 1];

function asLevel(layout: KonLayout, throws: number): LevelConfig {
  return {
    ...layout,
    order: 0,
    hint: '',
    throws,
    goal: { type: 'knockout', count: 1 },
    stars: [{ type: 'cleared' }, { type: 'cleared' }],
  };
}

function freshWorld(layout: KonLayout, snapshot?: ReturnType<PhysicsWorld['exportAsyks']>): PhysicsWorld {
  const w = new PhysicsWorld();
  w.addObstacles(layout.obstacles ?? []);
  w.addAsyks(layout.asyks);
  if (snapshot) w.importAsyks(snapshot, layout.asyks);
  return w;
}

/** Играет до `stop` и возвращает, сколько бросков понадобилось (или null, если не вышло за лимит). */
function play(layout: KonLayout, maxThrows: number, stop: (knocked: number, targetKnocked: boolean) => boolean): { throws: number; knocked: number } | null {
  const level = asLevel(layout, maxThrows);
  const world = freshWorld(layout);
  let knocked = 0;
  for (let t = 1; t <= maxThrows; t++) {
    const snapshot = world.exportAsyks(layout.asyks.length);
    let best = { a: 0, p: 1, score: -1 };
    for (const a of ANGLES) {
      for (const p of POWERS) {
        const r = simulateThrow(level, aimFromAnglePower((a * Math.PI) / 180, p), freshWorld(layout, snapshot));
        const score = r.knocked.length + (r.knocked.some((x) => x.kind === 'target') ? 100 : 0);
        if (score > best.score) best = { a, p, score };
      }
    }
    const r = simulateThrow(level, aimFromAnglePower((best.a * Math.PI) / 180, best.p), world);
    world.removeSaka();
    knocked += r.knocked.length;
    if (stop(knocked, r.knocked.some((x) => x.kind === 'target'))) return { throws: t, knocked };
  }
  return null;
}

describe('проходимость испытаний', () => {
  for (const level of LEVELS) {
    it(`${level.order}. ${level.name}: цель достижима за ${level.throws} бросков`, () => {
      const goal = level.goal;
      const res = play(level, level.throws, (knocked, target) => (goal.type === 'knockout' ? knocked >= goal.count : target));
      expect(res, `бот не выполнил цель уровня «${level.name}»`).not.toBeNull();
    }, 60_000);
  }
});

describe('проходимость конов для матча', () => {
  // каждый асык должен быть достижим, иначе матч закончится по лимиту бросков, а не «кон пуст»
  for (const layout of MATCH_LAYOUTS.filter((l) => ['korgan', 'rassyp'].includes(l.id))) {
    it(`${layout.name}: кон можно очистить за лимит матча`, () => {
      const res = play(layout, 30, (knocked) => knocked >= layout.asyks.length);
      expect(res, `кон «${layout.name}» не очищается`).not.toBeNull();
    }, 120_000);
  }
});
