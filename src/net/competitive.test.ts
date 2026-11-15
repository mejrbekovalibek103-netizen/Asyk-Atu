import { afterEach, describe, expect, it, vi } from 'vitest';
import { srvPayloads } from '../game/sim/edgeHttp';
import { computeServerThrow } from '../game/sim/edgeEntry';
import {
  AIM_INTERVAL_MS,
  AimThrottle,
  COMP_ERROR_TEXT,
  compCodeFrom,
  CompError,
  compErrorFromDb,
  compErrorText,
  isMyTurn,
  parseAimPayload,
  parseCompCodeInput,
  parseCompHistory,
  parseCompKon,
  parseCompState,
  parseDbTime,
  parseJoinResult,
  parseOpenResult,
  parseRematchResult,
  parseSrv,
  parseThrowResponse,
  serverNow,
  skipPlan,
  submitThrow,
  THROW_TIMEOUT_MS,
  ThrowFeed,
  throwResultEvents,
  turnSecondsLeft,
  type CompThrowEvent,
  type CompThrowInvoker,
} from './competitive';

const MATCH = '123e4567-e89b-12d3-a456-426614174000';
const SEED = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const T0 = '2026-11-13T10:00:00.000000+00:00';
const T0_MS = Date.UTC(2026, 10, 13, 10, 0, 0);
const sec = (s: number) => new Date(T0_MS + s * 1000).toISOString();

const kon = (n: number) => Array.from({ length: n }, (_, k) => [k, 100 + k * 50, 420, 0.01, 1]);

/** Ответ comp_state для матча на двоих: идёт ход места 0 (это я), бросков ещё не было. */
function stateJson(over: { match?: Record<string, unknown>; me?: Record<string, unknown>; players?: unknown[]; slots?: unknown[]; result?: unknown; now?: string } = {}) {
  return {
    now: over.now ?? T0,
    match: {
      id: MATCH.toUpperCase(),
      join_code: 'ABCDEFGHJK',
      layout_id: 'stake-line',
      sim_version: 1,
      status: 'active',
      players: 2,
      max_players: 2,
      stake_size: 5,
      kon_size: 10,
      throws_per_player: 15,
      turn_seconds: 45,
      current_seat: 0,
      throw_no: 0,
      kon_state: null,
      last_throw: null,
      turn_started_at: T0,
      turn_deadline: sec(45),
      skip_absent_at: sec(20),
      skip_at: sec(50),
      ready_deadline: null,
      pending: false,
      pending_at: null,
      players_rev: 7,
      created_at: sec(-120),
      started_at: T0,
      settled_at: null,
      end_reason: null,
      ...over.match,
    },
    me: { lobby_slot: 0, seat: 0, is_host: true, staked: true, ready: true, forfeited: false, staked_ids: [1, 2, 3, 4, 5], ...over.me },
    players: over.players ?? [
      player({ lobby_slot: 0, seat: 0, name: 'Айдос', is_host: true, is_me: true }),
      player({ lobby_slot: 1, seat: 1, name: 'Дана' }),
    ],
    slots:
      over.slots ??
      Array.from({ length: 10 }, (_, k) => ({ slot: k, owner_seat: k % 2, knocked_by_seat: null, knocked_throw: null, mine: k % 2 === 0, asyk_id: k % 2 === 0 ? k + 1 : null })),
    result: over.result ?? null,
  };
}

function player(over: Record<string, unknown>) {
  return {
    lobby_slot: 0,
    seat: 0,
    name: 'Игрок',
    is_host: false,
    is_me: false,
    staked: true,
    ready: true,
    forfeited: false,
    active: true,
    throws: 0,
    real_throws: 0,
    knocked: 0,
    best_combo: 0,
    skips_in_row: 0,
    seen_ago_ms: 1000,
    online: true,
    ...over,
  };
}

