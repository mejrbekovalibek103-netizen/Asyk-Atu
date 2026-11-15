import { describe, expect, it } from 'vitest';
import { parseThrowChunk, parseThrowEnd, parseThrowStart } from '../../net/validate';
import * as entry from './edgeEntry';
import { computeServerThrow } from './edgeEntry';
import {
  ALLOWED_ORIGINS,
  bearerToken,
  BROADCAST_LIMITS,
  broadcastBatches,
  compTopic,
  corsHeaders,
  dbErrorCode,
  declaredTooLarge,
  errorStatus,
  jwtLooksValid,
  MAX_BODY_BYTES,
  originPermitted,
  parseThrowRequest,
  readBodyLimited,
  sameSlots,
  serviceKeyFromEnv,
  srvPayloads,
  throwContext,
  type SrvPayload,
} from './edgeHttp';

const MATCH = '123e4567-e89b-12d3-a456-426614174000';
const SEED = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const BODY = { matchId: MATCH, throwNo: 3, angle: 0.1, power: 0.9 };

const stream = (...parts: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(new TextEncoder().encode(p));
      c.close();
    },
  });

describe('CORS', () => {
  it('разрешённому сайту — его origin, чужому — ничего', () => {
    for (const o of ALLOWED_ORIGINS) {
      expect(corsHeaders(o)['Access-Control-Allow-Origin']).toBe(o);
      expect(originPermitted(o)).toBe(true);
    }
    const evil = corsHeaders('https://evil.example');
    expect(evil['Access-Control-Allow-Origin']).toBeUndefined();
    expect(evil.Vary).toBe('Origin');
    expect(originPermitted('https://evil.example')).toBe(false);
    // похожие адреса не проходят: путь, «/» в конце, другой порт
    expect(originPermitted('https://asyk-atu.onrender.com/')).toBe(false);
    expect(originPermitted('https://localhost:5176')).toBe(false);
    expect(originPermitted('http://localhost.evil.example:5173')).toBe(false);
    expect(originPermitted('http://localhost:5173/')).toBe(false);
    expect(originPermitted('http://localhost')).toBe(false);
    expect(originPermitted('null')).toBe(false);
  });

  it('без Origin (curl) — можно, токен проверяется всё равно', () => {
    expect(originPermitted(null)).toBe(true);
    expect(originPermitted(undefined)).toBe(true);
  });

  it('разрешены заголовки supabase-js и только POST', () => {
    for (const o of ['http://localhost:5173', 'http://localhost:5176', 'http://127.0.0.1:4173']) expect(originPermitted(o)).toBe(true);
    const h = corsHeaders('http://localhost:5173');
    expect(h['Access-Control-Allow-Methods']).toBe('POST, OPTIONS');
    for (const name of ['authorization', 'apikey', 'content-type', 'x-client-info']) {
      expect(h['Access-Control-Allow-Headers']).toContain(name);
    }
  });

  it('список сайтов — без «/» в конце и без «*»', () => {
    for (const o of ALLOWED_ORIGINS) expect(o).toMatch(/^https?:\/\/[^/*]+$/);
  });
});

describe('токен и ключ', () => {
  it('bearerToken', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk';
    expect(bearerToken(`Bearer ${jwt}`)).toBe(jwt);
    expect(bearerToken(`bearer  ${jwt} `)).toBe(jwt);
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken('')).toBeNull();
    expect(bearerToken(jwt)).toBeNull();
    expect(bearerToken('Bearer short')).toBeNull();
    expect(bearerToken(`Bearer ${jwt} lishnee`)).toBeNull();
    expect(bearerToken(`Bearer ${'a'.repeat(9000)}`)).toBeNull();
  });

  it('jwtLooksValid: мусор и просроченные токены отсекаются до запроса в Auth', () => {
    const now = 1_800_000_000;
    // токены собираются здесь же, в тексте файла их нет (проверка секретов ищет JWT по строкам)
    const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const make = (head: unknown, body: unknown, sig = 'c2lnbmF0dXJlLXNpZ25hdHVyZQ') => `${b64(head)}.${b64(body)}.${sig}`;
    const claims = { sub: 'u1', role: 'authenticated', aud: 'authenticated', exp: now + 600 };
    expect(jwtLooksValid(make({ alg: 'HS256', typ: 'JWT' }, claims), now)).toBe(true);
    expect(jwtLooksValid(make({ alg: 'ES256', kid: 'k' }, { ...claims, aud: ['authenticated'] }), now)).toBe(true);
    expect(jwtLooksValid('a'.repeat(40), now)).toBe(false);
    expect(jwtLooksValid('aaaa.bbbb.cccc', now)).toBe(false);
    expect(jwtLooksValid(make({ alg: 'none' }, claims), now)).toBe(false);
    expect(jwtLooksValid(make({ alg: 'HS256' }, claims, ''), now)).toBe(false);
    expect(jwtLooksValid(make({ alg: 'HS256' }, claims, 'a+b/c'), now)).toBe(false);
    expect(jwtLooksValid(make({ alg: 'HS256' }, { ...claims, exp: now }), now)).toBe(false);
    expect(jwtLooksValid(make({ alg: 'HS256' }, { ...claims, exp: undefined }), now)).toBe(false);
    expect(jwtLooksValid(make({ alg: 'HS256' }, { ...claims, role: 'anon' }), now)).toBe(false);
    expect(jwtLooksValid(make({ alg: 'HS256' }, { ...claims, aud: 'other' }), now)).toBe(false);
    expect(jwtLooksValid(make({ alg: 'HS256' }, { ...claims, sub: '' }), now)).toBe(false);
    expect(jwtLooksValid(`${b64({ alg: 'HS256' })}.${b64(claims)}.sig.extra`, now)).toBe(false);
  });

  it('serviceKeyFromEnv: сначала SUPABASE_SERVICE_ROLE_KEY, потом SUPABASE_SECRET_KEYS', () => {
    const env = (vars: Record<string, string>) => (n: string) => vars[n];
    expect(serviceKeyFromEnv(env({ SUPABASE_SERVICE_ROLE_KEY: ' k1 ', SUPABASE_SECRET_KEYS: '{"default":"k2"}' }))).toBe('k1');
    expect(serviceKeyFromEnv(env({ SUPABASE_SECRET_KEYS: '{"other":"k3","default":"k2"}' }))).toBe('k2');
    expect(serviceKeyFromEnv(env({ SUPABASE_SECRET_KEYS: '{"other":"k3"}' }))).toBe('k3');
    expect(serviceKeyFromEnv(env({ SUPABASE_SECRET_KEYS: '["", "k4"]' }))).toBe('k4');
    expect(serviceKeyFromEnv(env({ SUPABASE_SECRET_KEYS: '"k5"' }))).toBe('k5');
    expect(serviceKeyFromEnv(env({ SUPABASE_SECRET_KEYS: 'не json' }))).toBeNull();
    expect(serviceKeyFromEnv(env({ SUPABASE_SECRET_KEYS: '{"default":""}' }))).toBeNull();
    expect(serviceKeyFromEnv(env({}))).toBeNull();
  });
});

describe('тело запроса', () => {
  it('читает тело не больше предела', async () => {
    expect(await readBodyLimited(stream('{"a":', '1}'))).toEqual({ ok: true, text: '{"a":1}' });
    expect(await readBodyLimited(stream('x'.repeat(MAX_BODY_BYTES)))).toEqual({ ok: true, text: 'x'.repeat(MAX_BODY_BYTES) });
    expect(await readBodyLimited(stream('x'.repeat(600), 'x'.repeat(600)))).toEqual({ ok: false, error: 'too_large' });
    expect(await readBodyLimited(null)).toEqual({ ok: false, error: 'bad_body' });
    const notUtf8 = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([0x7b, 0xff, 0x7d]));
        c.close();
      },
    });
    expect(await readBodyLimited(notUtf8)).toEqual({ ok: false, error: 'bad_body' });
  });

  it('Content-Length больше предела — отказ сразу', () => {
    expect(declaredTooLarge('1025')).toBe(true);
    expect(declaredTooLarge('1024')).toBe(false);
    expect(declaredTooLarge(null)).toBe(false);
    expect(declaredTooLarge('abc')).toBe(false);
  });

  it('строгий разбор, лишние поля игнорируются, uuid в нижний регистр', () => {
    const ok = parseThrowRequest(JSON.stringify({ ...BODY, matchId: MATCH.toUpperCase(), extra: [1, 2] }));
    expect(ok).toEqual({ ok: true, value: BODY });
    expect(parseThrowRequest('не json')).toEqual({ ok: false, error: 'bad_body' });
    expect(parseThrowRequest('[1,2]')).toEqual({ ok: false, error: 'bad_body' });
    expect(parseThrowRequest('null')).toEqual({ ok: false, error: 'bad_body' });
    expect(parseThrowRequest(JSON.stringify({ ...BODY, matchId: 'x' }))).toEqual({ ok: false, error: 'bad_match' });
    expect(parseThrowRequest(JSON.stringify({ ...BODY, throwNo: 1.5 }))).toEqual({ ok: false, error: 'bad_throw_no' });
    expect(parseThrowRequest(JSON.stringify({ ...BODY, throwNo: '3' }))).toEqual({ ok: false, error: 'bad_throw_no' });
    expect(parseThrowRequest(JSON.stringify({ ...BODY, angle: 2 }))).toEqual({ ok: false, error: 'bad_angle' });
    expect(parseThrowRequest(JSON.stringify({ ...BODY, angle: null }))).toEqual({ ok: false, error: 'bad_angle' });
    expect(parseThrowRequest(JSON.stringify({ ...BODY, power: 0.01 }))).toEqual({ ok: false, error: 'bad_power' });
    expect(parseThrowRequest(JSON.stringify({ ...BODY, power: 1.01 }))).toEqual({ ok: false, error: 'bad_power' });
    expect(parseThrowRequest(' '.repeat(MAX_BODY_BYTES + 1))).toEqual({ ok: false, error: 'too_large' });
  });
});

describe('коды ошибок', () => {
  it('HTTP-статусы', () => {
    expect(errorStatus('not_signed_in')).toBe(401);
    expect(errorStatus('not_your_turn')).toBe(409);
    expect(errorStatus('version')).toBe(410);
    expect(errorStatus('too_large')).toBe(413);
    expect(errorStatus('bad_angle')).toBe(422);
    expect(errorStatus('rate_limited')).toBe(429);
    expect(errorStatus('server')).toBe(500);
    expect(errorStatus('что-то')).toBe(500);
    // свойства прототипа — не коды
    expect(errorStatus('toString')).toBe(500);
    expect(errorStatus('constructor')).toBe(500);
  });

  it('ошибка базы: известный код — как есть, данные броска и прочее — server', () => {
    for (const c of ['not_found', 'not_member', 'not_active', 'forfeited', 'not_your_turn', 'stale_throw', 'deadline', 'rate_limited', 'banned', 'no_profile', 'not_pending']) {
      expect(dbErrorCode({ message: c })).toBe(c);
    }
    for (const c of ['bad_final', 'resurrection', 'bad_knocked', 'bad_kon_before', 'permission denied for function comp_begin_throw', 'config', 'origin', 'method', 'toString', '']) {
      expect(dbErrorCode({ message: c })).toBe('server');
    }
    expect(dbErrorCode(null)).toBe('server');
    expect(dbErrorCode({ message: 42 })).toBe('server');
  });
});

describe('ответ comp_begin_throw', () => {
  const ctx = (over: Record<string, unknown> = {}) => ({
    replay: null,
    seed: SEED,
    kon_state: null,
    layout_id: 'stake-line',
    players: 2,
    sim_version: 1,
    throw_no: 3,
    seat: 0,
    stake_size: 5,
    ...over,
  });

  it('обычный бросок: угол и сила из запроса, кон — как из базы', () => {
    const kon = [[0, 1, 2, 3, 1]];
    const r = throwContext(ctx({ kon_state: kon }), BODY);
    expect(r.ok && r.value).toMatchObject({ replay: false, angle: 0.1, power: 0.9, konBefore: kon, layoutId: 'stake-line', players: 2, simVersion: 1, replayKnocked: null });
    // тот же объект, не копия: его и вернём в comp_apply_throw (kon_before сверяется равенством jsonb)
    expect(r.ok && r.value.konBefore).toBe(kon);
  });

  it('повтор: угол, сила и выбитые — из сохранённого броска', () => {
    const r = throwContext(ctx({ replay: { throw_no: 3, seat: 0, angle: -0.2, power: 0.5, kon_before: null, knocked: [4, 1], steps: 100 } }), BODY);
    expect(r.ok && r.value).toMatchObject({ replay: true, angle: -0.2, power: 0.5, konBefore: null, replayKnocked: [4, 1] });
  });

  it('неверная форма ответа — bad_context', () => {
    const bad = [
      null,
      [],
      ctx({ seed: 'abc' }),
      ctx({ seed: 'ab'.repeat(15) }),
      ctx({ seed: 1 }),
      ctx({ layout_id: null }),
      ctx({ players: '2' }),
      ctx({ sim_version: null }),
      ctx({ throw_no: 4 }),
      ctx({ kon_state: {} }),
      ctx({ replay: { throw_no: 2, angle: 0, power: 0.5, knocked: [] } }),
      ctx({ replay: { throw_no: 3, angle: 'x', power: 0.5, knocked: [] } }),
      ctx({ replay: { throw_no: 3, angle: 0, power: 0.5, knocked: [1.5] } }),
      ctx({ replay: 'да' }),
    ];
    for (const b of bad) expect(throwContext(b, BODY)).toEqual({ ok: false, error: 'bad_context' });
    const noKon: Record<string, unknown> = ctx();
    delete noKon.kon_state;
    expect(throwContext(noKon, BODY)).toEqual({ ok: false, error: 'bad_context' });
  });

  it('секрет с префиксом bytea тоже принимается', () => {
    expect(throwContext(ctx({ seed: `\\x${SEED}` }), BODY).ok).toBe(true);
  });

  it('sameSlots — как множества', () => {
    expect(sameSlots([3, 1], [1, 3])).toBe(true);
    expect(sameSlots([], [])).toBe(true);
    expect(sameSlots([1], [1, 1])).toBe(false);
    expect(sameSlots([1, 2], [1, 3])).toBe(false);
  });
});

describe('рассылка записи', () => {
  async function run() {
    return computeServerThrow({ seedHex: SEED, matchId: MATCH, throwNo: 1, angle: 0.02, power: 1, layoutId: 'stake-line', players: 2, konBefore: null });
  }

  it('порядок: start, части по seq, end со списком выбитых; проходит проверки клиента', async () => {
    const r = await run();
    const shuffled = { ...r, chunks: [...r.chunks].reverse() };
    const p = srvPayloads(shuffled, 1);
    expect(p[0].k).toBe('start');
    expect(p[p.length - 1].k).toBe('end');
    expect(p.length).toBe(r.chunks.length + 2);
    const seqs = p.filter((x) => x.k === 'chunk').map((x) => (x as Extract<SrvPayload, { k: 'chunk' }>).seq);
    expect(seqs).toEqual(r.chunks.map((c) => c.seq).sort((a, b) => a - b));
    for (const x of p) expect(x.throwNo).toBe(1);
    // каждая часть разбирается теми же проверками, что броски соперника в обычном онлайне
    const { k: _ks, throwNo: _ts, ...start } = p[0] as Extract<SrvPayload, { k: 'start' }>;
    expect(parseThrowStart({ ...start, throwIndex: 1 })).not.toBeNull();
    for (const x of p.slice(1, -1)) {
      const { k: _k, throwNo: _t, ...chunk } = x as Extract<SrvPayload, { k: 'chunk' }>;
      expect(parseThrowChunk(chunk)).not.toBeNull();
    }
    const { k: _ke, throwNo: _te, knocked, ...end } = p[p.length - 1] as Extract<SrvPayload, { k: 'end' }>;
    expect(parseThrowEnd(end)).not.toBeNull();
    expect(knocked).toEqual(r.knocked);
    expect(end.final).toEqual(r.final);
  });

  it('пачки: порядок сохраняется, пределы соблюдаются, private: true', async () => {
    const r = await run();
    const payloads = srvPayloads(r, 1);
    const topic = compTopic(MATCH.toUpperCase());
    expect(topic).toBe(`comp:${MATCH}`);
    const { batches, dropped } = broadcastBatches(topic, payloads);
    expect(dropped).toBe(0);
    const flat = batches.flatMap((b) => b.messages);
    expect(flat.map((m) => m.payload)).toEqual(payloads);
    for (const m of flat) expect(m).toMatchObject({ topic, event: 'srv', private: true });
    for (const b of batches) {
      expect(b.messages.length).toBeLessThanOrEqual(BROADCAST_LIMITS.maxBatchMessages);
      expect(JSON.stringify(b).length).toBeLessThanOrEqual(BROADCAST_LIMITS.maxBatchBytes + 64);
    }
  });

  it('маленькие пределы: много пачек, слишком большое сообщение выбрасывается', () => {
    const payloads: SrvPayload[] = [
      { k: 'start', throwNo: 2, angle: 0, power: 1 },
      ...Array.from({ length: 7 }, (_, seq): SrvPayload => ({ k: 'chunk', throwNo: 2, seq, frames: [], events: [] })),
      { k: 'chunk', throwNo: 2, seq: 7, frames: [{ s: 0, b: Array.from({ length: 500 }, (_, i) => i) }], events: [] },
      { k: 'end', throwNo: 2, steps: 10, final: [], saka: null, knocked: [] },
    ];
    const { batches, dropped } = broadcastBatches('comp:x', payloads, { maxMessageBytes: 1000, maxBatchBytes: 300, maxBatchMessages: 3 });
    expect(dropped).toBe(1);
    const flat = batches.flatMap((b) => b.messages.map((m) => m.payload));
    expect(flat).toEqual(payloads.filter((_, i) => i !== 8));
    for (const b of batches) {
      expect(b.messages.length).toBeLessThanOrEqual(3);
      expect(JSON.stringify(b.messages.map((m) => m)).length).toBeLessThanOrEqual(300 + 3);
    }
    expect(batches.length).toBeGreaterThan(3);
  });
});

describe('sim.js', () => {
  it('точка входа отдаёт и HTTP-часть', () => {
    for (const name of ['corsHeaders', 'originPermitted', 'bearerToken', 'readBodyLimited', 'declaredTooLarge', 'parseThrowRequest', 'serviceKeyFromEnv', 'errorStatus', 'dbErrorCode', 'throwContext', 'sameSlots', 'srvPayloads', 'compTopic', 'broadcastBatches', 'computeServerThrow', 'SIM_VERSION']) {
      expect(name in entry).toBe(true);
    }
  });
});
