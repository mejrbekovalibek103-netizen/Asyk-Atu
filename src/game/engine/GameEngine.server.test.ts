import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMP_JITTER_SCALE, THROW_ORIGIN } from '../config';
import { getMatchLayout, getStakeLayout } from '../levels/matchLayouts';
import { aimFromAnglePower, throwParams } from '../physics/aim';
import type { AsykState } from '../physics/PhysicsWorld';
import { Renderer } from '../render/Renderer';
import { compStateFixture, type Json } from '../rules/compFixture';
import { CompetitiveRules, parseCompState } from '../rules/CompetitiveRules';
import { MatchRules } from '../rules/MatchRules';
import { sfc32 } from '../sim/rng';
import { runThrow, type ThrowRun } from '../sim/runThrow';
import { RETRY_PAUSE_MS, THROW_ATTEMPTS, THROW_TIMEOUT_MS } from '../../net/competitive';
import { CANON_WAIT_MS, GameEngine, SERVER_THROW_TIMEOUT_MS, type EngineCallbacks, type ServerThrowRecord, type ServerThrowRequest } from './GameEngine';

/**
 * Движок в режиме «сервер решает» без браузера: canvas, окно и кадры подменены, рендер выключен,
 * кадры гоняются вручную. Запись броска считает то же ядро, что Edge Function (runThrow).
 */

const layout = getStakeLayout('stake-line', 2);
let now = 0;

function fakeCanvas(): HTMLCanvasElement {
  return {
    getContext: () => ({}),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 600 }),
    hasPointerCapture: () => false,
  } as unknown as HTMLCanvasElement;
}

beforeEach(() => {
  now = 1_000;
  vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined, devicePixelRatio: 1 });
  vi.stubGlobal('document', { createElement: fakeCanvas });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(Renderer.prototype, 'render').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Прогнать кадры на ms миллисекунд игрового времени (по 16 мс). */
function run(engine: GameEngine, ms: number): void {
  const frame = (engine as unknown as { frame(t: number): void }).frame;
  const end = now + ms;
  while (now < end) {
    now += 16;
    frame(now);
  }
}

