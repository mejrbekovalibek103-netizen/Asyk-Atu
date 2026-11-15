import { describe, expect, it } from 'vitest';
import { PHYS, THROW_JITTER } from '../config';
import { speedForDistance } from '../physics/friction';
import { aimFromAnglePower, throwParams, type Aim } from '../physics/aim';
import { sfc32 } from './rng';

const seed = (k: number) => Uint8Array.from({ length: 16 }, (_, i) => (i * 31 + k * 7) & 255);

/** throwParams до появления множителя разброса — эталон для обычного режима. */
function legacyThrowParams(aim: Aim, rng: () => number, jitter: boolean) {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const gaussian = () => {
    const u = Math.max(1e-9, rng());
    const v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const sigma = THROW_JITTER.angleMin + (THROW_JITTER.angleMax - THROW_JITTER.angleMin) * aim.power;
  const dAngle = jitter ? clamp(gaussian() * sigma, -2.5 * sigma, 2.5 * sigma) : 0;
  const dPower = jitter ? (rng() * 2 - 1) * THROW_JITTER.power : 0;
  const slide = clamp(aim.slide * (1 + dPower), PHYS.minSlide, PHYS.maxSlide * 1.02);
  return { angle: aim.angle + dAngle, speed: speedForDistance(slide, PHYS.decel.saka), spin: jitter ? (rng() * 2 - 1) * 0.008 : 0 };
}

describe('множитель разброса руки', () => {
  it('обычный режим (jitterScale = 1 или по умолчанию) — ровно те же числа, что раньше', () => {
    for (let k = 0; k < 300; k++) {
      const aim = aimFromAnglePower(((k % 157) - 78) * (Math.PI / 180), 0.08 + (k % 93) / 100);
      const ref = legacyThrowParams(aim, sfc32(seed(k)), true);
      expect(throwParams(aim, sfc32(seed(k)), true)).toEqual(ref);
      expect(throwParams(aim, sfc32(seed(k)), true, 1)).toEqual(ref);
      expect(throwParams(aim, sfc32(seed(k)), false, 2)).toEqual(legacyThrowParams(aim, sfc32(seed(k)), false));
    }
  });

  it('×2: отклонение угла и силы ровно вдвое больше при тех же случайных числах', () => {
    for (let k = 0; k < 200; k++) {
      const aim = aimFromAnglePower(0.1, 0.5 + (k % 40) / 100); // без упора в пределы силы
      const one = throwParams(aim, sfc32(seed(k)), true, 1);
      const two = throwParams(aim, sfc32(seed(k)), true, 2);
      expect(two.angle - aim.angle).toBeCloseTo(2 * (one.angle - aim.angle), 12);
      expect(two.spin).toBe(one.spin); // вращение не меняется
    }
  });

  it('×2 не выводит бросок за пределы, которые принимает клиент', () => {
    const rng = sfc32(seed(99));
    for (let i = 0; i < 2000; i++) {
      const p = throwParams(aimFromAnglePower((rng() * 2 - 1) * PHYS.maxAimAngle, rng()), rng, true, 2);
      expect(Math.abs(p.angle)).toBeLessThan(1.5);
      expect(p.speed).toBeGreaterThan(0);
      expect(p.speed).toBeLessThanOrEqual(speedForDistance(PHYS.maxSlide * 1.04, PHYS.decel.saka) + 1e-9);
    }
  });
});