describe('время из базы', () => {
  it('ISO из jsonb и текст Postgres с пробелом и микросекундами', () => {
    expect(parseDbTime(T0)).toBe(T0_MS);
    expect(parseDbTime('2026-11-13 10:00:01.123456+00')).toBe(T0_MS + 1123);
    expect(parseDbTime('2026-11-13T15:00:00+05:00')).toBe(T0_MS);
    expect(parseDbTime('2026-11-13T09:30:00-0030')).toBe(T0_MS);
    expect(parseDbTime('2026-11-13T10:00:00Z')).toBe(T0_MS);
    expect(parseDbTime('2026-11-13T10:00:00')).toBe(T0_MS);
  });

  it('мусор — null', () => {
    for (const bad of [null, 5, '', 'вчера', '2026-13-01T00:00:00Z', '2026-11-13T25:00:00Z', '2026-11-13T10:00:00+99:00', 'x'.repeat(100)])
      expect(parseDbTime(bad)).toBeNull();
  });
});

describe('состояние матча (comp_state)', () => {
  it('обычный ответ читается, uuid — в нижнем регистре, время — в мс', () => {
    const st = parseCompState(stateJson(), 5000);
    expect(st).not.toBeNull();
    expect(st!.match.id).toBe(MATCH);
    expect(st!.match.turnDeadline).toBe(T0_MS + 45_000);
    expect(st!.match.konState).toBeNull();
    expect(st!.players.map((p) => p.name)).toEqual(['Айдос', 'Дана']);
    expect(st!.slots).toHaveLength(10);
    expect(st!.me.stakedIds).toEqual([1, 2, 3, 4, 5]);
    expect(isMyTurn(st!)).toBe(true);
    expect(serverNow(st!, 6000)).toBe(T0_MS + 1000);
    expect(turnSecondsLeft(st!, 5000)).toBe(45);
  });

  it('лобби до старта: мест нет, кон по числу вошедших', () => {
    const st = parseCompState(
      stateJson({
        match: { status: 'forming', players: null, kon_size: 5, current_seat: null, turn_started_at: null, turn_deadline: null, skip_absent_at: null, skip_at: null, started_at: null, ready_deadline: sec(1200) },
        me: { seat: null, staked: false, ready: false, staked_ids: [] },
        players: [player({ lobby_slot: 0, seat: null, is_host: true, is_me: true, staked: false, ready: false })],
        slots: [],
      }),
    );
    expect(st?.match.status).toBe('forming');
    expect(st?.me.seat).toBeNull();
    expect(isMyTurn(st!)).toBe(false);
  });

  it('кон после броска: ровно kon_size записей по порядку слотов', () => {
    expect(parseCompState(stateJson({ match: { kon_state: kon(10), throw_no: 1 } }))?.match.konState).toHaveLength(10);
    expect(parseCompState(stateJson({ match: { kon_state: kon(9) } }))).toBeNull();
    const swapped = kon(10);
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    expect(parseCompState(stateJson({ match: { kon_state: swapped } }))).toBeNull();
    const far = kon(10);
    far[3] = [3, 99999, 420, 0, 1];
    expect(parseCompState(stateJson({ match: { kon_state: far } }))).toBeNull();
    expect(parseCompKon(null, 10)).toBeNull();
  });

  it('последний бросок разбирается вместе с коном до броска', () => {
    const st = parseCompState(
      stateJson({ match: { throw_no: 1, current_seat: 1, kon_state: kon(10), last_throw: { throw_no: 1, seat: 0, angle: 0.05, power: 0.9, kon_before: null, knocked: [5], steps: 400 } } }),
    );
    expect(st?.match.lastThrow).toEqual({ throwNo: 1, seat: 0, angle: 0.05, power: 0.9, konBefore: null, knocked: [5], steps: 400 });
    expect(parseCompState(stateJson({ match: { last_throw: { throw_no: 1, seat: 0, angle: 0.05, power: 0.9, kon_before: null, knocked: [5, 5], steps: 400 } } }))).toBeNull();
    expect(parseCompState(stateJson({ match: { last_throw: { throw_no: 1, seat: 0, angle: 9, power: 0.9, kon_before: null, knocked: [], steps: 400 } } }))).toBeNull();
  });

  it('испорченные поля — отказ всего ответа', () => {
    const bad: Parameters<typeof stateJson>[0][] = [
      { match: { id: 'x' } },
      { match: { join_code: 'ABCDEFGHI1' } },
      { match: { layout_id: 'ulken-kon' } },
      { match: { status: 'playing' } },
      { match: { players: 5 } },
      { match: { kon_size: 12 } }, // 2 игрока × 5 ≠ 12
      { match: { throw_no: -1 } },
      { match: { turn_deadline: 'завтра' } },
      { match: { pending: 'yes' } },
      { me: { is_host: 1 } },
      { me: { staked_ids: [1, 1] } },
      { players: [player({ lobby_slot: 0, seat: 0 }), player({ lobby_slot: 0, seat: 1 })] },
      { players: [player({ lobby_slot: 0, seat: 0 }), player({ lobby_slot: 1, seat: 0 })] },
      { players: [player({ lobby_slot: 0, seat: 0, is_me: true }), player({ lobby_slot: 1, seat: 1, is_me: true })] },
      { players: [player({ throws: 1.5 })] },
      { players: Array.from({ length: 5 }, (_, i) => player({ lobby_slot: i % 4, seat: null })) },
      { slots: [{ slot: 10, owner_seat: 0, knocked_by_seat: null, knocked_throw: null, mine: true, asyk_id: 1 }] },
      { slots: [{ slot: 0, owner_seat: 0, knocked_by_seat: null, knocked_throw: null, mine: 'да', asyk_id: 1 }] },
      { result: { refunded: false, won: [1], returned: [], lost: [], delta: 'много' } },
      { now: 'сейчас' },
    ];
    for (const b of bad) expect(parseCompState(stateJson(b)), JSON.stringify(b)).toBeNull();
    for (const raw of [null, 'x', [], { match: {} }]) expect(parseCompState(raw)).toBeNull();
  });

  it('неизвестная причина конца не ломает ответ; итог читается', () => {
    const st = parseCompState(
      stateJson({ match: { status: 'settled', end_reason: 'что-то-новое', current_seat: null }, result: { refunded: false, won: [1, 3], returned: [0, 2], lost: [4], delta: 1 } }),
    );
    expect(st?.match.endReason).toBeNull();
    expect(st?.result).toEqual({ refunded: false, won: [1, 3], returned: [0, 2], lost: [4], delta: 1 });
  });

  it('код реванша: нет поля — null, верный код — нормализуется, мусор — отказ', () => {
    expect(parseCompState(stateJson())?.match.nextCode).toBeNull();
    expect(parseCompState(stateJson({ match: { next_code: null } }))?.match.nextCode).toBeNull();
    expect(parseCompState(stateJson({ match: { next_code: 'abcde-fghjk' } }))?.match.nextCode).toBe('ABCDEFGHJK');
    expect(parseCompState(stateJson({ match: { next_code: '<script>' } }))).toBeNull();
    expect(parseCompState(stateJson({ match: { next_code: 5 } }))).toBeNull();
  });

  it('новые коны принимаются, неизвестные — нет', () => {
    expect(parseCompState(stateJson({ match: { layout_id: 'stake-piles' } }))?.match.layoutId).toBe('stake-piles');
    expect(parseCompState(stateJson({ match: { layout_id: 'ulken-kon' } }))).toBeNull();
  });

  it('имена чистятся: управляющие символы убираются, пустое — запасное', () => {
    const st = parseCompState(stateJson({ players: [player({ lobby_slot: 0, seat: 0, name: 'А‮йдос', is_me: true }), player({ lobby_slot: 1, seat: 1, name: '' })] }));
    expect(st?.players.map((p) => p.name)).toEqual(['Айдос', 'Гость']);
  });
});

