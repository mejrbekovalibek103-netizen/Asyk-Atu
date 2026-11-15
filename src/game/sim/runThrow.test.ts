import Matter from 'matter-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseThrowChunk, parseThrowEnd, parseThrowStart } from '../../net/validate';
import { PHYS, THROW_ORIGIN } from '../config';
import { getLevel } from '../levels/levels';
import { getMatchLayout, getStakeLayout, STAKE_LAYOUT_IDS } from '../levels/matchLayouts';
import { aimFromAnglePower, throwParams, type ThrowParams } from '../physics/aim';
import { PhysicsWorld, type AsykState } from '../physics/PhysicsWorld';
import { simulateThrow } from '../physics/simulate';
import { ThrowPlayer } from '../replay/throwRecord';
import type { KonLayout, LevelConfig } from '../types';
import { zoneContains } from '../levels/zone';
import { keepInZone, runThrow } from './runThrow';

const deg = (d: number) => (d * Math.PI) / 180;
const exact = (angleDeg: number, power: number): ThrowParams => throwParams(aimFromAnglePower(deg(angleDeg), power), Math.random, false);

function buildWorld(layout: KonLayout, kon: AsykState[] | null = null): PhysicsWorld {
  const w = new PhysicsWorld();
  w.addObstacles(layout.obstacles ?? []);
  w.addAsyks(layout.asyks);
  if (kon) w.importAsyks(kon, layout.asyks, true);
  return w;
}

/**
 * Прежний simulate.ts (до runThrow) — эталон: без drainContacts/removeFaded и со своей страховкой по времени.
 * Бросок без разброса должен выбивать те же асыки.
 */
function legacySimulate(layout: KonLayout, params: ThrowParams, w: PhysicsWorld): number[] {
  w.launchSaka(THROW_ORIGIN, params.angle, params.speed, params.spin);
  const knocked: number[] = [];
  let settledFor = 0;
  let t = 0;
  while (t < PHYS.maxThrowMs) {
    w.step();
    t += PHYS.stepMs;
    knocked.push(...w.checkKnockouts(layout.zone, 1).map((p) => p.index));
    if (w.isSettled()) {
      settledFor += PHYS.stepMs;
      if (settledFor >= PHYS.settleMs) break;
    } else {
      settledFor = 0;
    }
  }
  return knocked;
}

/** Помехи между бросками: другие миры, броски в них, другие runThrow — на результат влиять не должны. */
function noise(k: number): void {
  const w = buildWorld(getMatchLayout('korgan'));
  for (let i = 0; i < k % 3; i++) w.step();
  if (k % 4 === 0) simulateThrow({ ...getLevel('kon') }, aimFromAnglePower(deg(k % 7), 0.9));
  if (k % 5 === 0) runThrow(getStakeLayout('stake-ring', 3), null, exact(-(k % 11), 0.8), 2);
  if (k % 2 === 0) w.destroy(); // а иногда мир так и остаётся жить
}

