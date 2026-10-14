import { describe, expect, it } from 'vitest';
import { getMatchLayout } from '../levels/matchLayouts';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { REPLAY_CAPS, ThrowPlayer, type ThrowChunk } from './throwRecord';

const layout = getMatchLayout('ulken-kon');
const start = { throwIndex: 1, angle: 0, power: 0.9 };
const chunk = (seq: number, steps: number[] = [seq * 30 + 3], events: ThrowChunk['events'] = []): ThrowChunk => ({
  seq,
  frames: steps.map((s) => ({ s, b: [0, 100 + s, 400, 0] })),
  events,
});

describe('воспроизведение чужого броска: защита от подделки', () => {
  it('части «из далёкого будущего» и повторы игнорируются, память не растёт', () => {
    const p = new ThrowPlayer(start);
    p.push(chunk(REPLAY_CAPS.maxPending + 5)); // слишком далеко от ожидаемого номера
    p.push(chunk(999_999));
    expect(p.canAdvance()).toBe(false);
    p.push(chunk(0, [3, 6, 9, 12, 15, 18, 21, 24, 27, 30]));
    expect(p.canAdvance()).toBe(true);
    const before = p.canAdvance();
    p.push(chunk(0, [3])); // повтор уже применённой части
    expect(p.canAdvance()).toBe(before);
  });

  it('поток частей без «головы» не накапливается без предела', () => {
    const p = new ThrowPlayer(start);
    for (let seq = 1; seq < 5000; seq++) p.push(chunk(seq)); // нулевой нет — все ждут
    expect(p.canAdvance()).toBe(false); // ничего не применено, а лишнее отброшено
  });

  it('лавина событий обрезается до предела и не переполняет стек', () => {
    const p = new ThrowPlayer(start);
    const events = Array.from({ length: 200 }, (_, i) => ({ s: i, t: 'k', i: i % 12 }) as const);
    for (let seq = 0; seq < 60; seq++) p.push({ seq, frames: [], events });
    // всего принято не больше предела (60 × 200 = 12 000 прислано)
    let received = 0;
    const w = new PhysicsWorld();
    w.addAsyks(layout.asyks);
    w.launchSaka({ x: 400, y: 1000 }, 0, 0, 0);
    p.end({ steps: 300, final: [], saka: null });
    while (!p.done() && received < 100_000) {
      received += p.advance(w).length;
    }
    expect(received).toBeLessThanOrEqual(REPLAY_CAPS.maxEvents);
  });

  it('события, присланные не по порядку, применяются по возрастанию шага', () => {
    const p = new ThrowPlayer(start);
    p.push({ seq: 0, frames: [{ s: 1, b: [0, 10, 10, 0] }], events: [{ s: 50, t: 'k', i: 2 }, { s: 10, t: 'k', i: 1 }, { s: 30, t: 'k', i: 3 }] });
    p.end({ steps: 60, final: [], saka: null });
    const w = new PhysicsWorld();
    w.addAsyks(layout.asyks);
    w.launchSaka({ x: 400, y: 1000 }, 0, 0, 0);
    const order: number[] = [];
    while (!p.done()) for (const e of p.advance(w)) if (e.t === 'k') order.push(e.i);
    expect(order).toEqual([1, 3, 2]);
  });

  it('число шагов в итоге ограничено: бесконечное воспроизведение невозможно', () => {
    const p = new ThrowPlayer(start);
    p.end({ steps: 2_000_000_000, final: [], saka: null });
    expect(p.ended!.steps).toBe(REPLAY_CAPS.maxSteps);
    const w = new PhysicsWorld();
    w.addAsyks(layout.asyks);
    w.launchSaka({ x: 400, y: 1000 }, 0, 0, 0);
    let steps = 0;
    while (!p.done() && steps < 10_000) {
      p.advance(w);
      steps++;
    }
    expect(p.done()).toBe(true);
    expect(steps).toBeLessThanOrEqual(REPLAY_CAPS.maxSteps);
  });
});

describe('итог чужого броска не может воскресить выбитые асыки', () => {
  function world() {
    const w = new PhysicsWorld();
    w.addAsyks(layout.asyks);
    return w;
  }

  it('importAsyks(…, false) не возвращает выбитый асык, а importAsyks(…, true) возвращает', () => {
    const a = world();
    const knocked = a.pieceByIndex(3)!;
    a.markOut(knocked, 1);
    a.removePiece(knocked); // выбит и растворился
    const claim = world().exportAsyks(layout.asyks.length); // «соперник» утверждает, что все 12 в коне
    a.importAsyks(claim, layout.asyks, false);
    expect(a.pieceByIndex(3)).toBeUndefined();
    expect(a.asyksIn()).toHaveLength(11);
    a.importAsyks(claim, layout.asyks, true); // доверенный путь (вернувшийся игрок без состояния)
    expect(a.pieceByIndex(3)).toBeDefined();
  });

  it('неверные данные игнорируются: NaN, Infinity, индексы вне расстановки, координаты далеко за полем', () => {
    const a = world();
    a.importAsyks(
      [
        [0, NaN, 10, 0, 1],
        [1, 10, Infinity, 0, 1],
        [999, 10, 10, 0, 1],
        [-1, 10, 10, 0, 1],
        [2, 1e15, 1e15, 0, 1],
      ],
      layout.asyks,
      true,
    );
    for (const p of a.pieces) {
      expect(Number.isFinite(p.body.position.x)).toBe(true);
      expect(Number.isFinite(p.body.position.y)).toBe(true);
      expect(Math.abs(p.body.position.x)).toBeLessThan(1000);
      expect(Math.abs(p.body.position.y)).toBeLessThan(1500);
    }
    expect(a.pieceByIndex(999)).toBeUndefined();
  });
});
