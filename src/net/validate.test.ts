import { describe, expect, it } from 'vitest';
import { PHYS, THROW_ORIGIN } from '../game/config';
import { getMatchLayout } from '../game/levels/matchLayouts';
import { aimFromAnglePower, throwParams } from '../game/physics/aim';
import { PhysicsWorld } from '../game/physics/PhysicsWorld';
import { ThrowRecorder, type ThrowChunk, type ThrowEnd } from '../game/replay/throwRecord';
import type { MatchConfig } from '../game/types';
import { LIMITS } from './limits';
import { makeClientId } from './protocol';
import { parseEnvelope, parseNetMessage, parsePeer, parseThrowChunk, parseThrowEnd } from './validate';

const layout = getMatchLayout('ulken-kon');
const config: MatchConfig = { layoutId: layout.id, players: ['Айдос', 'Дана'], first: 0 };
const json = <T>(v: T): unknown => JSON.parse(JSON.stringify(v)); // как по сети: всё проходит через JSON

/** Настоящий бросок настоящей физики: его запись обязана проходить проверки без потерь. */
function realThrow() {
  const w = new PhysicsWorld();
  w.addAsyks(layout.asyks);
  const p = throwParams(aimFromAnglePower((2 * Math.PI) / 180, 0.95), Math.random, false);
  w.launchSaka(THROW_ORIGIN, p.angle, p.speed, p.spin);
  const rec = new ThrowRecorder(w);
  const chunks: ThrowChunk[] = [];
  let settled = 0;
  for (let ms = 0; ms < PHYS.maxThrowMs; ms += PHYS.stepMs) {
    w.step();
    const out = w.checkKnockouts(layout.zone, 1);
    const c = rec.onStep(w.drainContacts(), out);
    if (c) chunks.push(c);
    settled = w.isSettled() ? settled + PHYS.stepMs : 0;
    if (settled >= PHYS.settleMs) break;
  }
  const fin = rec.finish(layout.asyks.length);
  chunks.push(fin.chunk);
  return { chunks, end: fin.end, angle: p.angle };
}

describe('настоящий трафик проходит проверки без потерь', () => {
  const t = realThrow();

  it('части записи', () => {
    expect(t.chunks.length).toBeGreaterThan(2);
    for (const c of t.chunks) expect(parseThrowChunk(json(c))).toEqual(c);
  });

  it('итог броска', () => {
    expect(parseThrowEnd(json(t.end))).toEqual(t.end);
  });

  it('все типы сообщений', () => {
    const state = { asyks: new PhysicsWorld().exportAsyks(0), rules: { current: 0, turnId: 1, knocked: [0, 0], throws: [0, 0], bestCombo: [0, 0], total: 0, finished: false } };
    const w = new PhysicsWorld();
    w.addAsyks(layout.asyks);
    state.asyks = w.exportAsyks(layout.asyks.length);
    const msgs = [
      { t: 'start', config, matchId: 1 },
      { t: 'aim', a: { angle: 0.1, power: 0.5 } },
      { t: 'aim', a: null },
      { t: 'throwStart', s: { throwIndex: 3, angle: -0.2, power: 0.9 } },
      { t: 'throwChunk', c: t.chunks[0] },
      { t: 'throwEnd', e: t.end },
      { t: 'sync', config, matchId: 2, state },
      { t: 'syncRequest' },
      { t: 'rematch' },
      { t: 'rematchAccept' },
      { t: 'leave' },
    ];
    for (const m of msgs) {
      const parsed = parseNetMessage(json(m));
      expect(parsed, `сообщение ${m.t} отвергнуто`).not.toBeNull();
      expect(parsed!.t).toBe(m.t);
    }
  });

  it('конверт', () => {
    const from = makeClientId();
    expect(parseEnvelope(json({ from, msg: { t: 'leave' } }))).toEqual({ from, msg: { t: 'leave' } });
  });
});

