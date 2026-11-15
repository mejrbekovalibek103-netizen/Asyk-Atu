import Matter from 'matter-js';
import { KNOCKOUT_FADE_MS, PHYS, THROW_ORIGIN } from '../config';
import type { ThrowParams } from '../physics/aim';
import { PhysicsWorld, type AsykState, type Piece } from '../physics/PhysicsWorld';
import { ThrowRecorder, type ThrowChunk, type ThrowEnd, type ThrowStart } from '../replay/throwRecord';
import { zoneCenter, zoneContains } from '../levels/zone';
import type { KonLayout, Zone } from '../types';

/**
 * Один бросок без рендера и без часов — чистая детерминированная функция.
 *
 * Цикл повторяет GameEngine.fixedStep во время броска: step → drainContacts → removeFaded → checkKnockouts →
 * запись шага → «всё стоит PHYS.settleMs» или страховка PHYS.maxThrowMs (stopAll). Поэтому сервер (Edge Function
 * соревновательного режима) считает бросок тем же кодом, что и игра, а запись проигрывается движком так же,
 * как бросок соперника в обычном онлайне (remoteThrowStart / remoteThrowChunk / remoteThrowEnd).
 */

export interface PlayResult {
  /** Асыки, выбитые этим броском, в порядке выбивания. */
  knocked: Piece[];
  /** Сколько шагов физики длился бросок. */
  steps: number;
  /** Время броска в мс симуляции. */
  durationMs: number;
  /** true — всё остановилось само; false — сработала страховка maxThrowMs. */
  settled: boolean;
  /** Запись броска (если её просили). */
  record: { chunks: ThrowChunk[]; end: ThrowEnd } | null;
}

/** Выбитые асыки растворяются и удаляются из мира (как GameEngine.removeFaded). */
export function removeFaded(world: PhysicsWorld): void {
  for (const p of [...world.pieces]) {
    if (p.status === 'out' && p.outAt !== null && world.time - p.outAt > KNOCKOUT_FADE_MS) world.removePiece(p);
  }
}

/**
 * Запускает сақа в уже собранном мире и считает бросок до остановки. Мир не уничтожается — им распоряжается
 * вызывающий (simulateThrow отдаёт его решателю и тестам).
 * @param recordAsyks число асыков расстановки — тогда бросок записывается (ThrowRecorder); null — без записи
 */
export function playThrow(world: PhysicsWorld, zone: Zone, params: ThrowParams, throwNo: number, recordAsyks: number | null = null): PlayResult {
  world.launchSaka(THROW_ORIGIN, params.angle, params.speed, params.spin);
  const launchedAt = world.time;
  // как в GameEngine.launch: запись начинается сразу после запуска сақа (первый кадр — все тела)
  const recorder = recordAsyks === null ? null : new ThrowRecorder(world);
  const chunks: ThrowChunk[] = [];
  const knocked: Piece[] = [];
  let settledFor = 0;
  let steps = 0;
  let settled = false;
  for (;;) {
    world.step();
    steps += 1;
    const contacts = world.drainContacts();
    removeFaded(world);
    const out = world.checkKnockouts(zone, throwNo);
    knocked.push(...out);
    if (recorder) {
      const chunk = recorder.onStep(contacts, out);
      if (chunk) chunks.push(chunk);
    }
    if (world.isSettled()) {
      settledFor += PHYS.stepMs;
      if (settledFor >= PHYS.settleMs) {
        settled = true;
        break;
      }
    } else {
      settledFor = 0;
    }
    if (world.time - launchedAt > PHYS.maxThrowMs) {
      world.stopAll();
      break;
    }
  }
  let record: PlayResult['record'] = null;
  if (recorder && recordAsyks !== null) {
    const { chunk, end } = recorder.finish(recordAsyks);
    chunks.push(chunk);
    record = { chunks, end };
  }
  return { knocked, steps, durationMs: world.time - launchedAt, settled, record };
}

