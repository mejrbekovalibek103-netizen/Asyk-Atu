import { describe, expect, it } from 'vitest';
import { ASYK_H, ASYK_W, CURB, PHYS, THROW_ORIGIN, WORLD_W } from '../config';
import { LEVELS } from './levels';
import { zoneContains } from './zone';

describe('конфигурация испытаний', () => {
  it('уникальные id и порядок', () => {
    expect(new Set(LEVELS.map((l) => l.id)).size).toBe(LEVELS.length);
    LEVELS.forEach((l, i) => expect(l.order).toBe(i + 1));
  });

  for (const level of LEVELS) {
    describe(level.name, () => {
      it('все асыки внутри кона и в пределах двора', () => {
        for (const a of level.asyks) {
          expect(zoneContains(level.zone, a)).toBe(true);
          expect(a.x - ASYK_W / 2).toBeGreaterThan(CURB);
          expect(a.x + ASYK_W / 2).toBeLessThan(WORLD_W - CURB);
        }
      });

      it('асыки не пересекаются в начале', () => {
        const s = level.asyks;
        for (let i = 0; i < s.length; i++) {
          for (let j = i + 1; j < s.length; j++) {
            const dx = Math.abs(s[i].x - s[j].x);
            const dy = Math.abs(s[i].y - s[j].y);
            expect(dx >= ASYK_W + 2 || dy >= ASYK_H + 2).toBe(true);
          }
        }
      });

      it('кон досягаем максимальным броском', () => {
        for (const a of level.asyks) {
          expect(Math.hypot(a.x - THROW_ORIGIN.x, a.y - THROW_ORIGIN.y)).toBeLessThan(PHYS.maxSlide * 0.85);
        }
      });

      it('цель уровня достижима', () => {
        if (level.goal.type === 'knockout') expect(level.goal.count).toBeLessThanOrEqual(level.asyks.length);
        else expect(level.asyks.some((a) => a.kind === 'target')).toBe(true);
      });
    });
  }
});
