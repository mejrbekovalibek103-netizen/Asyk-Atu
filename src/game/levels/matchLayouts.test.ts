import { describe, expect, it } from 'vitest';
import { LIMITS } from '../../net/limits';
import { ASYK_H, ASYK_W, CURB, PHYS, THROW_LINE_Y, THROW_ORIGIN, WORLD_W } from '../config';
import { aimFromAnglePower } from '../physics/aim';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { simulateThrow } from '../physics/simulate';
import { matchThrowLimit } from '../rules/matchState';
import type { KonLayout, LevelConfig } from '../types';
import { getMatchLayout, isGrowingLayout, layoutSizes, MATCH_LAYOUTS } from './matchLayouts';
import { zoneContains } from './zone';

const GROWING = MATCH_LAYOUTS.filter((l) => isGrowingLayout(l.id)).map((l) => l.id);
const PLAYERS = [2, 3, 4] as const;

describe('растущие коны: размер зависит от числа игроков', () => {
  it('их пять, остальные пять конов прежние', () => {
    expect(GROWING).toHaveLength(5);
    expect(MATCH_LAYOUTS).toHaveLength(10);
    expect(isGrowingLayout('ulken-kon')).toBe(false);
    expect(getMatchLayout('ulken-kon', 4)).toBe(getMatchLayout('ulken-kon', 2));
  });

  for (const id of GROWING) {
    it(`${id}: у двоих 16 асыков, дальше +4–5 на каждого игрока`, () => {
      const [two, three, four] = layoutSizes(id);
      expect(two).toBe(16);
      expect(three - two).toBeGreaterThanOrEqual(4);
      expect(three - two).toBeLessThanOrEqual(5);
      expect(four - three).toBeGreaterThanOrEqual(4);
      expect(four - three).toBeLessThanOrEqual(5);
      // протокол онлайна принимает не больше LIMITS.maxAsyks асыков
      expect(four).toBeLessThanOrEqual(LIMITS.maxAsyks);
    });

    it(`${id}: у всех игроков один и тот же кон (строится детерминированно)`, () => {
      for (const n of PLAYERS) {
        expect(getMatchLayout(id, n)).toBe(getMatchLayout(id, n));
        expect(JSON.parse(JSON.stringify(getMatchLayout(id, n)))).toEqual(JSON.parse(JSON.stringify(getMatchLayout(id, n))));
      }
      // в выборе кона — вид для двоих; вне 2–4 — ближайший допустимый
      expect(MATCH_LAYOUTS.find((l) => l.id === id)).toBe(getMatchLayout(id, 2));
      expect(getMatchLayout(id, 1)).toBe(getMatchLayout(id, 2));
      expect(getMatchLayout(id, 9)).toBe(getMatchLayout(id, 4));
    });
  }
});

describe('растущие коны: геометрия', () => {
  for (const id of GROWING) {
    for (const n of PLAYERS) {
      const l = getMatchLayout(id, n);
      it(`${l.name} на ${n}: асыки внутри кона и двора, не пересекаются, досягаемы`, () => {
        for (const a of l.asyks) {
          expect(zoneContains(l.zone, a)).toBe(true);
          expect(a.x - ASYK_W / 2).toBeGreaterThan(CURB);
          expect(a.x + ASYK_W / 2).toBeLessThan(WORLD_W - CURB);
          expect(Math.hypot(a.x - THROW_ORIGIN.x, a.y - THROW_ORIGIN.y)).toBeLessThan(PHYS.maxSlide * 0.85);
        }
        if (l.zone.kind === 'rect') {
          expect(l.zone.x).toBeGreaterThan(CURB);
          expect(l.zone.x + l.zone.w).toBeLessThan(WORLD_W - CURB);
        }
        const s = l.asyks;
        for (let i = 0; i < s.length; i++) {
          for (let j = i + 1; j < s.length; j++) {
            const dx = Math.abs(s[i].x - s[j].x);
            const dy = Math.abs(s[i].y - s[j].y);
            expect(dx >= ASYK_W + 2 || dy >= ASYK_H + 2 || Math.hypot(dx, dy) >= Math.hypot(ASYK_W, ASYK_H) * 0.75).toBe(true);
          }
        }
      });

      if (l.obstacles?.length) {
        it(`${l.name} на ${n}: камни позади асыков — в коне нет «тени», где асык не достать из руки`, () => {
          for (const st of l.obstacles!) {
            expect(st.x - st.w / 2).toBeGreaterThan(CURB + 40);
            expect(st.x + st.w / 2).toBeLessThan(WORLD_W - CURB - 40);
            expect(st.y + st.h / 2).toBeLessThan(THROW_LINE_Y - 120);
            // за дальним краем камня уже не кон
            expect(l.zone.kind).toBe('rect');
            if (l.zone.kind === 'rect') expect(st.y - st.h / 2).toBeLessThanOrEqual(l.zone.y);
            for (const a of l.asyks) {
              const gapX = Math.abs(a.x - st.x) - (st.w / 2 + ASYK_W / 2);
              const gapY = Math.abs(a.y - st.y) - (st.h / 2 + ASYK_W / 2);
              expect(gapX > 10 || gapY > 10).toBe(true);
            }
          }
        });
      }
    }
  }
});

/**
 * Проходимость: «жадный бот» (сетка угол × сила, без разброса руки) на каждом броске берёт лучший и должен очистить
 * кон за лимит матча на столько игроков. Иначе матч заканчивался бы по броскам, а не «кон пуст».
 */
const ANGLES = Array.from({ length: 37 }, (_, i) => -36 + i * 2);
const POWERS = [0.75, 0.9, 1];

function asLevel(layout: KonLayout, throws: number): LevelConfig {
  return { ...layout, order: 0, hint: '', throws, goal: { type: 'knockout', count: 1 }, stars: [{ type: 'cleared' }, { type: 'cleared' }] };
}

function world(layout: KonLayout, snapshot?: ReturnType<PhysicsWorld['exportAsyks']>): PhysicsWorld {
  const w = new PhysicsWorld();
  w.addObstacles(layout.obstacles ?? []);
  w.addAsyks(layout.asyks);
  if (snapshot) w.importAsyks(snapshot, layout.asyks);
  return w;
}

function throwsToClear(layout: KonLayout, maxThrows: number): number | null {
  const level = asLevel(layout, maxThrows);
  const w = world(layout);
  let knocked = 0;
  for (let t = 1; t <= maxThrows; t++) {
    const snap = w.exportAsyks(layout.asyks.length);
    let best = { a: 0, p: 1, score: -1 };
    for (const a of ANGLES) {
      for (const p of POWERS) {
        const r = simulateThrow(level, aimFromAnglePower((a * Math.PI) / 180, p), world(layout, snap));
        if (r.knocked.length > best.score) best = { a, p, score: r.knocked.length };
      }
    }
    knocked += simulateThrow(level, aimFromAnglePower((best.a * Math.PI) / 180, best.p), w).knocked.length;
    w.removeSaka();
    if (knocked >= layout.asyks.length) return t;
  }
  return null;
}

describe('растущие коны: проходимость за лимит матча', () => {
  for (const id of GROWING) {
    for (const n of PLAYERS) {
      const l = getMatchLayout(id, n);
      it(`${l.name} на ${n} (${l.asyks.length} асыков): кон очищается за ${matchThrowLimit(n)} бросков`, () => {
        const t = throwsToClear(l, matchThrowLimit(n));
        expect(t, `кон «${l.name}» на ${n} игроков не очищается`).not.toBeNull();
      }, 120_000);
    }
  }
});