describe('отказ на недопустимое', () => {
  const bad = (m: unknown) => expect(parseNetMessage(json(m))).toBeNull();

  it('неизвестный и нестроковый тип', () => {
    bad({ t: 'hack' });
    bad({ t: 5 });
    bad({});
    bad(null);
    bad([]);
    bad('start');
  });

  it('числа вне диапазона, NaN и Infinity', () => {
    bad({ t: 'aim', a: { angle: 99, power: 0.5 } });
    bad({ t: 'aim', a: { angle: 0, power: 2 } });
    bad({ t: 'aim', a: { angle: NaN, power: 0.5 } }); // JSON превращает NaN в null
    bad({ t: 'aim', a: { angle: Infinity, power: 0.5 } });
    bad({ t: 'aim', a: { angle: '0.1', power: 0.5 } });
    bad({ t: 'throwStart', s: { throwIndex: 0, angle: 0, power: 0.5 } });
    bad({ t: 'throwStart', s: { throwIndex: 41, angle: 0, power: 0.5 } }); // больше лимита самого длинного матча (4 × 10)
    bad({ t: 'throwStart', s: { throwIndex: 1.5, angle: 0, power: 0.5 } });
  });

  it('начало матча: неизвестный кон, неверное число игроков, неверный первый', () => {
    bad({ t: 'start', config: { ...config, layoutId: '../../etc/passwd' }, matchId: 1 });
    bad({ t: 'start', config: { ...config, players: ['один'] }, matchId: 1 });
    bad({ t: 'start', config: { ...config, first: 2 }, matchId: 1 });
    bad({ t: 'start', config, matchId: 0 });
    bad({ t: 'start', config, matchId: 1e12 });
  });

  it('части записи: слишком много кадров, событий, неверная длина кадра, неверные числа', () => {
    const frame = { s: 1, b: [0, 100, 100, 0] };
    bad({ t: 'throwChunk', c: { seq: 0, frames: Array(LIMITS.maxFramesPerChunk + 1).fill(frame), events: [] } });
    bad({ t: 'throwChunk', c: { seq: 0, frames: [], events: Array(LIMITS.maxEventsPerChunk + 1).fill({ s: 1, t: 'k', i: 0 }) } });
    bad({ t: 'throwChunk', c: { seq: 0, frames: [{ s: 1, b: [0, 100, 100] }], events: [] } }); // не кратно 4
    bad({ t: 'throwChunk', c: { seq: 0, frames: [{ s: 1, b: [0, 1e9, 100, 0] }], events: [] } }); // координата вне поля
    bad({ t: 'throwChunk', c: { seq: 0, frames: [{ s: LIMITS.maxSteps + 1, b: [0, 1, 1, 0] }], events: [] } });
    bad({ t: 'throwChunk', c: { seq: LIMITS.maxChunksPerThrow, frames: [], events: [] } });
    bad({ t: 'throwChunk', c: { seq: -1, frames: [], events: [] } });
    bad({ t: 'throwChunk', c: { seq: 0, frames: [{ s: 1, b: [99, 1, 1, 0] }], events: [] } }); // номер асыка вне диапазона
    bad({ t: 'throwChunk', c: { seq: 0, frames: [], events: [{ s: 1, t: 'x' }] } });
    bad({ t: 'throwChunk', c: { seq: 0, frames: [], events: [{ s: 1, t: 'c', x: 1, y: 1, i: 1, k: 7 }] } });
  });

  it('итог броска: шагов больше предела, дубли асыков, неверное состояние', () => {
    const asyk = [0, 100, 100, 0, 1];
    bad({ t: 'throwEnd', e: { steps: 1e9, final: [], saka: null } });
    bad({ t: 'throwEnd', e: { steps: 0, final: [], saka: null } });
    bad({ t: 'throwEnd', e: { steps: 10, final: [asyk, asyk], saka: null } }); // повтор номера
    bad({ t: 'throwEnd', e: { steps: 10, final: [[0, 100, 100, 0, 2]], saka: null } });
    bad({ t: 'throwEnd', e: { steps: 10, final: Array(LIMITS.maxAsyks + 1).fill(asyk), saka: null } });
    bad({ t: 'throwEnd', e: { steps: 10, final: [], saka: [1, 2] } });
  });

  it('синхронизация: противоречивое состояние матча', () => {
    const w = new PhysicsWorld();
    w.addAsyks(layout.asyks);
    const asyks = w.exportAsyks(layout.asyks.length);
    const rules = { current: 0, turnId: 1, knocked: [0, 0], throws: [0, 0], bestCombo: [0, 0], total: 0, finished: false };
    const mk = (over: object) => ({ t: 'sync', config, matchId: 1, state: { asyks, rules: { ...rules, ...over } } });
    expect(parseNetMessage(json(mk({})))).not.toBeNull();
    bad(mk({ total: 5 })); // сумма бросков не сходится
    bad(mk({ throws: [5, 0], total: 5 })); // игроки бросают по очереди — разница не больше одного
    bad(mk({ knocked: [20, 20] })); // выбито больше, чем асыков
    bad(mk({ current: 2 }));
    bad(mk({ total: 31, throws: [16, 15] }));
    bad(mk({ bestCombo: [5, 0] })); // комбо больше выбитого
    bad({ t: 'sync', config, matchId: 1, state: { asyks: [[99, 1, 1, 0, 1]], rules } }); // асык вне расстановки
  });

  it('конверт с неверным отправителем', () => {
    expect(parseEnvelope({ from: 'zzzz', msg: { t: 'leave' } })).toBeNull();
    expect(parseEnvelope({ from: '../../x', msg: { t: 'leave' } })).toBeNull();
    expect(parseEnvelope({ from: makeClientId(), msg: { t: 'nope' } })).toBeNull();
  });
});

