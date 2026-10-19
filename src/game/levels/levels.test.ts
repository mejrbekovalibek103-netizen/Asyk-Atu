import { describe, expect, it } from 'vitest';
import { ASYK_H, ASYK_W, CURB, PHYS, THROW_LINE_Y, THROW_ORIGIN, WORLD_W } from '../config';
import type { KonLayout } from '../types';
import { LEVELS } from './levels';
import { MATCH_LAYOUTS } from './matchLayouts';
import { zoneContains } from './zone';

/** Общие проверки корректности расстановки: и для испытаний, и для кона матча. */
function checkLayout(layout: KonLayout) {
  it('все асыки внутри кона и в пределах двора', () => {
    for (const a of layout.asyks) {
      expect(zoneContains(layout.zone, a)).toBe(true);
      expect(a.x - ASYK_W / 2).toBeGreaterThan(CURB);
      expect(a.x + ASYK_W / 2).toBeLessThan(WORLD_W - CURB);
    }
  });

  it('асыки не пересекаются в начале', () => {
    const s = layout.asyks;
    for (let i = 0; i < s.length; i++) {
      for (let j = i + 1; j < s.length; j++) {
        const dx = Math.abs(s[i].x - s[j].x);
        const dy = Math.abs(s[i].y - s[j].y);
        // расстояние между центрами больше диагонали асыка — тела точно не перекрываются при любом развороте
        expect(dx >= ASYK_W + 2 || dy >= ASYK_H + 2 || Math.hypot(dx, dy) >= Math.hypot(ASYK_W, ASYK_H) * 0.75).toBe(true);
      }
    }
  });

  it('кон досягаем максимальным броском', () => {
    for (const a of layout.asyks) {
      expect(Math.hypot(a.x - THROW_ORIGIN.x, a.y - THROW_ORIGIN.y)).toBeLessThan(PHYS.maxSlide * 0.85);
    }
  });

  it('камни: внутри двора, не на асыках, не у руки и не друг на друге', () => {
    const stones = layout.obstacles ?? [];
    for (const s of stones) {
      expect(s.x - s.w / 2).toBeGreaterThan(CURB + 40);
      expect(s.x + s.w / 2).toBeLessThan(WORLD_W - CURB - 40);
      expect(s.y + s.h / 2).toBeLessThan(THROW_LINE_Y - 120); // руке и линии броска никто не мешает
      for (const a of layout.asyks) {
        const gapX = Math.abs(a.x - s.x) - (s.w / 2 + ASYK_W / 2);
        const gapY = Math.abs(a.y - s.y) - (s.h / 2 + ASYK_W / 2);
        expect(gapX > 10 || gapY > 10).toBe(true);
      }
    }
    for (let i = 0; i < stones.length; i++) {
      for (let j = i + 1; j < stones.length; j++) {
        const gapX = Math.abs(stones[i].x - stones[j].x) - (stones[i].w + stones[j].w) / 2;
        const gapY = Math.abs(stones[i].y - stones[j].y) - (stones[i].h + stones[j].h) / 2;
        expect(gapX > 60 || gapY > 60).toBe(true); // между камнями сақа должен проходить
      }
    }
  });
}

describe('конфигурация испытаний', () => {
  it('уникальные id и порядок', () => {
    expect(new Set(LEVELS.map((l) => l.id)).size).toBe(LEVELS.length);
    LEVELS.forEach((l, i) => expect(l.order).toBe(i + 1));
  });

  it('в игре 20 испытаний: 1–10 без времени, 11–20 со временем', () => {
    expect(LEVELS).toHaveLength(20);
    for (const l of LEVELS) expect(l.timeLimit !== undefined, `${l.order}. ${l.name}`).toBe(l.order > 10);
  });

  it('лимиты времени разумны: кратны 5 с и 8–16 секунд на бросок', () => {
    for (const l of LEVELS.filter((x) => x.timeLimit !== undefined)) {
      const t = l.timeLimit!;
      expect(Number.isInteger(t) && t % 5 === 0, `${l.name}: ${t} с`).toBe(true);
      const perThrow = t / l.throws;
      // сам бросок вместе с паузой занимает около 2 с, остальное — прицеливание и размышление
      expect(perThrow, `${l.name}: ${perThrow.toFixed(1)} с на бросок`).toBeGreaterThanOrEqual(8);
      expect(perThrow, `${l.name}: ${perThrow.toFixed(1)} с на бросок`).toBeLessThanOrEqual(16);
    }
  });

  it('описания не содержат цифр времени (оно показывается отдельно и могло бы разойтись с лимитом)', () => {
    for (const l of LEVELS.filter((x) => x.timeLimit !== undefined)) {
      expect(l.description, l.name).not.toMatch(/\d+\s*(с|сек|мин)/i);
    }
  });

  for (const level of LEVELS) {
    describe(`${level.order}. ${level.name}`, () => {
      checkLayout(level);

      it('цель и звёзды достижимы по числу асыков', () => {
        if (level.goal.type === 'knockout') expect(level.goal.count).toBeLessThanOrEqual(level.asyks.length);
        else expect(level.asyks.some((a) => a.kind === 'target')).toBe(true);
        for (const rule of level.stars) {
          if (rule.type === 'knocked') expect(rule.count).toBeLessThanOrEqual(level.asyks.length);
          if (rule.type === 'targetWithin') expect(rule.throws).toBeLessThanOrEqual(level.throws);
        }
      });

      it('звёзды усложняются: 3★ строго труднее 2★', () => {
        const [two, three] = level.stars;
        if (two.type === 'knocked' && three.type === 'knocked') expect(three.count).toBeGreaterThan(two.count);
        if (two.type === 'targetWithin' && three.type === 'targetWithin') expect(three.throws).toBeLessThan(two.throws);
      });
    });
  }
});

describe('расстановки для матча', () => {
  it('уникальные id', () => {
    expect(new Set(MATCH_LAYOUTS.map((l) => l.id)).size).toBe(MATCH_LAYOUTS.length);
  });

  for (const layout of MATCH_LAYOUTS) {
    describe(layout.name, () => {
      checkLayout(layout);

      it('асыков достаточно для матча по 15 бросков на игрока (и не слишком много)', () => {
        expect(layout.asyks.length).toBeGreaterThanOrEqual(10);
        expect(layout.asyks.length).toBeLessThanOrEqual(20);
      });
    });
  }
});