describe('ответы comp_open, comp_join, my_comp_history', () => {
  it('создание и вход', () => {
    expect(parseOpenResult({ match_id: MATCH, join_code: 'ABCDEFGHJK', lobby_slot: 0 })).toEqual({ matchId: MATCH, joinCode: 'ABCDEFGHJK', lobbySlot: 0 });
    expect(parseJoinResult({ match_id: MATCH, join_code: 'abcdefghjk', lobby_slot: 1, status: 'forming' })).toEqual({ matchId: MATCH, joinCode: 'ABCDEFGHJK', lobbySlot: 1, status: 'forming' });
    expect(parseOpenResult({ match_id: 'x', join_code: 'ABCDEFGHJK', lobby_slot: 0 })).toBeNull();
    expect(parseOpenResult({ match_id: MATCH, join_code: 'ABCDEFGHJK', lobby_slot: 7 })).toBeNull();
    expect(parseJoinResult({ match_id: MATCH, join_code: 'ABCDEFGHJK', lobby_slot: 1, status: 'x' })).toBeNull();
  });

  it('реванш: created обязателен', () => {
    expect(parseRematchResult({ match_id: MATCH, join_code: 'ABCDEFGHJK', lobby_slot: 1, created: false })).toEqual({ matchId: MATCH, joinCode: 'ABCDEFGHJK', lobbySlot: 1, created: false });
    expect(parseRematchResult({ match_id: MATCH, join_code: 'ABCDEFGHJK', lobby_slot: 0 })).toBeNull();
    expect(parseRematchResult({ match_id: MATCH, join_code: 'ABCDEFGHJK', lobby_slot: 0, created: 'yes' })).toBeNull();
  });

  it('история: испорченные записи пропускаются', () => {
    const good = {
      match_id: MATCH,
      status: 'settled',
      end_reason: 'cleared',
      layout_id: 'stake-ring',
      players: 2,
      started_at: T0,
      settled_at: sec(600),
      my_seat: 1,
      forfeited: false,
      knocked: 4,
      real_throws: 12,
      best_combo: 2,
      won: 3,
      lost: 2,
      opponents: ['Дана'],
    };
    const h = parseCompHistory([good, { ...good, status: 'active' }, { ...good, won: -1 }, null, { ...good, opponents: 'Дана' }]);
    expect(h).toHaveLength(1);
    expect(h![0]).toMatchObject({ matchId: MATCH, layoutId: 'stake-ring', won: 3, lost: 2, opponents: ['Дана'], settledAt: T0_MS + 600_000 });
    expect(parseCompHistory({})).toBeNull();
  });

  it('код матча из ввода: код, ссылка, фраза', () => {
    expect(parseCompCodeInput('abcde-fghjk')).toBe('ABCDEFGHJK');
    expect(parseCompCodeInput('https://asyk.example/#/comp/ABCDE-FGHJK')).toBe('ABCDEFGHJK');
    expect(parseCompCodeInput('Матч на асыки: ABCDE FGHJK, заходи')).toBe('ABCDEFGHJK');
    for (const bad of ['', 'ABCDE', 'ABCDEFGHI1', null, 7]) expect(parseCompCodeInput(bad)).toBeNull();
  });
});