describe('очистка данных', () => {
  it('имена в конфиге и presence очищаются от скрытых и управляющих символов', () => {
    const m = parseNetMessage(json({ t: 'start', config: { ...config, players: ['‮evil​\u0000', 'x'.repeat(500)] }, matchId: 1 }));
    expect(m).not.toBeNull();
    if (m?.t !== 'start') throw new Error('ожидалось start');
    expect(m.config.players[0]).toBe('evil');
    expect([...m.config.players[1]].length).toBeLessThanOrEqual(16);
    const peer = parsePeer(json({ clientId: makeClientId(), seat: 1, name: '<img src=x onerror=alert(1)>' }));
    expect(peer?.name).toBe('<img src=x onerr'); // текст остаётся текстом (React не исполняет разметку), но обрезан до 16 символов
  });

  it('лишние поля и «__proto__» не переносятся в результат', () => {
    const raw = JSON.parse('{"t":"aim","a":{"angle":0.1,"power":0.2,"__proto__":{"polluted":true},"evil":1},"extra":5}');
    const m = parseNetMessage(raw);
    expect(m).toEqual({ t: 'aim', a: { angle: 0.1, power: 0.2 } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('presence с неверным id или местом отвергается', () => {
    expect(parsePeer({ clientId: 'не hex', seat: 0, name: 'a' })).toBeNull();
    expect(parsePeer({ clientId: makeClientId(), seat: 4, name: 'a' })).toBeNull(); // мест 0–3
    expect(parsePeer({ clientId: makeClientId(), seat: 1.5, name: 'a' })).toBeNull();
    expect(parsePeer({ clientId: makeClientId(), seat: '1', name: 'a' })).toBeNull();
    expect(parsePeer(null)).toBeNull();
  });
});

describe('фаззинг: случайный мусор никогда не роняет разбор', () => {
  // детерминированный генератор — тест воспроизводим
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
  const weird = [null, undefined, NaN, Infinity, -Infinity, 0, -1, 1e308, -1e308, 2 ** 53, '', 'x', '😀'.repeat(50), true, false, [], {}, [[]], { t: 'aim' }];

  function junk(depth = 0): unknown {
    const r = rnd();
    if (depth > 3 || r < 0.35) return pick(weird);
    if (r < 0.6) return Array.from({ length: Math.floor(rnd() * 6) }, () => junk(depth + 1));
    const o: Record<string, unknown> = {};
    for (const k of ['t', 'a', 'c', 'e', 's', 'seq', 'frames', 'events', 'b', 'angle', 'power', 'config', 'matchId', 'state', 'asyks', 'rules', 'from', 'msg', 'final', 'steps', '__proto__', 'constructor']) {
      if (rnd() < 0.3) o[k] = junk(depth + 1);
    }
    return o;
  }

  it('5000 случайных значений: ни исключений, ни ложных принятий', () => {
    for (let i = 0; i < 5000; i++) {
      const x = junk();
      let r: unknown;
      expect(() => (r = parseNetMessage(x))).not.toThrow();
      expect(() => parseEnvelope({ from: makeClientId(), msg: x })).not.toThrow();
      // если что-то принято — результат стабилен: повторная проверка даёт то же самое
      if (r) expect(parseNetMessage(JSON.parse(JSON.stringify(r)))).toEqual(r);
    }
  });

  it('случайные искажения настоящего сообщения: принятое всегда внутри допустимых границ', () => {
    const t = realThrow();
    for (let i = 0; i < 1500; i++) {
      const msg = JSON.parse(JSON.stringify({ t: 'throwChunk', c: t.chunks[1] ?? t.chunks[0] }));
      const f = msg.c.frames[Math.floor(rnd() * msg.c.frames.length)];
      if (f) f.b[Math.floor(rnd() * f.b.length)] = pick(weird);
      const r = parseNetMessage(msg);
      if (r?.t === 'throwChunk') {
        for (const fr of r.c.frames) {
          for (const v of fr.b) expect(Number.isFinite(v)).toBe(true);
          for (let k = 0; k < fr.b.length; k += 4) {
            expect(Math.abs(fr.b[k + 1])).toBeLessThanOrEqual(LIMITS.coordMax);
            expect(Math.abs(fr.b[k + 2])).toBeLessThanOrEqual(LIMITS.coordMax);
          }
        }
      }
    }
  });
});

describe('ограничение по типам: итог броска без шагов или с лишними', () => {
  it('ThrowEnd проходит с saka = null', () => {
    const e: ThrowEnd = { steps: 5, final: [], saka: null };
    expect(parseThrowEnd(json(e))).toEqual(e);
  });
});

describe('матч на 2–4 игрока: конфиг, состав, присутствие, пропуск хода', () => {
  const ids4 = [makeClientId(), makeClientId(), makeClientId(), makeClientId()];
  const cfg = (over: Record<string, unknown> = {}) => ({ layoutId: 'korgan', players: ['А', 'Б', 'В', 'Г'], first: 2, ids: ids4, ...over });
  const parseCfg = (c: unknown) => {
    const m = parseNetMessage({ t: 'start', config: c, matchId: 1 });
    return m && m.t === 'start' ? m.config : null;
  };

  it('конфиг на 2, 3 и 4 игрока принимается, состав сохраняется', () => {
    expect(parseCfg(cfg())).toEqual(cfg());
    expect(parseCfg(cfg({ players: ['А', 'Б', 'В'], ids: ids4.slice(0, 3), first: 0 }))?.players).toHaveLength(3);
    expect(parseCfg(cfg({ players: ['А', 'Б'], ids: ids4.slice(0, 2), first: 1 }))?.players).toHaveLength(2);
    expect(parseCfg({ layoutId: 'korgan', players: ['А', 'Б'], first: 0 })?.ids).toBeUndefined(); // без состава (одно устройство)
  });

  it('игроков меньше двух или больше четырёх, первый вне стола — отказ', () => {
    expect(parseCfg(cfg({ players: ['А'], ids: ids4.slice(0, 1), first: 0 }))).toBeNull();
    expect(parseCfg(cfg({ players: ['А', 'Б', 'В', 'Г', 'Д'], ids: [...ids4, makeClientId()] }))).toBeNull();
    expect(parseCfg(cfg({ first: 4 }))).toBeNull();
    expect(parseCfg(cfg({ first: -1 }))).toBeNull();
  });

  it('состав: число id = числу игроков, формат id, без повторов', () => {
    expect(parseCfg(cfg({ ids: ids4.slice(0, 3) }))).toBeNull();
    expect(parseCfg(cfg({ ids: [ids4[0], ids4[0], ids4[2], ids4[3]] }))).toBeNull();
    expect(parseCfg(cfg({ ids: [ids4[0], 'не id', ids4[2], ids4[3]] }))).toBeNull();
    expect(parseCfg(cfg({ ids: 'abc' }))).toBeNull();
  });

  it('имена игроков очищаются, пустые — «Игрок N»', () => {
    expect(parseCfg(cfg({ players: ['‮evil', '', '   ', 'Г'] }))?.players).toEqual(['evil', 'Игрок 2', 'Игрок 3', 'Г']);
  });

  it('presence: места 0–3 и отметка «в матче»', () => {
    expect(parsePeer({ clientId: ids4[0], seat: 3, name: 'Г', busy: true })).toEqual({ clientId: ids4[0], seat: 3, name: 'Г', busy: true });
    expect(parsePeer({ clientId: ids4[0], seat: 2, name: 'В', busy: 'yes' })).toEqual({ clientId: ids4[0], seat: 2, name: 'В' });
  });

  it('пропуск хода: место 0–3 и номер хода, иначе отказ', () => {
    expect(parseNetMessage({ t: 'skip', seat: 2, turnId: 7 })).toEqual({ t: 'skip', seat: 2, turnId: 7 });
    for (const bad of [{ seat: 4, turnId: 7 }, { seat: 1, turnId: 0 }, { seat: 1.5, turnId: 7 }, { seat: 1 }, { seat: '1', turnId: 7 }]) {
      expect(parseNetMessage({ t: 'skip', ...bad }), JSON.stringify(bad)).toBeNull();
    }
  });

  it('снимок матча на четверых проверяется по числу игроков из конфига', () => {
    const layout = getMatchLayout('korgan');
    const w = new PhysicsWorld();
    w.addAsyks(layout.asyks);
    const state = { asyks: w.exportAsyks(layout.asyks.length), rules: { current: 3, turnId: 4, knocked: [0, 0, 0, 0], throws: [1, 1, 1, 0], bestCombo: [0, 0, 0, 0], total: 3, finished: false } };
    const ok = parseNetMessage({ t: 'sync', config: cfg(), matchId: 2, state });
    expect(ok && ok.t === 'sync' ? ok.state.rules : null).toEqual(state.rules);
    // массивы на двоих при конфиге на четверых — отказ
    const bad = parseNetMessage({ t: 'sync', config: cfg(), matchId: 2, state: { ...state, rules: { ...state.rules, knocked: [0, 0], throws: [2, 1], bestCombo: [0, 0] } } });
    expect(bad).toBeNull();
  });
});
