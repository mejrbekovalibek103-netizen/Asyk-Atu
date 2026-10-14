import { describe, expect, it } from 'vitest';
import { CURB, PHYS, WORLD_H, WORLD_W } from '../config';
import { LEVELS } from '../levels/levels';
import { MATCH_LAYOUTS } from '../levels/matchLayouts';
import type { KonLayout, LevelConfig } from '../types';
import { aimFromAnglePower, throwParams } from './aim';
import { PhysicsWorld } from './PhysicsWorld';
import { simulateThrow } from './simulate';

/**
 * Фаззинг физики: тысячи случайных бросков (включая крайние значения) на всех расстановках.
 * Проверяем инварианты — то, что не должно нарушаться никогда, чем бы ни бросал игрок:
 * числа конечны, тела не вылетают за двор, бросок завершается, асыки не появляются из ниоткуда
 * и не считаются выбитыми дважды.
 */
let seed = 987654321;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

function asLevel(l: KonLayout): LevelConfig {
  return { ...l, order: 0, hint: '', throws: 1, goal: { type: 'knockout', count: 1 }, stars: [{ type: 'cleared' }, { type: 'cleared' }] };
}

function checkWorld(w: PhysicsWorld, total: number) {
  for (const p of w.pieces) {
    const { x, y } = p.body.position;
    expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(p.body.angle)).toBe(true);
    // тела остаются внутри двора (стены держат даже самые сильные броски)
    expect(x).toBeGreaterThan(CURB - 30);
    expect(x).toBeLessThan(WORLD_W - CURB + 30);
    expect(y).toBeGreaterThan(CURB - 30);
    expect(y).toBeLessThan(WORLD_H + 30);
  }
  const asyks = w.pieces.filter((p) => p.kind !== 'saka');
  expect(asyks.length).toBeLessThanOrEqual(total);
  expect(new Set(asyks.map((p) => p.index)).size).toBe(asyks.length); // нет двойников
}

describe('фаззинг физики: инварианты на всех расстановках', () => {
  const layouts: KonLayout[] = [...LEVELS, ...MATCH_LAYOUTS];

  for (const layout of layouts) {
    it(`${layout.name}: случайные и крайние броски`, () => {
      const level = asLevel(layout);
      let world = new PhysicsWorld();
      world.addObstacles(layout.obstacles ?? []);
      world.addAsyks(layout.asyks);
      let knockedTotal = 0;
      const seenKnocked = new Set<number>();
      for (let n = 0; n < 12; n++) {
        // крайние значения вперемешку со случайными
        const angle = [(-78 * Math.PI) / 180, (78 * Math.PI) / 180, 0, (rnd() * 156 - 78) * (Math.PI / 180), (rnd() * 156 - 78) * (Math.PI / 180)][n % 5];
        const power = [1, 0.081, 0.5, rnd(), 1][n % 5];
        const aim = aimFromAnglePower(angle, power);
        if (!aim.valid) continue;
        const r = simulateThrow(level, aim, world);
        expect(r.settled, `бросок ${n} не завершился`).toBe(true);
        expect(r.durationMs).toBeLessThanOrEqual(PHYS.maxThrowMs + 50);
        for (const k of r.knocked) {
          expect(seenKnocked.has(k.index), 'асык выбит дважды').toBe(false);
          seenKnocked.add(k.index);
        }
        knockedTotal += r.knocked.length;
        checkWorld(world, layout.asyks.length);
        world.removeSaka();
        if (world.asyksIn().length === 0) {
          world = new PhysicsWorld();
          world.addObstacles(layout.obstacles ?? []);
          world.addAsyks(layout.asyks);
          seenKnocked.clear();
        }
      }
      expect(knockedTotal).toBeGreaterThanOrEqual(0);
    });
  }

  it('случайный разброс руки не выводит бросок за допустимые границы', () => {
    for (let i = 0; i < 400; i++) {
      const aim = aimFromAnglePower((rnd() * 2 - 1) * 1.36, rnd());
      const p = throwParams(aim, rnd, true);
      expect(Number.isFinite(p.angle) && Number.isFinite(p.speed) && Number.isFinite(p.spin)).toBe(true);
      expect(Math.abs(p.angle)).toBeLessThan(1.5); // не выходит за предел, который принимает проверка сетевых сообщений
      expect(p.speed).toBeGreaterThan(0);
    }
  });
});