describe('ошибки', () => {
  it('код из raise exception → текст игроку', () => {
    const e = compErrorFromDb({ message: 'not_your_turn', code: 'P0001' });
    expect(e.code).toBe('not_your_turn');
    expect(e.text).toBe(COMP_ERROR_TEXT.not_your_turn);
    expect(compErrorText(e)).toBe('Сейчас не твой ход.');
    expect(compErrorText(new Error('x'))).toBe(COMP_ERROR_TEXT.network);
  });

  it('detail: код текущего матча, сколько свободных асыков, время', () => {
    const inMatch = compErrorFromDb({ message: 'already_in_match', code: 'P0001', details: 'ABCDEFGHJK' });
    expect(inMatch.joinCode).toBe('ABCDEFGHJK');
    expect(compErrorFromDb({ message: 'not_enough', code: 'P0001', details: '3' }).text).toBe('Свободных асыков: 3, нужно 5.');
    expect(compErrorFromDb({ message: 'not_enough', code: 'P0001', details: null }).text).toBe(COMP_ERROR_TEXT.not_enough);
    expect(compErrorFromDb({ message: 'too_early', code: 'P0001', details: '2026-11-13 10:00:01+00' }).notBefore).toBe(T0_MS + 1000);
    expect(compErrorFromDb({ message: 'kicked', code: 'P0001' }).text).toBe('Хозяин тебя исключил.');
  });

  it('нет функции — режим не настроен; нет права — нет доступа; без кода — сеть; прочее — сбой сервера', () => {
    expect(compErrorFromDb({ message: 'Could not find the function', code: 'PGRST202' }).code).toBe('setup');
    expect(compErrorFromDb({ message: 'permission denied for function comp_begin_throw', code: '42501' }).code).toBe('forbidden');
    expect(compErrorFromDb({ message: 'google_required', code: '42501' }).code).toBe('google_required');
    expect(compErrorFromDb({ message: 'TypeError: Failed to fetch', code: '' }).code).toBe('network');
    expect(compErrorFromDb({ message: 'division by zero', code: '22012' }).code).toBe('server');
    expect(compErrorFromDb(null).code).toBe('network');
  });

  it('коды функции броска: ошибки ввода — одним текстом, неизвестное — сбой сервера', () => {
    for (const c of ['bad_angle', 'bad_power', 'bad_body', 'bad_throw_no', 'bad_match']) expect(compCodeFrom(c)).toBe('bad_throw');
    expect(compCodeFrom('deadline')).toBe('deadline');
    expect(compCodeFrom('__proto__')).toBe('server');
    expect(compCodeFrom('toString')).toBe('server');
    expect(compCodeFrom(5)).toBe('server');
  });

  it('у каждого кода есть короткий текст', () => {
    for (const [code, text] of Object.entries(COMP_ERROR_TEXT)) {
      expect(text.length, code).toBeGreaterThan(3);
      expect(text.length, code).toBeLessThanOrEqual(50);
    }
  });
});