/** Гонять кадры, пока условие не выполнится (не дольше limitMs). */
function runUntil(engine: GameEngine, cond: () => boolean, limitMs = 20_000): void {
  const frame = (engine as unknown as { frame(t: number): void }).frame;
  const end = now + limitMs;
  while (!cond() && now < end) {
    now += 16;
    frame(now);
  }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** Серверный бросок: тот же расчёт, что в computeServerThrow (разброс ×2 из «секрета»). */
function serverThrow(konBefore: AsykState[] | null, throwNo: number, angle = 0, power = 0.9): ThrowRun {
  const rng = sfc32(new Uint8Array(32).map((_, i) => (i * 37 + throwNo) & 255));
  return runThrow(layout, konBefore, throwParams(aimFromAnglePower(angle, power), rng, true, COMP_JITTER_SCALE), throwNo, power);
}

/** Первый из серверных бросков с разными углами и силой, который что-то выбивает. */
function knockingThrow(konBefore: AsykState[] | null, throwNo: number): ThrowRun {
  let last: ThrowRun | null = null;
  for (const power of [1, 0.9, 0.8]) {
    for (let i = 0; i <= 20; i++) {
      last = serverThrow(konBefore, throwNo, (i % 2 ? -1 : 1) * Math.ceil(i / 2) * 0.02, power);
      if (last.knocked.length > 0) return last;
    }
  }
  return last!;
}

const record = (r: ThrowRun): ServerThrowRecord => ({ start: r.start, chunks: r.chunks, end: r.end });

/** Состояние базы после броска throwNo: кон, ход, счёт. */
function stateAfter(r: ThrowRun, throwNo: number, seat: 0 | 1, next: 0 | 1, extra: { match?: Json; now?: string } = {}): Json {
  const raw = compStateFixture({
    match: {
      throw_no: throwNo,
      current_seat: next,
      kon_state: r.final,
      last_throw: { throw_no: throwNo, seat, angle: 0, power: 0.9, kon_before: null, knocked: r.knocked, steps: r.steps },
      ...extra.match,
    },
    now: extra.now ?? `2026-11-13T10:00:${String(10 + throwNo).padStart(2, '0')}.000Z`,
  });
  const p = (raw.players as Json[])[seat];
  Object.assign(p, { throws: 1, real_throws: 1, knocked: r.knocked.length, best_combo: r.knocked.length });
  return raw;
}

function makeEngine(opts: { state?: Json; requestThrow?: (req: ServerThrowRequest) => Promise<ServerThrowRecord | null | void>; cb?: EngineCallbacks; ownerMarks?: boolean } = {}) {
  const raw = opts.state ?? compStateFixture();
  const view = parseCompState(raw)!;
  const rules = new CompetitiveRules(view);
  const engine = new GameEngine(
    fakeCanvas(),
    { layout, rules, tutorial: false, reducedMotion: true, authority: 'server', requestThrow: opts.requestThrow, serverState: raw, ownerMarks: opts.ownerMarks },
    opts.cb,
  );
  engine.start();
  return { engine, rules };
}

/** Взять сақа, натянуть вверх и отпустить. */
function throwByHand(engine: GameEngine, pull = 600): void {
  engine.pointerDown({ x: THROW_ORIGIN.x, y: THROW_ORIGIN.y });
  engine.pointerMove({ x: THROW_ORIGIN.x, y: THROW_ORIGIN.y - pull }, true);
  engine.pointerUp({ x: THROW_ORIGIN.x, y: THROW_ORIGIN.y - pull });
}

const kon = (engine: GameEngine) => engine.exportMatchState().asyks;

describe('GameEngine authority: server — свой бросок', () => {
  it('бросок уходит на сервер один раз, рука ждёт, запись проигрывается и кон совпадает с итогом сервера', async () => {
    const r = serverThrow(null, 1, 0, 600 / 700);
    expect(r.knocked.length).toBeGreaterThan(0);
    const requestThrow = vi.fn(() => Promise.resolve(record(r)));
    const { engine, rules } = makeEngine({ requestThrow });
    expect(engine.localTurn).toBe(true);

    throwByHand(engine);
    expect(requestThrow).toHaveBeenCalledTimes(1);
    const req = (requestThrow.mock.calls[0] as unknown as [ServerThrowRequest])[0];
    expect(req.throwNo).toBe(1);
    expect(req.angle).toBeCloseTo(0, 6);
    expect(req.power).toBeCloseTo(600 / 700, 6);
    expect(engine.getSnapshot().throwPending).toBe(true);
    expect(engine.phase).toBe('THROWING');
    expect(engine.aim).not.toBeNull(); // замах держится, пока считает сервер

    // двойной выпуск и новое нажатие второго запроса не шлют
    engine.pointerUp({ x: THROW_ORIGIN.x, y: THROW_ORIGIN.y - 600 });
    expect(engine.pointerDown({ x: THROW_ORIGIN.x, y: THROW_ORIGIN.y })).toBe(false);
    engine.keyThrow();
    expect(requestThrow).toHaveBeenCalledTimes(1);

    await flush();
    expect(engine.getSnapshot().throwPending).toBe(false);
    runUntil(engine, () => engine.phase === 'READY');
    expect(engine.phase).toBe('READY');
    expect(kon(engine)).toEqual(r.final);
    expect(rules.hud().players[0].knocked).toBe(r.knocked.length);
    // база ещё не прислала новое состояние — бросать нельзя (номер броска устарел бы)
    expect(engine.localTurn).toBe(false);

    expect(engine.applyCanonical(stateAfter(r, 1, 0, 1))).toBe(true);
    expect(rules.view().throwNo).toBe(1);
    expect(rules.hud().current).toBe(1);
    expect(rules.hud().players[0].knocked).toBe(r.knocked.length);
    expect(engine.localTurn).toBe(false);
    expect(kon(engine)).toEqual(r.final);
    engine.destroy();
  });

  it('ответ без записи: запись приходит отдельно (srv), повтор из ответа не играется второй раз', async () => {
    const r = serverThrow(null, 1);
    let resolve!: (v: ServerThrowRecord) => void;
    const { engine } = makeEngine({ requestThrow: () => new Promise((res) => (resolve = res)) });
    throwByHand(engine);
    // srv: начало и части по одной, не по порядку
    engine.pushServerThrow(1, { start: r.start });
    for (const c of [...r.chunks].reverse()) engine.pushServerThrow(1, { chunks: [c] });
    engine.pushServerThrow(1, { end: r.end });
    expect(engine.getSnapshot().throwPending).toBe(false);
    runUntil(engine, () => engine.phase === 'READY');
    expect(kon(engine)).toEqual(r.final);
    expect(engine.serverThrowsDone).toBe(1);
    resolve(record(r)); // ответ Edge Function пришёл позже srv
    await flush();
    run(engine, 200);
    expect(engine.phase).toBe('READY');
    engine.destroy();
  });

  it('отказ сервера: сақа снова в руке, интерфейсу сообщается, можно бросить ещё раз тем же номером', async () => {
    const onServerThrowError = vi.fn();
    const requestThrow = vi.fn(() => Promise.reject(new Error('not_your_turn')));
    const { engine } = makeEngine({ requestThrow, cb: { onServerThrowError } });
    throwByHand(engine);
    await flush();
    expect(engine.phase).toBe('READY');
    expect(engine.getSnapshot().throwPending).toBe(false);
    expect(onServerThrowError).toHaveBeenCalledTimes(1);
    expect((onServerThrowError.mock.calls[0] as unknown[])[1]).toMatchObject({ throwNo: 1 });
    expect(engine.getSnapshot().message?.text).toContain('брось ещё раз');
    run(engine, 500);
    expect(engine.localTurn).toBe(true);
    throwByHand(engine);
    expect(requestThrow).toHaveBeenCalledTimes(2);
    expect((requestThrow.mock.calls[1] as unknown as [ServerThrowRequest])[0].throwNo).toBe(1);
    engine.destroy();
  });

  it('нет ответа — через SERVER_THROW_TIMEOUT_MS сақа возвращается', () => {
    const onServerThrowError = vi.fn();
    const { engine } = makeEngine({ requestThrow: () => new Promise(() => undefined), cb: { onServerThrowError } });
    throwByHand(engine);
    run(engine, SERVER_THROW_TIMEOUT_MS - 500);
    expect(engine.phase).toBe('THROWING');
    run(engine, 1_000);
    expect(engine.phase).toBe('READY');
    expect(onServerThrowError).toHaveBeenCalledTimes(1);
    engine.destroy();
  });

  it('срок ожидания движка не короче всех попыток submitThrow', () => {
    // иначе сақа вернётся в руку («брось ещё раз»), пока повтор того же броска ещё идёт
    expect(SERVER_THROW_TIMEOUT_MS).toBeGreaterThanOrEqual(THROW_ATTEMPTS * THROW_TIMEOUT_MS + (THROW_ATTEMPTS - 1) * RETRY_PAUSE_MS + 1_000);
  });

  it('не мой ход — ввод заблокирован, запрос не уходит', () => {
    const requestThrow = vi.fn(() => Promise.resolve(null));
    const { engine } = makeEngine({ requestThrow, state: compStateFixture({ match: { current_seat: 1 } }) });
    expect(engine.localTurn).toBe(false);
    throwByHand(engine);
    engine.keyThrow();
    engine.keyThrow();
    expect(requestThrow).not.toHaveBeenCalled();
    expect(engine.phase).toBe('READY');
    engine.destroy();
  });
});

describe('GameEngine authority: server — бросок соперника и состояние базы', () => {
  const opponentTurn = () => compStateFixture({ match: { current_seat: 1 } });

  it('состояние базы ждёт конца показа броска, потом ход переходит', () => {
    const r = serverThrow(null, 1, 0.05, 0.95);
    const { engine, rules } = makeEngine({ state: opponentTurn() });
    engine.pushServerThrow(1, record(r));
    expect(engine.phase).toBe('THROWING');
    // база обновилась раньше, чем закончился показ
    expect(engine.applyCanonical(stateAfter(r, 1, 1, 0))).toBe(true);
    expect(rules.view().throwNo).toBe(0);
    expect(engine.localTurn).toBe(false);
    runUntil(engine, () => engine.phase === 'READY');
    expect(rules.view().throwNo).toBe(1);
    expect(rules.canThrow()).toBe(true);
    expect(engine.localTurn).toBe(true);
    expect(kon(engine)).toEqual(r.final);
    expect(rules.hud().players[1].knocked).toBe(r.knocked.length);
    engine.destroy();
  });

  it('запись не пришла за CANON_WAIT_MS — кон выставляется по базе без показа, поздняя запись не играется', () => {
    const r = serverThrow(null, 1, -0.04, 1);
    const { engine, rules } = makeEngine({ state: opponentTurn() });
    engine.applyCanonical(stateAfter(r, 1, 1, 0));
    run(engine, CANON_WAIT_MS - 500);
    expect(rules.view().throwNo).toBe(0);
    expect(engine.localTurn).toBe(false);
    run(engine, 1_000);
    expect(rules.view().throwNo).toBe(1);
    expect(kon(engine).map((s) => s[4])).toEqual(r.final.map((s) => s[4]));
    run(engine, 1_500); // выбитые растворяются
    expect(kon(engine)).toEqual(r.final);
    engine.pushServerThrow(1, record(r));
    expect(engine.phase).toBe('READY');
    expect(engine.localTurn).toBe(true);
    engine.destroy();
  });

  it('пропуск хода (записи не будет) применяется сразу', () => {
    const { engine, rules } = makeEngine({ state: opponentTurn() });
    const raw = compStateFixture({ match: { throw_no: 1, current_seat: 0 } });
    Object.assign((raw.players as Json[])[1], { throws: 1, skips_in_row: 1 });
    engine.applyCanonical(raw);
    expect(rules.view().throwNo).toBe(1);
    expect(engine.localTurn).toBe(true);
    engine.destroy();
  });

  it('застрявшая запись (часть потерялась) прерывается по базе', () => {
    const r = serverThrow(null, 1, 0, 1);
    expect(r.chunks.length).toBeGreaterThan(1);
    const { engine, rules } = makeEngine({ state: opponentTurn() });
    engine.pushServerThrow(1, { start: r.start, chunks: r.chunks.slice(0, 1) });
    engine.applyCanonical(stateAfter(r, 1, 1, 0));
    run(engine, 1_500);
    expect(engine.getSnapshot().netWaiting).toBe(true);
    run(engine, CANON_WAIT_MS + 500);
    expect(engine.phase).toBe('READY');
    expect(rules.view().throwNo).toBe(1);
    run(engine, 1_500);
    expect(kon(engine)).toEqual(r.final);
    engine.destroy();
  });

  it('конец матча по базе — ROUND_COMPLETE и итоги', () => {
    const done = vi.fn();
    const raw = opponentTurn();
    const view = parseCompState(raw)!;
    const rules = new CompetitiveRules(view, done);
    const engine = new GameEngine(fakeCanvas(), { layout, rules, tutorial: false, reducedMotion: true, authority: 'server', serverState: raw });
    engine.start();
    engine.applyCanonical(
      compStateFixture({
        match: { status: 'settled', throw_no: 3, current_seat: null, end_reason: 'all_forfeited' },
        result: { refunded: false, won: [], returned: [0, 2, 4, 6, 8], lost: [], delta: 0 },
        now: '2026-11-13T10:05:00.000Z',
      }),
    );
    expect(engine.phase).toBe('ROUND_COMPLETE');
    run(engine, 1_000);
    expect(done).toHaveBeenCalledTimes(1);
    engine.destroy();
  });

  it('переподключение: кон из serverState выставляется сразу', () => {
    const r = serverThrow(null, 1, 0.02, 1);
    const { engine, rules } = makeEngine({ state: stateAfter(r, 1, 1, 0) });
    run(engine, 1_500);
    expect(kon(engine)).toEqual(r.final);
    expect(rules.view().throwNo).toBe(1);
    expect(engine.localTurn).toBe(true);
    // запись этого броска (повтор srv) уже не играется
    engine.pushServerThrow(1, record(r));
    expect(engine.phase).toBe('READY');
    engine.destroy();
  });

  it('устаревшее состояние базы во время показа броска не «воскрешает» выбитые', () => {
    const r1 = serverThrow(null, 1, 0.02, 1);
    const r2 = knockingThrow(r1.final, 2);
    expect(r2.knocked.length).toBeGreaterThan(0);
    const { engine, rules } = makeEngine({ state: stateAfter(r1, 1, 0, 1) });
    run(engine, 1_500);
    engine.pushServerThrow(2, record(r2));
    expect(engine.phase).toBe('THROWING');
    // ответ на опрос, ушедший до записи броска 2
    expect(engine.applyCanonical(stateAfter(r1, 1, 0, 1))).toBe(false);
    runUntil(engine, () => engine.phase === 'READY');
    run(engine, 1_500);
    expect(kon(engine)).toEqual(r2.final);
    expect(rules.hud().players[1].knocked).toBe(r2.knocked.length);
    // настоящее состояние после броска 2 применяется как обычно
    expect(engine.applyCanonical(stateAfter(r2, 2, 1, 0))).toBe(true);
    expect(rules.view().throwNo).toBe(2);
    expect(kon(engine)).toEqual(r2.final);
    engine.destroy();
  });

  it('состояние базы, принятое до своего броска, после его показа не откатывает кон', async () => {
    const r1 = serverThrow(null, 1, 0.02, 1);
    const r2 = knockingThrow(r1.final, 2);
    expect(r2.knocked.length).toBeGreaterThan(0);
    let resolve!: (v: ServerThrowRecord) => void;
    const { engine, rules } = makeEngine({ state: stateAfter(r1, 1, 1, 0), requestThrow: () => new Promise((res) => (resolve = res)) });
    run(engine, 1_500);
    throwByHand(engine);
    expect(engine.getSnapshot().throwPending).toBe(true);
    // опрос вернул то же состояние до броска: оно ждёт, пока движок занят
    expect(engine.applyCanonical(stateAfter(r1, 1, 1, 0))).toBe(true);
    resolve(record(r2));
    await flush();
    runUntil(engine, () => engine.phase === 'READY');
    run(engine, 1_500);
    expect(engine.serverThrowsDone).toBe(2);
    expect(kon(engine)).toEqual(r2.final);
    expect(rules.hud().players[0].knocked).toBe(r2.knocked.length);
    engine.destroy();
  });

  it('мусор и чужой матч не применяются', () => {
    const { engine, rules } = makeEngine();
    expect(engine.applyCanonical({ match: 1 })).toBe(false);
    expect(engine.applyCanonical(compStateFixture({ match: { id: '11111111-2222-4333-8444-555555555555', throw_no: 1, current_seat: 1 } }))).toBe(false);
    expect(rules.view().throwNo).toBe(0);
    engine.destroy();
  });
});

describe('GameEngine: обычные режимы не задеты', () => {
  it('authority по умолчанию: физика своя, серверные методы ничего не делают, тамги нет', () => {
    const local = getMatchLayout('ulken-kon');
    const rules = new MatchRules({ layoutId: local.id, players: ['А', 'Б'], first: 0 }, () => undefined);
    const engine = new GameEngine(fakeCanvas(), { layout: local, rules, tutorial: false, reducedMotion: true });
    engine.start();
    expect(engine.applyCanonical(compStateFixture())).toBe(false);
    engine.pushServerThrow(1, { start: { throwIndex: 1, angle: 0, power: 1 } });
    expect(engine.phase).toBe('READY');
    expect(engine.ownerMarks).toBeNull();
    throwByHand(engine);
    expect(engine.phase).toBe('THROWING');
    expect(engine.getSnapshot().throwPending).toBe(false);
    runUntil(engine, () => engine.phase === 'READY');
    expect(rules.hud().current).toBe(1);
    engine.destroy();
  });

  it('тамга рисуется только с опцией ownerMarks', () => {
    const off = makeEngine();
    expect(off.engine.ownerMarks).toBeNull();
    off.engine.destroy();
    const on = makeEngine({ ownerMarks: true });
    expect(on.engine.ownerMarks).toHaveLength(layout.asyks.length);
    expect(on.engine.ownerMarks![1]).toMatchObject({ dots: 2 });
    on.engine.destroy();
  });
});