/** Результат серверного броска: запись в формате обычного онлайна и итог кона. */
export interface ThrowRun {
  start: ThrowStart;
  /** Части записи по порядку (seq 0, 1, …), последняя — из ThrowRecorder.finish. */
  chunks: ThrowChunk[];
  end: ThrowEnd;
  /** Слоты (= индексы асыков в раскладке, Piece.index), выбитые этим броском, в порядке выбивания. */
  knocked: number[];
  /** = end.steps. */
  steps: number;
  /** Всё остановилось само (false — страховка maxThrowMs). */
  settled: boolean;
  /** Состояние кона после броска (= end.final): ровно по записи на каждый асык раскладки, округлено как в записи;
   *  асыки «в коне» гарантированно внутри линии (keepInZone). */
  final: AsykState[];
}

/**
 * Итог кона пишется с округлением до 0,01 (exportAsyks), а линия кона не всегда лежит на этой сетке (Кольцо,
 * Рассыпь). Асык, стоявший у самой линии, после округления мог оказаться за ней — и следующий бросок «выбил» бы
 * его на первом же шаге, хотя его никто не касался. Такую точку двигаем к центру кона по шагу 0,01, пока она
 * не окажется внутри. Сдвиг — доли сотой: на глаз и на физику не влияет.
 */
export function keepInZone(zone: Zone, states: AsykState[]): AsykState[] {
  const c = zoneCenter(zone);
  return states.map((s) => {
    const [i, x, y, a, inZone] = s;
    if (inZone !== 1 || zoneContains(zone, { x, y })) return s;
    // считаем в сотых долях целыми числами, чтобы не накапливать ошибку дробей
    let xi = Math.round(x * 100);
    let yi = Math.round(y * 100);
    const cx = c.x * 100;
    const cy = c.y * 100;
    // страховка от вечного цикла; на деле хватает одного-двух шагов
    for (let k = 0; k < 1_000 && !zoneContains(zone, { x: xi / 100, y: yi / 100 }); k++) {
      if (Math.abs(cx - xi) >= 1) xi += Math.sign(cx - xi);
      if (Math.abs(cy - yi) >= 1) yi += Math.sign(cy - yi);
    }
    return [i, xi / 100, yi / 100, a, 1];
  });
}

/** Глобальный счётчик id тел Matter.js. Его нет в типах, но он есть в matter-js 0.20 (Common._nextId). */
const matterIds = Matter.Common as unknown as { _nextId: number };

/**
 * Бросок по кону: мир собирается заново из раскладки и состояния кона, бросок считается, мир уничтожается.
 * Результат зависит только от входа: счётчик id Matter.js перед сборкой обнуляется, поэтому ранее созданные
 * миры (и другие броски в той же «тёплой» функции) на него не влияют.
 *
 * @param layout раскладка кона (для соревновательного режима — getStakeLayout)
 * @param konBefore состояние кона после прошлых бросков (end.final прошлого броска); null — начальная раскладка
 * @param params параметры броска уже с разбросом (throwParams)
 * @param throwNo номер броска в матче (1, 2, …)
 * @param power сила прицела 0…1 — только для показа выброса руки (ThrowStart.power)
 */
export function runThrow(layout: KonLayout, konBefore: AsykState[] | null, params: ThrowParams, throwNo: number, power = 0): ThrowRun {
  const savedId = matterIds._nextId;
  let world: PhysicsWorld | null = null;
  try {
    matterIds._nextId = 0;
    world = new PhysicsWorld();
    world.addObstacles(layout.obstacles ?? []);
    world.addAsyks(layout.asyks);
    if (konBefore) world.importAsyks(konBefore, layout.asyks, true);
    const r = playThrow(world, layout.zone, params, throwNo, layout.asyks.length);
    const { chunks, end: recorded } = r.record!;
    const end: ThrowEnd = { ...recorded, final: keepInZone(layout.zone, recorded.final) };
    return {
      start: { throwIndex: throwNo, angle: params.angle, power },
      chunks,
      end,
      knocked: r.knocked.map((p) => p.index),
      steps: end.steps,
      settled: r.settled,
      final: end.final,
    };
  } finally {
    world?.destroy();
    // миры, живущие рядом (игра в браузере), продолжают со своего места: id их новых тел не совпадут со старыми
    matterIds._nextId = Math.max(savedId, matterIds._nextId);
  }
}