/** Настоящий серверный бросок (тот же код, что в Edge Function). */
async function serverThrow(throwNo = 1) {
  const r = await computeServerThrow({ seedHex: SEED, matchId: MATCH, throwNo, angle: 0.05, power: 0.95, layoutId: 'stake-line', players: 2, konBefore: null });
  const next = { status: 'active', current_seat: 1, throw_no: throwNo, turn_started_at: sec(4), turn_deadline: sec(49), end_reason: null };
  return { run: r, response: JSON.parse(JSON.stringify({ start: r.start, chunks: r.chunks, end: r.end, knocked: r.knocked, next })) as Record<string, unknown> };
}

describe('запись броска от сервера', () => {
  it('ответ comp-throw проходит те же проверки, что запись обычного онлайна', async () => {
    const { run, response } = await serverThrow();
    const r = parseThrowResponse(response, 1, 10);
    expect(r).not.toBeNull();
    expect(r!.knocked).toEqual(run.knocked);
    expect(r!.end.final).toEqual(run.end.final);
    expect(r!.chunks.map((c) => c.seq)).toEqual(run.chunks.map((c) => c.seq));
    expect(r!.next).toMatchObject({ status: 'active', currentSeat: 1, throwNo: 1 });
  });

  it('подделанный или испорченный ответ — отказ', async () => {
    const { response } = await serverThrow();
    expect(parseThrowResponse(response, 2, 10)).toBeNull(); // чужой номер броска
    expect(parseThrowResponse(response, 1, 15)).toBeNull(); // не тот размер кона
    const dupChunks = { ...response, chunks: [...(response.chunks as unknown[]), (response.chunks as unknown[])[0]] };
    expect(parseThrowResponse(dupChunks, 1, 10)).toBeNull();
    const end = response.end as { final: number[][] };
    const inZone = end.final.find((s) => s[4] === 1)![0];
    expect(parseThrowResponse({ ...response, knocked: [inZone] }, 1, 10)).toBeNull(); // «выбит», но стоит в коне
    expect(parseThrowResponse({ ...response, knocked: [1, 1] }, 1, 10)).toBeNull();
    expect(parseThrowResponse({ ...response, next: { status: 'x' } }, 1, 10)).toBeNull();
    expect(parseThrowResponse({ ...response, start: { throwIndex: 1, angle: NaN, power: 0.9 } }, 1, 10)).toBeNull();
    expect(parseThrowResponse(null, 1)).toBeNull();
  });

  it('сообщения srv: start, части и конец разбираются; мусор отбрасывается', async () => {
    const { run } = await serverThrow();
    const msgs = JSON.parse(JSON.stringify(srvPayloads(run, 1))) as unknown[];
    const parsed = msgs.map(parseSrv);
    expect(parsed.every(Boolean)).toBe(true);
    expect(parsed[0]).toEqual({ k: 'start', throwNo: 1, start: run.start });
    const last = parsed[parsed.length - 1] as Extract<CompThrowEvent, { k: 'end' }>;
    expect(last.knocked).toEqual(run.knocked);
    // события 'k' в частях — ровно выбитые этим броском
    const kEvents = parsed.flatMap((p) => (p?.k === 'chunk' ? p.chunk.events.filter((e) => e.t === 'k').map((e) => (e as { i: number }).i) : []));
    expect(kEvents).toEqual(run.knocked);
    for (const bad of [null, { k: 'start', throwNo: 0, angle: 0, power: 1 }, { k: 'boom', throwNo: 1 }, { k: 'chunk', throwNo: 1, seq: 0, frames: 'x', events: [] }, { ...(msgs[msgs.length - 1] as object), knocked: 'all' }])
      expect(parseSrv(bad)).toBeNull();
  });
});

