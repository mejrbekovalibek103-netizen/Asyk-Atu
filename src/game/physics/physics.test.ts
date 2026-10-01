import { describe, expect, it } from 'vitest';
import { PHYS, THROW_ORIGIN } from '../config';
import { getLevel } from '../levels/levels';
import type { LevelConfig } from '../types';
import { aimFromAnglePower, aimFromPoint, landingPoint } from './aim';
import { slideDistance, speedForDistance } from './friction';
import { PhysicsWorld } from './PhysicsWorld';
import { simulateThrow } from './simulate';

const deg = (d: number) => (d * Math.PI) / 180;
const emptyLevel: LevelConfig = { ...getLevel('warmup'), asyks: [] };

describe('модель трения', () => {
  it('обратная функция скорости согласована с дистанцией', () => {
    for (const d of [90, 250, 500, 800, 1000]) {
      const v = speedForDistance(d, PHYS.decel.saka);
      expect(slideDistance(v, PHYS.decel.saka)).toBeCloseTo(d, 0);
    }
  });

  it('больше сила → дальше бросок (монотонность)', () => {
    let prev = 0;
    for (let v = 1; v < 40; v += 1) {
      const d = slideDistance(v, PHYS.decel.saka);
      expect(d).toBeGreaterThan(prev);
      prev = d;
    }
  });
});

describe('прицел', () => {
  it('точка указателя задаёт направление и силу', () => {
    const aim = aimFromPoint(THROW_ORIGIN, { x: THROW_ORIGIN.x, y: THROW_ORIGIN.y - PHYS.maxDrag / 2 });
    expect(aim.angle).toBeCloseTo(0);
    expect(aim.power).toBeCloseTo(0.5);
    expect(aim.slide).toBeCloseTo(PHYS.maxSlide / 2);
    expect(aim.valid).toBe(true);
  });

  it('указатель ниже руки — бросок недоступен', () => {
    const aim = aimFromPoint(THROW_ORIGIN, { x: THROW_ORIGIN.x + 50, y: THROW_ORIGIN.y + 40 });
    expect(aim.valid).toBe(false);
  });

  it('слишком слабый бросок не засчитывается', () => {
    expect(aimFromAnglePower(0, 0.03).valid).toBe(false);
  });
});

describe('физика Matter.js', () => {
  it('сақа без препятствий останавливается там, куда показывал прицел', () => {
    for (const [a, p] of [
      [0, 0.3],
      [deg(20), 0.6],
      [deg(-20), 0.7], // точка остановки внутри двора, до бордюра
    ] as const) {
      const aim = aimFromAnglePower(a, p);
      const target = landingPoint(THROW_ORIGIN, aim);
      const r = simulateThrow(emptyLevel, aim);
      expect(r.settled).toBe(true);
      expect(Math.hypot(r.sakaEnd.x - target.x, r.sakaEnd.y - target.y)).toBeLessThan(aim.slide * 0.02 + 2);
    }
  });

  it('сильный бросок в ряд выбивает асыки', () => {
    const r = simulateThrow(getLevel('kon'), aimFromAnglePower(deg(0.5), 1));
    expect(r.knocked.length).toBeGreaterThanOrEqual(1);
    expect(r.settled).toBe(true);
  });

  it('слабый бросок не долетает и ничего не выбивает', () => {
    const r = simulateThrow(getLevel('kon'), aimFromAnglePower(0, 0.3));
    expect(r.knocked.length).toBe(0);
    expect(r.sakaEnd.y).toBeGreaterThan(600);
  });

  it('полная сила достижима натяжением в пределах экрана', () => {
    const aim = aimFromPoint(THROW_ORIGIN, { x: THROW_ORIGIN.x + 300, y: THROW_ORIGIN.y - 640 });
    expect(aim.power).toBe(1);
  });

  it('результат зависит от угла броска', () => {
    const level = getLevel('warmup');
    const outcomes = new Set<string>();
    for (const a of [-17, -8.5, 0, 8.5, 17]) {
      const r = simulateThrow(level, aimFromAnglePower(deg(a), 0.95));
      outcomes.add(
        r.knocked
          .map((p) => p.id)
          .sort()
          .join(','),
      );
    }
    expect(outcomes.size).toBeGreaterThanOrEqual(3);
  });

  it('промах между асыками ничего не выбивает', () => {
    // между 3-м (x=400) и 4-м (x=510) асыком разминки свободно ~56 единиц
    const aimX = 455;
    const angle = Math.atan2(aimX - THROW_ORIGIN.x, THROW_ORIGIN.y - 430);
    const r = simulateThrow(getLevel('warmup'), aimFromAnglePower(angle, 0.9));
    expect(r.knocked.length).toBe(0);
  });

  it('один асык не засчитывается дважды', () => {
    const level = getLevel('kon');
    const world = new PhysicsWorld();
    world.addAsyks(level.asyks);
    const r = simulateThrow(level, aimFromAnglePower(0, 1), world);
    // дополнительные шаги и проверки после остановки не должны давать новых «выбиваний» тех же асыков
    const again = [];
    for (let i = 0; i < 200; i++) {
      world.step();
      again.push(...world.checkKnockouts(level.zone, 2));
    }
    const ids = r.knocked.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of again) expect(ids).not.toContain(p.id);
  });

  it('бросок в стену под углом корректно завершается', () => {
    const r = simulateThrow(emptyLevel, aimFromAnglePower(deg(70), 1));
    expect(r.settled).toBe(true);
    expect(r.sakaEnd.x).toBeGreaterThan(0);
    expect(r.sakaEnd.x).toBeLessThan(800);
  });
});