describe('runThrow: детерминизм', () => {
  afterEach(() => vi.restoreAllMocks());

  for (const id of STAKE_LAYOUT_IDS) {
    it(`${id}: один и тот же вход → один и тот же результат 200 раз, вперемешку с другими мирами`, () => {
      const layout = getStakeLayout(id, 2);
      const first = runThrow(layout, null, exact(0, 1), 1, 1);
      const kon = first.final;
      const params = throwParams(aimFromAnglePower(deg(4), 0.93), sequence(0.31, 0.77, 0.12), true, 2);
      const ref = JSON.stringify(runThrow(layout, kon, params, 2, 0.93));
      for (let k = 0; k < 200; k++) {
        noise(k);
        expect(JSON.stringify(runThrow(layout, kon, params, 2, 0.93))).toBe(ref);
      }
    });
  }

  it('мир уничтожается всегда, счётчик id Matter не откатывается назад', () => {
    const destroy = vi.spyOn(PhysicsWorld.prototype, 'destroy');
    const ids = Matter.Common as unknown as { _nextId: number };
    ids._nextId = 5_000;
    runThrow(getStakeLayout('stake-line', 2), null, exact(0, 1), 1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(ids._nextId).toBe(5_000);
    // даже если бросок упал с ошибкой
    const bad = { ...getStakeLayout('stake-line', 2), zone: null as unknown as KonLayout['zone'] };
    expect(() => runThrow(bad, null, exact(0, 1), 1)).toThrow();
    expect(destroy).toHaveBeenCalledTimes(2);
  });
});

/** Детерминированные «случайные» числа по кругу. */
function sequence(...xs: number[]): () => number {
  let i = 0;
  return () => xs[i++ % xs.length];
}

describe('runThrow: «золотые» результаты (меняются — поднять SIM_VERSION)', () => {
  it('Линия на двоих: три броска подряд', () => {
    const layout = getStakeLayout('stake-line', 2);
    const a = runThrow(layout, null, exact(0, 1), 1, 1);
    const b = runThrow(layout, a.final, exact(6, 1), 2, 1);
    const c = runThrow(layout, b.final, exact(-10, 1), 3, 1);
    expect([a.knocked, b.knocked, c.knocked]).toEqual([[4, 5], [6], [3, 2]]);
    expect([a.steps, b.steps, c.steps]).toEqual([106, 130, 107]);
  });

  it('Кольцо на двоих: три броска подряд', () => {
    const layout = getStakeLayout('stake-ring', 2);
    const a = runThrow(layout, null, exact(0, 1), 1, 1);
    const b = runThrow(layout, a.final, exact(6, 1), 2, 1);
    const c = runThrow(layout, b.final, exact(-10, 1), 3, 1);
    expect([a.knocked, b.knocked, c.knocked]).toEqual([[0], [4, 5], [9]]);
  });
});

describe('runThrow: совпадает с прежней симуляцией (simulate.ts) без разброса', () => {
  const layouts: KonLayout[] = [...STAKE_LAYOUT_IDS.map((id) => getStakeLayout(id, 2)), getStakeLayout('stake-scatter', 4), getMatchLayout('ulken-kon'), getMatchLayout('qaqpa-big')];
  for (const layout of layouts) {
    it(`${layout.name} (${layout.asyks.length}): выбиты те же асыки`, () => {
      let kon: AsykState[] | null = null;
      for (const [a, p] of [[0, 1], [-14, 0.9], [9, 0.75], [22, 1], [-3, 0.6], [35, 1]] as const) {
        const params = exact(a, p);
        const legacyWorld = buildWorld(layout, kon);
        const legacy = legacySimulate(layout, params, legacyWorld);
        legacyWorld.destroy();
        const r = runThrow(layout, kon, params, 1);
        expect(r.knocked, `${a}° ${p}`).toEqual(legacy);
        // и обёртка simulateThrow даёт то же самое
        const level: LevelConfig = { ...layout, order: 0, hint: '', throws: 1, goal: { type: 'knockout', count: 1 }, stars: [{ type: 'cleared' }, { type: 'cleared' }] };
        expect(simulateThrow(level, aimFromAnglePower(deg(a), p), buildWorld(layout, kon)).knocked.map((x) => x.index)).toEqual(legacy);
        kon = r.final;
      }
    });
  }
});

describe('runThrow: запись в формате обычного онлайна', () => {
  const layout = getStakeLayout('stake-scatter', 2);
  const params = exact(3, 1);
  const r = runThrow(layout, null, params, 7, 1);

  it('начало, части и конец проходят проверки клиента (net/validate)', () => {
    expect(parseThrowStart(r.start)).toEqual({ throwIndex: 7, angle: params.angle, power: 1 });
    r.chunks.forEach((c, k) => {
      expect(c.seq).toBe(k);
      expect(parseThrowChunk(JSON.parse(JSON.stringify(c)))).toEqual(c);
    });
    expect(parseThrowEnd(JSON.parse(JSON.stringify(r.end)))).toEqual(r.end);
    expect(r.final).toBe(r.end.final);
    expect(r.steps).toBe(r.end.steps);
    expect(r.final).toHaveLength(layout.asyks.length);
    expect(r.settled).toBe(true);
  });

  it('knocked = асыки, ставшие выбитыми, и события «k» записи', () => {
    const events = r.chunks.flatMap((c) => c.events).filter((e) => e.t === 'k').map((e) => (e.t === 'k' ? e.i : -1));
    expect(events).toEqual(r.knocked);
    const out = r.final.filter((s) => s[4] === 0).map((s) => s[0]);
    expect([...out].sort()).toEqual([...r.knocked].sort());
    expect(r.knocked.length).toBeGreaterThan(0);
  });

  it('движок соперника проигрывает запись и приходит к тому же кону', () => {
    const player = new ThrowPlayer(r.start);
    for (const c of [...r.chunks].reverse()) player.push(c); // части могут прийти не по порядку
    player.end(r.end);
    const w = buildWorld(layout);
    w.launchSaka(THROW_ORIGIN, r.start.angle, 0, 0);
    const knocked: number[] = [];
    let guard = 0;
    while (!player.done() && guard++ < 5_000) {
      for (const e of player.advance(w)) if (e.t === 'k') knocked.push(e.i);
    }
    expect(player.done()).toBe(true);
    expect(knocked).toEqual(r.knocked);
    w.importAsyks(r.end.final, layout.asyks, false);
    expect(w.exportAsyks(layout.asyks.length)).toEqual(r.final);
    w.destroy();
  });

  it('выбитые до броска асыки остаются выбитыми и не попадают в knocked', () => {
    const next = runThrow(layout, r.final, exact(-8, 1), 8, 1);
    for (const i of r.knocked) {
      expect(next.final[i]).toEqual([i, 0, 0, 0, 0]);
      expect(next.knocked).not.toContain(i);
    }
  });
});

describe('keepInZone: округление итога не выносит асык за линию', () => {
  const ring = { kind: 'circle', cx: 400, cy: 430, r: 212 } as const;
  const rect = { kind: 'rect', x: 100 + 1 / 12, y: 300 - 1 / 12, w: 500, h: 200 } as const;
  const onGrid = (v: number) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9;

  it('асык внутри и выбитые не трогаются', () => {
    const states: AsykState[] = [
      [0, 400, 430, 0.5, 1],
      [1, 0, 0, 0, 0],
      [2, 611.99, 430, -1.2, 1],
    ];
    expect(keepInZone(ring, states)).toEqual(states);
  });

  it('Кольцо: точка чуть за линией подтягивается внутрь по сетке 0,01, угол сохраняется', () => {
    // 211,998 от центра под 45° → после округления до 0,01 оказывается снаружи
    const d = 211.998 / Math.SQRT2;
    const x = Math.round((400 + d) * 100) / 100;
    const y = Math.round((430 + d) * 100) / 100;
    expect(zoneContains(ring, { x, y })).toBe(false);
    const [s] = keepInZone(ring, [[0, x, y, 0.25, 1]]);
    expect(zoneContains(ring, { x: s[1], y: s[2] })).toBe(true);
    expect(onGrid(s[1]) && onGrid(s[2])).toBe(true);
    expect(Math.hypot(s[1] - x, s[2] - y)).toBeLessThan(0.05);
    expect(s[3]).toBe(0.25);
    expect(s[4]).toBe(1);
  });

  it('Рассыпь: граница не по сетке 0,01 — со всех сторон', () => {
    const left = Math.round(rect.x * 100 - 1) / 100; // 100,07 < 100,0833…
    const top = Math.round(rect.y * 100 - 1) / 100;
    const right = Math.round((rect.x + rect.w) * 100 + 1) / 100;
    const bottom = Math.round((rect.y + rect.h) * 100 + 1) / 100;
    const out = keepInZone(rect, [
      [0, left, 400, 0, 1],
      [1, 300, top, 0, 1],
      [2, right, bottom, 0, 1],
    ]);
    for (const s of out) {
      expect(zoneContains(rect, { x: s[1], y: s[2] })).toBe(true);
      expect(onGrid(s[1]) && onGrid(s[2])).toBe(true);
    }
  });

  it('итог runThrow: каждый асык «в коне» стоит внутри линии', () => {
    for (const id of STAKE_LAYOUT_IDS) {
      const layout = getStakeLayout(id, 2);
      let kon: AsykState[] | null = null;
      for (let k = 0; k < 6; k++) {
        const r = runThrow(layout, kon, exact(-20 + k * 8, 0.6 + k * 0.07), k + 1, 1);
        for (const s of r.final) if (s[4] === 1) expect(zoneContains(layout.zone, { x: s[1], y: s[2] })).toBe(true);
        expect(r.end.final).toBe(r.final);
        kon = r.final;
      }
    }
  });
});
