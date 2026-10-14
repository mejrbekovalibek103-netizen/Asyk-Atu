import { describe, expect, it } from 'vitest';
import { THROW_ORIGIN } from '../config';
import { distanceToCurb, distanceToObstruction, rayRectEntry } from './clip';

const up = { x: 0, y: -1 };
const rect = { x0: 350, y0: 500, x1: 450, y1: 560 };

describe('луч и прямоугольник', () => {
  it('прямое попадание: вход через нижнюю грань', () => {
    expect(rayRectEntry({ x: 400, y: 1000 }, up, rect)).toBeCloseTo(440);
  });

  it('промах мимо прямоугольника', () => {
    expect(rayRectEntry({ x: 200, y: 1000 }, up, rect)).toBeNull();
  });

  it('прямоугольник «позади» луча не пересекается', () => {
    expect(rayRectEntry({ x: 400, y: 100 }, up, rect)).toBeNull();
  });

  it('луч, скользящий вдоль грани (параллельно оси)', () => {
    expect(rayRectEntry({ x: 350, y: 1000 }, up, rect)).toBeCloseTo(440);
    expect(rayRectEntry({ x: 349, y: 1000 }, up, rect)).toBeNull();
  });

  it('диагональное попадание', () => {
    const d = { x: Math.SQRT1_2, y: -Math.SQRT1_2 };
    const t = rayRectEntry({ x: 300, y: 610 }, d, rect);
    expect(t).not.toBeNull();
    expect(300 + d.x * t!).toBeGreaterThanOrEqual(349.99);
  });
});

describe('до чего долетит сақа', () => {
  it('без камней — до бордюра', () => {
    expect(distanceToObstruction(THROW_ORIGIN, up, {})).toBeCloseTo(distanceToCurb(THROW_ORIGIN, up));
  });

  it('камень на пути обрывает бросок раньше бордюра, с запасом на размер сақа', () => {
    const layout = { obstacles: [{ x: 400, y: 600, w: 100, h: 60 }] };
    const d = distanceToObstruction(THROW_ORIGIN, up, layout);
    // нижняя грань камня y=630, плюс радиус сақа 21 → упрётся на y≈651
    expect(d).toBeCloseTo(THROW_ORIGIN.y - (630 + 21), 0);
    expect(d).toBeLessThan(distanceToCurb(THROW_ORIGIN, up));
  });

  it('камень в стороне от траектории не мешает', () => {
    const layout = { obstacles: [{ x: 150, y: 600, w: 100, h: 60 }] };
    expect(distanceToObstruction(THROW_ORIGIN, up, layout)).toBeCloseTo(distanceToCurb(THROW_ORIGIN, up));
  });
});
