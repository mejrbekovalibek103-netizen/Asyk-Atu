import { describe, expect, it } from 'vitest';
import { RateLimiter, StrikeCounter } from './limits';

describe('RateLimiter', () => {
  it('пропускает всплеск до ёмкости, затем отсекает и восстанавливается со временем', () => {
    let t = 0;
    const l = new RateLimiter(10, 5, () => t);
    for (let i = 0; i < 5; i++) expect(l.take()).toBe(true);
    expect(l.take()).toBe(false);
    t += 100; // +1 жетон (10/с)
    expect(l.take()).toBe(true);
    expect(l.take()).toBe(false);
    t += 10_000; // долго молчали — ёмкость ограничена
    let passed = 0;
    for (let i = 0; i < 20; i++) if (l.take()) passed++;
    expect(passed).toBe(5);
  });

  it('обычная частота (40 сообщений в секунду, лимит прицела) не отсекается', () => {
    let t = 0;
    const l = new RateLimiter(40, 25, () => t);
    for (let i = 0; i < 400; i++) {
      t += 25; // ровно 40/с
      expect(l.take()).toBe(true);
    }
  });

  it('флуд в 1000 сообщений за секунду почти весь отсекается', () => {
    let t = 0;
    const l = new RateLimiter(40, 25, () => t);
    let passed = 0;
    for (let i = 0; i < 1000; i++) {
      t += 1;
      if (l.take()) passed++;
    }
    expect(passed).toBeLessThan(80);
  });
});

describe('StrikeCounter', () => {
  it('блокирует после серии нарушений и снимает блокировку по времени', () => {
    let t = 0;
    const s = new StrikeCounter(5, 1000, 3000, () => t);
    for (let i = 0; i < 4; i++) expect(s.strike()).toBe(false);
    expect(s.strike()).toBe(true);
    expect(s.isBlocked()).toBe(true);
    t += 2999;
    expect(s.isBlocked()).toBe(true);
    t += 2;
    expect(s.isBlocked()).toBe(false);
  });

  it('remainingMs показывает, сколько блокировка ещё продлится, и обнуляется после неё', () => {
    let t = 0;
    const s = new StrikeCounter(5, 1000, 3000, () => t);
    expect(s.remainingMs()).toBe(0);
    for (let i = 0; i < 5; i++) s.strike();
    expect(s.remainingMs()).toBe(3000);
    t += 1200;
    expect(s.remainingMs()).toBe(1800);
    t += 5000;
    expect(s.remainingMs()).toBe(0);
  });

  it('редкие нарушения (вне окна) не блокируют', () => {
    let t = 0;
    const s = new StrikeCounter(5, 1000, 3000, () => t);
    for (let i = 0; i < 50; i++) {
      t += 400; // 2.5 нарушения в секунду — меньше порога
      expect(s.strike()).toBe(false);
    }
  });
});