describe('лента бросков: два источника без повторов', () => {
  async function events(throwNo = 1) {
    const { response } = await serverThrow(throwNo);
    return throwResultEvents(parseThrowResponse(response, throwNo, 10)!);
  }

  it('канал и ответ функции вместе дают одну запись по порядку', async () => {
    const evs = await events();
    const feed = new ThrowFeed();
    const out: CompThrowEvent[] = [];
    // из канала пришли start и первая часть, потом ответ функции целиком, потом остаток канала
    out.push(...feed.push(evs[0]), ...feed.push(evs[1]));
    for (const e of evs) out.push(...feed.push(e));
    for (const e of evs.slice(2)) out.push(...feed.push(e));
    expect(out).toEqual(evs);
  });

  it('части до start ждут его; конец — последним', async () => {
    const evs = await events();
    const feed = new ThrowFeed();
    const reversed = [...evs].reverse();
    const out: CompThrowEvent[] = [];
    for (const e of reversed) out.push(...feed.push(e));
    expect(out[0].k).toBe('start');
    expect(out[out.length - 1].k).toBe('end');
    expect(out.filter((e) => e.k === 'chunk').map((e) => (e as Extract<CompThrowEvent, { k: 'chunk' }>).chunk.seq)).toEqual(
      evs.filter((e) => e.k === 'chunk').map((e) => (e as Extract<CompThrowEvent, { k: 'chunk' }>).chunk.seq),
    );
    expect(out).toHaveLength(evs.length);
  });

  it('броски, уже известные по базе, не проигрываются', async () => {
    const evs = await events(1);
    const feed = new ThrowFeed();
    feed.ignoreBefore(2);
    for (const e of evs) expect(feed.push(e)).toEqual([]);
  });
});

