import { aimFromAnglePower } from '../physics/aim';
import { PhysicsWorld, type AsykState } from '../physics/PhysicsWorld';
import { simulateThrow } from '../physics/simulate';
import type { KonLayout, LevelConfig } from '../types';

/**
 * Решатель уровней для тестов: перебирает броски (угол × сила) поиском по лучу (beam search) и находит,
 * за сколько бросков можно очистить кон. Это верхняя оценка минимума (идеальный игрок без разброса руки):
 * если решатель не очистил кон, уровень, скорее всего, непроходим на 3★; если очистил за N бросков,
 * живому игроку нужен запас сверх N.
 *
 * Не входит в игру: используется только тестами и подбором уровней.
 */

export interface Shot {
  /** Градусы от направления «вперёд» (−78…78). */
  angle: number;
  power: number;
  /** Сколько асыков этот бросок выбил. */
  knocked: number;
}

export interface SolveOptions {
  /** Сколько бросков максимум. */
  maxThrows: number;
  angles?: number[];
  powers?: number[];
  /** Сколько состояний держим на каждом шаге. */
  width?: number;
  /** Сколько лучших исходов берём из каждого состояния. */
  branch?: number;
  /** Начать не с исходной расстановки, а с этого состояния кона (например, в середине раунда). */
  start?: AsykState[];
  /** Что считать решением: очистить весь кон (по умолчанию) или выбить синий асык. */
  goal?: 'clear' | 'target';
}

export const DEFAULT_ANGLES = Array.from({ length: 79 }, (_, i) => -78 + i * 2);
export const DEFAULT_POWERS = [0.5, 0.65, 0.8, 1];

/**
 * Настройки поиска для проверки уровней. «Тонкая» сетка находит точные решения (шаг 2° в основной зоне),
 * «грубая» — только такие, где бросок допускает ошибку около ±1,5°: уровень, который решается на грубой сетке,
 * не требует ювелирной точности. Поиск детерминирован: одни и те же настройки дают один и тот же результат.
 */
export const SOLVER_FINE: Omit<SolveOptions, 'maxThrows'> = {
  angles: [-60, -52, -46, ...Array.from({ length: 41 }, (_, i) => -40 + 2 * i), 46, 52, 60],
  powers: [0.6, 0.8, 1],
  width: 5,
  branch: 3,
};
export const SOLVER_COARSE: Omit<SolveOptions, 'maxThrows'> = {
  angles: Array.from({ length: 41 }, (_, i) => -60 + 3 * i),
  powers: [0.8, 1],
  width: 4,
  branch: 3,
};

/** Минимальное число бросков, за которое нашлось решение на тонкой или грубой сетке (null — не нашлось за maxThrows). */
export function minThrowsToClear(layout: KonLayout, maxThrows: number): { fine: number | null; coarse: number | null } {
  return {
    fine: solveClear(layout, { ...SOLVER_FINE, maxThrows })?.length ?? null,
    coarse: solveClear(layout, { ...SOLVER_COARSE, maxThrows })?.length ?? null,
  };
}

function asLevel(layout: KonLayout, throws: number): LevelConfig {
  return { ...layout, order: 0, hint: '', throws, goal: { type: 'knockout', count: 1 }, stars: [{ type: 'cleared' }, { type: 'cleared' }] };
}

function worldFrom(layout: KonLayout, snapshot?: AsykState[]): PhysicsWorld {
  const w = new PhysicsWorld();
  w.addObstacles(layout.obstacles ?? []);
  w.addAsyks(layout.asyks);
  if (snapshot) w.importAsyks(snapshot, layout.asyks);
  return w;
}

interface Node {
  snap: AsykState[];
  left: number;
  shots: Shot[];
}

const remainingKey = (snap: AsykState[]) => snap.map((s) => s[4]).join('');

/** Ищет последовательность бросков, очищающую кон. Возвращает её или null, если за `maxThrows` не нашлось. */
export function solveClear(layout: KonLayout, opts: SolveOptions): Shot[] | null {
  const angles = opts.angles ?? DEFAULT_ANGLES;
  const powers = opts.powers ?? DEFAULT_POWERS;
  const width = opts.width ?? 6;
  const branch = opts.branch ?? 4;
  const n = layout.asyks.length;
  const level = asLevel(layout, opts.maxThrows);

  const startSnap = opts.start ?? worldFrom(layout).exportAsyks(n);
  const targetIdx = opts.goal === 'target' ? layout.asyks.findIndex((a) => a.kind === 'target') : -1;
  const solved = (snap: AsykState[], left: number) => (targetIdx >= 0 ? snap[targetIdx][4] === 0 : left === 0);
  let frontier: Node[] = [{ snap: startSnap, left: startSnap.filter((s) => s[4] === 1).length, shots: [] }];
  for (let depth = 1; depth <= opts.maxThrows; depth++) {
    const next: Node[] = [];
    for (const node of frontier) {
      const outcomes = new Map<string, Node>();
      for (const angle of angles) {
        for (const power of powers) {
          const w = worldFrom(layout, node.snap);
          const r = simulateThrow(level, aimFromAnglePower((angle * Math.PI) / 180, power), w);
          w.removeSaka();
          const snap = w.exportAsyks(n);
          const left = snap.filter((s) => s[4] === 1).length;
          const shots = [...node.shots, { angle, power, knocked: r.knocked.length }];
          if (solved(snap, left)) return shots;
          const key = remainingKey(snap);
          const prev = outcomes.get(key);
          if (!prev) outcomes.set(key, { snap, left, shots });
        }
      }
      next.push(...[...outcomes.values()].sort((a, b) => a.left - b.left).slice(0, branch));
    }
    // разнообразие: из состояний с одним набором асыков оставляем одно
    const seen = new Set<string>();
    frontier = next
      .sort((a, b) => a.left - b.left)
      .filter((nd) => {
        const k = remainingKey(nd.snap);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, width);
    if (!frontier.length) return null;
  }
  return null;
}

/** Лучшее, что нашлось за `maxThrows`: сколько асыков осталось в коне у самого успешного состояния. */
export function bestLeft(layout: KonLayout, opts: SolveOptions): number {
  const angles = opts.angles ?? DEFAULT_ANGLES;
  const powers = opts.powers ?? DEFAULT_POWERS;
  const n = layout.asyks.length;
  const level = asLevel(layout, opts.maxThrows);
  let frontier: { snap: AsykState[]; left: number }[] = [{ snap: worldFrom(layout).exportAsyks(n), left: n }];
  let best = n;
  for (let depth = 1; depth <= opts.maxThrows; depth++) {
    const next = new Map<string, { snap: AsykState[]; left: number }>();
    for (const node of frontier) {
      for (const angle of angles) {
        for (const power of powers) {
          const w = worldFrom(layout, node.snap);
          simulateThrow(level, aimFromAnglePower((angle * Math.PI) / 180, power), w);
          w.removeSaka();
          const snap = w.exportAsyks(n);
          const left = snap.filter((s) => s[4] === 1).length;
          best = Math.min(best, left);
          const k = remainingKey(snap);
          if (!next.has(k)) next.set(k, { snap, left });
        }
      }
    }
    frontier = [...next.values()].sort((a, b) => a.left - b.left).slice(0, opts.width ?? 6);
  }
  return best;
}
