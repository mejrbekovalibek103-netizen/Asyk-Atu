import { describe, expect, it } from 'vitest';
import { hexToBytes, sfc32 } from './rng';

const bytes = (fill: (i: number) => number, n = 16) => Uint8Array.from({ length: n }, (_, i) => fill(i) & 255);
const take = (rng: () => number, n: number) => Array.from({ length: n }, () => rng());

describe('генератор sfc32', () => {
  it('одно зерно — одна и та же последовательность', () => {
    const seed = bytes((i) => i * 17 + 3, 32);
    expect(take(sfc32(seed), 500)).toEqual(take(sfc32(seed), 500));
    // копия байтов — тот же результат: генератор не зависит от самого объекта
    expect(take(sfc32(Uint8Array.from(seed)), 50)).toEqual(take(sfc32(seed), 50));
  });

  it('разные зёрна — разные последовательности (даже при отличии в одном бите)', () => {
    const a = bytes((i) => i);
    const b = bytes((i) => (i === 15 ? i ^ 1 : i));
    const sa = take(sfc32(a), 20);
    const sb = take(sfc32(b), 20);
    expect(sa).not.toEqual(sb);
    expect(sa.filter((v, k) => v === sb[k]).length).toBeLessThan(2);
  });

  it('учитываются только первые 16 байт', () => {
    const a = bytes((i) => i, 32);
    const b = Uint8Array.from(a);
    b[20] = 99;
    expect(take(sfc32(a), 10)).toEqual(take(sfc32(b), 10));
  });

  it('числа в [0, 1) и распределены ровно', () => {
    const rng = sfc32(bytes(() => 0)); // даже из нулей — после разогрева нормальная последовательность
    const xs = take(rng, 20_000);
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.01);
    const bins = new Array(10).fill(0);
    for (const x of xs) bins[Math.floor(x * 10)] += 1;
    for (const c of bins) expect(Math.abs(c - 2000)).toBeLessThan(200);
  });

  it('закреплённые числа: последовательность не меняется между версиями (иначе нужен новый SIM_VERSION)', () => {
    const rng = sfc32(bytes((i) => i + 1));
    const first = take(rng, 3).map((v) => Math.round(v * 4294967296));
    expect(first).toEqual(GOLDEN_SFC32);
  });

  it('меньше 16 байт — ошибка', () => {
    expect(() => sfc32(new Uint8Array(15))).toThrow();
  });
});

describe('hexToBytes', () => {
  it('разбирает hex в любом регистре и с префиксами «\\x» и «0x»', () => {
    expect([...hexToBytes('00ff10Ab')]).toEqual([0, 255, 16, 171]);
    expect([...hexToBytes('\\x00ff')]).toEqual([0, 255]);
    expect([...hexToBytes('0x0102')]).toEqual([1, 2]);
    expect(hexToBytes('').length).toBe(0);
  });

  it('неверная строка — ошибка', () => {
    for (const bad of ['abc', 'zz', '0g', ' 00', '00 ', '\\x0', '-1']) expect(() => hexToBytes(bad), bad).toThrow();
    expect(() => hexToBytes(42 as unknown as string)).toThrow();
  });
});

/** Первые три 32-битных числа sfc32 для зерна 01 02 … 10 (после разогрева). */
const GOLDEN_SFC32 = [1560914350, 1608738038, 3005185132];