describe('бросок через сервер: повтор того же броска', () => {
  it('нет ответа — повтор с тем же throwNo, сервер возвращает результат', async () => {
    const { response } = await serverThrow();
    const calls: { throwNo: number; timeout: number }[] = [];
    let n = 0;
    const invoke: CompThrowInvoker = async (body, timeout) => {
      calls.push({ throwNo: body.throwNo, timeout });
      n += 1;
      return n < 3 ? { error: new CompError('timeout'), retry: true } : { data: response };
    };
    const r = await submitThrow({ matchId: MATCH.toUpperCase(), throwNo: 1, angle: 0.05, power: 0.95 }, { invoke, konSize: 10, pauseMs: 0 });
    expect(r.throwNo).toBe(1);
    expect(calls).toEqual([1, 2, 3].map(() => ({ throwNo: 1, timeout: THROW_TIMEOUT_MS })));
  });

  it('отказ по правилам не повторяется', async () => {
    let n = 0;
    const invoke: CompThrowInvoker = async () => {
      n += 1;
      return { error: new CompError('not_your_turn'), retry: false };
    };
    await expect(submitThrow({ matchId: MATCH, throwNo: 1, angle: 0, power: 0.9 }, { invoke, pauseMs: 0 })).rejects.toMatchObject({ code: 'not_your_turn' });
    expect(n).toBe(1);
  });

  it('все попытки без ответа — ошибка последней попытки', async () => {
    const invoke: CompThrowInvoker = async () => ({ error: new CompError('network'), retry: true });
    await expect(submitThrow({ matchId: MATCH, throwNo: 1, angle: 0, power: 0.9 }, { invoke, attempts: 2, pauseMs: 0 })).rejects.toMatchObject({ code: 'network' });
  });

  it('непонятный ответ — bad_response; неверный бросок не уходит на сервер', async () => {
    const invoke = vi.fn<CompThrowInvoker>(async () => ({ data: { start: null } }));
    await expect(submitThrow({ matchId: MATCH, throwNo: 1, angle: 0, power: 0.9 }, { invoke, pauseMs: 0 })).rejects.toMatchObject({ code: 'bad_response' });
    invoke.mockClear();
    for (const body of [
      { matchId: 'x', throwNo: 1, angle: 0, power: 0.9 },
      { matchId: MATCH, throwNo: 0, angle: 0, power: 0.9 },
      { matchId: MATCH, throwNo: 1, angle: 1.4, power: 0.9 },
      { matchId: MATCH, throwNo: 1, angle: 0, power: 0.05 },
      { matchId: MATCH, throwNo: 1, angle: NaN, power: 0.9 },
    ])
      await expect(submitThrow(body, { invoke })).rejects.toBeInstanceOf(CompError);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('прицел', () => {
  afterEach(() => vi.useRealTimers());

  it('разбор: число в пределах или null', () => {
    expect(parseAimPayload({ a: { angle: 0.3, power: 0.5 }, n: 3 })).toEqual({ aim: { angle: 0.3, power: 0.5 }, throwNo: 3 });
    expect(parseAimPayload({ a: null })).toEqual({ aim: null, throwNo: null });
    for (const bad of [null, {}, { a: { angle: 9, power: 0.5 } }, { a: { angle: 0, power: 2 } }, { a: null, n: 0 }, { a: 'x' }]) expect(parseAimPayload(bad)).toBeUndefined();
  });

  it('не чаще 8 раз в секунду, последнее положение уходит обязательно', () => {
    vi.useFakeTimers();
    let t = 0;
    const sent: unknown[] = [];
    const th = new AimThrottle((p) => sent.push(p), () => t);
    // 60 движений за секунду
    for (let i = 0; i < 60; i++) {
      th.send({ angle: i / 100, power: 0.5 }, 2);
      t += 1000 / 60;
      vi.advanceTimersByTime(1000 / 60);
    }
    th.send(null, 2);
    t += AIM_INTERVAL_MS;
    vi.advanceTimersByTime(AIM_INTERVAL_MS);
    expect(sent.length).toBeLessThanOrEqual(1000 / AIM_INTERVAL_MS + 2);
    expect(sent.length).toBeGreaterThanOrEqual(6);
    expect(sent[sent.length - 1]).toEqual({ a: null, n: 2 });
    th.dispose();
  });
});

describe('пропуск хода отсутствующего', () => {
  const RECV = 1_000_000; // местное время получения ответа

  it('чужой ход: соперник в сети — только после дедлайна + 5 с', () => {
    const st = parseCompState(stateJson({ match: { current_seat: 1 } }), RECV)!;
    // пульс 1 с назад, ход начался сейчас: без пульса пропуск стал бы возможен в 16 с, но не раньше 20 с с начала хода
    const plan = skipPlan(st)!;
    expect(plan.throwNo).toBe(1);
    // skipAbsentAt (20 с) раньше skipAt (50 с): клиент спросит базу в 20 с; если пульс придёт, база ответит too_early
    expect(plan.at - RECV).toBeGreaterThanOrEqual(20_000);
    expect(plan.at - RECV).toBeLessThan(21_000);
  });

  it('чужой ход: пульса давно нет — через 20 с с начала хода', () => {
    const st = parseCompState(
      stateJson({ match: { current_seat: 1 }, players: [player({ lobby_slot: 0, seat: 0, is_me: true }), player({ lobby_slot: 1, seat: 1, seen_ago_ms: 60_000, online: false })] }),
      RECV,
    )!;
    expect(skipPlan(st)!.at - RECV).toBeGreaterThanOrEqual(20_000);
    expect(skipPlan(st)!.at - RECV).toBeLessThan(21_000);
  });

  it('чужой ход: пульс свежий в конце окна — ждём, пока он устареет на 15 с', () => {
    const st = parseCompState(
      stateJson({
        now: sec(19),
        match: { current_seat: 1 },
        players: [player({ lobby_slot: 0, seat: 0, is_me: true }), player({ lobby_slot: 1, seat: 1, seen_ago_ms: 0 })],
      }),
      RECV,
    )!;
    // пульс в 19 с → без пульса пропуск с 34 с, по местным часам RECV + 15 с
    expect(skipPlan(st)!.at - RECV).toBeGreaterThanOrEqual(15_000);
    expect(skipPlan(st)!.at - RECV).toBeLessThan(16_000);
  });

  it('свой ход — только после дедлайна + 5 с (свой пульс не в счёт)', () => {
    const st = parseCompState(stateJson(), RECV)!;
    expect(skipPlan(st)!.at - RECV).toBeGreaterThanOrEqual(50_000);
    expect(skipPlan(st)!.at - RECV).toBeLessThan(51_000);
  });

  it('пока сервер считает бросок (pending моложе 20 с) — не пропускать', () => {
    const st = parseCompState(stateJson({ now: sec(48), match: { pending: true, pending_at: sec(44) } }), RECV)!;
    // дедлайн + 5 с = 50 с, но pending с 44 с → не раньше 64 с, по местным часам RECV + 16 с
    expect(skipPlan(st)!.at - RECV).toBeGreaterThanOrEqual(16_000);
  });

  it('вне игры пропускать нечего', () => {
    expect(skipPlan(parseCompState(stateJson({ match: { status: 'settled', current_seat: null } }))!)).toBeNull();
    expect(skipPlan(parseCompState(stateJson({ match: { current_seat: 3 } }))!)).toBeNull();
  });

  it('номер броска для comp_skip — следующий', () => {
    expect(skipPlan(parseCompState(stateJson({ match: { throw_no: 6, kon_state: kon(10) } }))!)!.throwNo).toBe(7);
  });
});
