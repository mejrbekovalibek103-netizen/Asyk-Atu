import { describe, expect, it } from 'vitest';
import { PHYS, THROW_ORIGIN } from '../config';
import { getMatchLayout } from '../levels/matchLayouts';
import { aimFromAnglePower, throwParams } from '../physics/aim';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { ThrowPlayer, ThrowRecorder, type ThrowChunk, type ThrowEnd } from './throwRecord';

const layout = getMatchLayout('ulken-kon');

/** Бросок на «устройстве бросающего»: настоящая физика + запись. */
function recordThrow(world: PhysicsWorld, angleDeg: number, power: number) {
  const p = throwParams(aimFromAnglePower((angleDeg * Math.PI) / 180, power), Math.random, false);
  world.launchSaka(THROW_ORIGIN, p.angle, p.speed, p.spin);
  const rec = new ThrowRecorder(world);
  const chunks: ThrowChunk[] = [];
  const knocked: number[] = [];
  let settled = 0;
  for (let ms = 0; ms < PHYS.maxThrowMs; ms += PHYS.stepMs) {
    world.step();
    const out = world.checkKnockouts(layout.zone, 1);
    knocked.push(...out.map((x) => x.index));
    const c = rec.onStep(world.drainContacts(), out);
    if (c) chunks.push(c);
    settled = world.isSettled() ? settled + PHYS.stepMs : 0;
    if (settled >= PHYS.settleMs) break;
  }
  const { chunk, end } = rec.finish(layout.asyks.length);
  chunks.push(chunk);
  return { chunks, end, knocked, angle: p.angle };
}

/** Воспроизведение на «устройстве соперника» (без физики). */
function replay(world: PhysicsWorld, chunks: ThrowChunk[], end: ThrowEnd, angle: number, order?: number[]) {
  const player = new ThrowPlayer({ throwIndex: 1, angle, power: 1 });
  world.launchSaka(THROW_ORIGIN, angle, 0, 0);
  const seq = order ?? chunks.map((_, i) => i);
  for (const i of seq) player.push(chunks[i]);
  player.end(end);
  const knocked: number[] = [];
  let guard = 0;
  while (!player.done() && guard++ < 100000) {
    if (!player.canAdvance()) break;
    for (const e of player.advance(world)) {
      if (e.t === 'k') {
        const p = world.pieceByIndex(e.i);
        if (p && world.markOut(p, 1)) knocked.push(e.i);
      }
    }
  }
  return { player, knocked };
}

describe('запись и воспроизведение броска', () => {
  it('у соперника выбиты те же асыки, и кон после итогового состояния совпадает', () => {
    const a = new PhysicsWorld();
    a.addAsyks(layout.asyks);
    const rec = recordThrow(a, 2, 0.95);
    expect(rec.knocked.length).toBeGreaterThan(0);

    const b = new PhysicsWorld();
    b.addAsyks(layout.asyks);
    const { player, knocked } = replay(b, rec.chunks, rec.end, rec.angle);
    expect(player.done()).toBe(true);
    expect(knocked.sort()).toEqual(rec.knocked.sort());

    // до «защёлкивания» итогового состояния тела уже почти на местах
    for (const [i, x, y, , inZone] of rec.end.final) {
      if (!inZone) continue;
      const p = b.pieceByIndex(i)!;
      expect(Math.hypot(p.body.position.x - x, p.body.position.y - y)).toBeLessThan(1.5);
    }
    b.importAsyks(rec.end.final, layout.asyks);
    expect(b.exportAsyks(layout.asyks.length)).toEqual(a.exportAsyks(layout.asyks.length));
  });

  it('части записи, пришедшие не по порядку, применяются правильно', () => {
    const a = new PhysicsWorld();
    a.addAsyks(layout.asyks);
    const rec = recordThrow(a, -6, 1);
    expect(rec.chunks.length).toBeGreaterThan(2);
    const shuffled = rec.chunks.map((_, i) => i).reverse();
    const b = new PhysicsWorld();
    b.addAsyks(layout.asyks);
    const { player, knocked } = replay(b, rec.chunks, rec.end, rec.angle, shuffled);
    expect(player.done()).toBe(true);
    expect(knocked.sort()).toEqual(rec.knocked.sort());
  });

  it('без данных воспроизведение ждёт, а не «проскакивает»', () => {
    const a = new PhysicsWorld();
    a.addAsyks(layout.asyks);
    const rec = recordThrow(a, 0, 0.9);
    const b = new PhysicsWorld();
    b.addAsyks(layout.asyks);
    const player = new ThrowPlayer({ throwIndex: 1, angle: rec.angle, power: 0.9 });
    expect(player.canAdvance()).toBe(false); // ничего не пришло
    player.push(rec.chunks[1]); // пришла вторая часть раньше первой — всё ещё ждём
    expect(player.canAdvance()).toBe(false);
    player.push(rec.chunks[0]);
    expect(player.canAdvance()).toBe(true);
  });

  it('запись компактная — помещается в сообщение реального времени', () => {
    const a = new PhysicsWorld();
    a.addAsyks(layout.asyks);
    const rec = recordThrow(a, 1, 1);
    const bytes = JSON.stringify(rec.chunks).length + JSON.stringify(rec.end).length;
    expect(bytes).toBeLessThan(60_000);
    for (const c of rec.chunks) expect(JSON.stringify(c).length).toBeLessThan(20_000);
  });

  it('синхронизация кона: выбитые убираются, недостающие возвращаются', () => {
    const a = new PhysicsWorld();
    a.addAsyks(layout.asyks);
    recordThrow(a, 0, 1);
    const state = a.exportAsyks(layout.asyks.length);
    const b = new PhysicsWorld();
    b.addAsyks(layout.asyks);
    b.importAsyks(state, layout.asyks);
    expect(b.exportAsyks(layout.asyks.length)).toEqual(state);
    // и обратно: в «a» вернём исходную расстановку
    const fresh = new PhysicsWorld();
    fresh.addAsyks(layout.asyks);
    a.importAsyks(fresh.exportAsyks(layout.asyks.length), layout.asyks);
    expect(a.asyksIn().length).toBe(layout.asyks.length);
  });
});
