// @ts-nocheck — файл для Deno (Supabase Edge Functions). В проекте нет типов Deno, и tsconfig сюда не смотрит
// (include: src); вся проверяемая логика — в src/game/sim/edgeHttp.ts и edgeEntry.ts, она покрыта тестами vitest.
//
// Серверный бросок соревновательного режима (docs/competitive-mode.md, 7.3).
// POST { matchId, throwNo, angle, power } с токеном игрока в Authorization.
//   1. CORS, строгий разбор тела (не больше 1 КБ).
//   2. Игрок — по токену: сначала дешёвая проверка формы и срока (jwtLooksValid), затем auth.getUser. Неверный — 401.
//   3. comp_count_call (30 вызовов в минуту, отказы тоже считаются) → comp_begin_throw (проверки, секрет матча).
//   4. Версия физики матча ≠ SIM_VERSION → comp_void_version (возврат ставок), 410.
//   5. Бросок считается здесь (sim.js — тот же код, что в игре): разброс ×2 из секрета матча, запись кадров.
//   6. comp_apply_throw — запись в базу ДО ответа. Повтор того же броска безопасен: тот же результат, duplicate.
//      Если записан другой запрос того же броска (гонка двух вкладок), отдаётся записанный бросок, не свой.
//   7. Запись броска (start, части, end) — в закрытый канал comp:<id>, событие 'srv'; ответ бросающему.
// Служебный ключ берётся из окружения функции (его подставляет Supabase), не печатается и не возвращается.
// В логах — только коды и время, без почт, uuid игроков и секретов.

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  bearerToken,
  BROADCAST_PAUSE_MS,
  broadcastBatches,
  compTopic,
  computeServerThrow,
  corsHeaders,
  dbErrorCode,
  declaredTooLarge,
  errorStatus,
  jwtLooksValid,
  originPermitted,
  parseThrowRequest,
  readBodyLimited,
  sameSlots,
  serviceKeyFromEnv,
  SIM_VERSION,
  SimInputError,
  srvPayloads,
  throwContext,
} from './sim.js';

const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '');
const SERVICE_KEY = serviceKeyFromEnv((name) => Deno.env.get(name));

/** Служебный клиент: без сессии и без автообновления токена — каждый запрос сам по себе. */
const admin =
  SUPABASE_URL && SERVICE_KEY
    ? createClient(SUPABASE_URL, SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      })
    : null;

/** Сколько ждать один запрос рассылки в Realtime. */
const BROADCAST_TIMEOUT_MS = 5000;

function log(event: string, fields: Record<string, unknown> = {}): void {
  // только коды, номера и время; никаких токенов, ключей, секретов и uuid игроков
  console.log(JSON.stringify({ fn: 'comp-throw', event, ...fields }));
}

function json(status: number, body: unknown, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function fail(code: string, origin: string | null, started: number): Response {
  log('fail', { code, ms: Date.now() - started });
  return json(errorStatus(code), { error: code }, origin);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Рассылка записи броска соперникам: несколько небольших запросов в Realtime REST (пределы — broadcastBatches).
 * Сбой одного запроса не останавливает остальные: последняя часть (end) несёт итог кона, а клиент без записи
 * через 3 с сам берёт kon_state из базы.
 */
async function broadcast(matchId: string, throwNo: number, run: unknown): Promise<void> {
  const { batches, dropped } = broadcastBatches(compTopic(matchId), srvPayloads(run, throwNo));
  if (dropped) log('broadcast_dropped', { throwNo, dropped });
  let failed = 0;
  for (let i = 0; i < batches.length; i++) {
    if (i > 0) await sleep(BROADCAST_PAUSE_MS);
    try {
      const res = await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
        method: 'POST',
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(batches[i]),
        signal: AbortSignal.timeout(BROADCAST_TIMEOUT_MS),
      });
      if (!res.ok) {
        failed += 1;
        log('broadcast_status', { throwNo, status: res.status });
      }
      await res.body?.cancel();
    } catch (e) {
      failed += 1;
      log('broadcast_error', { throwNo, error: e instanceof Error ? e.name : 'unknown' });
    }
  }
  log('broadcast', { throwNo, batches: batches.length, failed });
}

/** Фоновая задача, которая переживёт ответ (EdgeRuntime.waitUntil); без него — просто дождаться. */
async function background(task: Promise<void>): Promise<void> {
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt && typeof rt.waitUntil === 'function') {
    rt.waitUntil(task);
    return;
  }
  await task;
}

/** Посчитать бросок по контексту comp_begin_throw. null — сбой (неверное состояние матча в базе), уже в журнале. */
async function simulate(c, matchId: string, throwNo: number) {
  try {
    return await computeServerThrow({
      seedHex: c.seedHex,
      matchId,
      throwNo,
      angle: c.angle,
      power: c.power,
      layoutId: c.layoutId,
      players: c.players,
      konBefore: c.konBefore,
    });
  } catch (e) {
    // вход уже проверен: ошибка здесь — неверное состояние матча в базе, это сбой сервера, не игрока
    log('sim_error', { throwNo, code: e instanceof SimInputError ? e.code : 'exception', replay: c.replay });
    return null;
  }
}

async function handle(req: Request): Promise<Response> {
  const started = Date.now();
  const origin = req.headers.get('Origin');

  // предзапрос браузера — сразу, без базы и без тела
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: originPermitted(origin) ? 204 : 403, headers: corsHeaders(origin) });
  }
  if (!originPermitted(origin)) return fail('origin', origin, started);
  if (req.method !== 'POST') return fail('method', origin, started);
  if (!admin) {
    // в окружении функции нет SUPABASE_URL или служебного ключа (названия переменных — в supabase/README.md)
    return fail('config', origin, started);
  }

  // 1. тело
  if (declaredTooLarge(req.headers.get('Content-Length'))) return fail('too_large', origin, started);
  const read = await readBodyLimited(req.body);
  if (!read.ok) return fail(read.error, origin, started);
  const parsed = parseThrowRequest(read.text);
  if (!parsed.ok) return fail(parsed.error, origin, started);
  const body = parsed.value;

  // 2. игрок по токену
  const jwt = bearerToken(req.headers.get('Authorization'));
  // мусор и просроченные токены отсекаются без запроса в Auth (подпись проверит getUser)
  if (!jwt || !jwtLooksValid(jwt, Math.floor(Date.now() / 1000))) return fail('not_signed_in', origin, started);
  const { data: auth, error: authError } = await admin.auth.getUser(jwt);
  if (authError || !auth?.user?.id) {
    // 4xx от Auth — токен неверный или просрочен; сеть и 5xx — сбой сервера (клиент может повторить)
    const status = typeof authError?.status === 'number' ? authError.status : 0;
    return fail(authError && (status === 0 || status >= 500) ? 'server' : 'not_signed_in', origin, started);
  }
  const userId = auth.user.id;

  // 3. лимит вызовов (своя транзакция — считаются и отказы), затем проверки матча и хода
  const counted = await admin.rpc('comp_count_call', { p_user: userId });
  if (counted.error) return fail(dbErrorCode(counted.error), origin, started);
  if (counted.data !== true) return fail('rate_limited', origin, started);

  const begin = await admin.rpc('comp_begin_throw', { p_match: body.matchId, p_user: userId, p_throw_no: body.throwNo });
  if (begin.error) return fail(dbErrorCode(begin.error), origin, started);
  const ctx = throwContext(begin.data, body);
  if (!ctx.ok) {
    log('bad_context', { throwNo: body.throwNo });
    return fail('server', origin, started);
  }
  const c = ctx.value;

  // 4. версия физики
  if (c.simVersion !== SIM_VERSION) {
    const voided = await admin.rpc('comp_void_version', { p_match: body.matchId, p_sim_version: SIM_VERSION });
    log('version_mismatch', { match: c.simVersion, server: SIM_VERSION, voided: voided.data?.voided ?? null });
    return fail('version', origin, started);
  }

  // 5. бросок (при повторе — с сохранёнными углом, силой и коном: результат тот же)
  let run = await simulate(c, body.matchId, body.throwNo);
  if (!run) return fail('server', origin, started);
  // пересчёт разошёлся с записанным броском — значит, физика менялась без новой SIM_VERSION
  let mismatch = c.replay && !sameSlots(run.knocked, c.replayKnocked);
  if (mismatch) log('replay_mismatch', { throwNo: body.throwNo });

  // 6. запись в базу — до ответа и до рассылки
  const apply = await admin.rpc('comp_apply_throw', {
    p_match: body.matchId,
    p_user: userId,
    p_throw_no: body.throwNo,
    p_angle: c.angle,
    p_power: c.power,
    p_kon_before: c.konBefore,
    p_final: run.final,
    p_knocked: run.knocked,
    p_steps: run.steps,
  });
  if (apply.error) {
    const code = dbErrorCode(apply.error);
    if (code === 'server') log('apply_rejected', { throwNo: body.throwNo, reason: String(apply.error.message ?? '').slice(0, 40) });
    return fail(code, origin, started);
  }
  const applied = apply.data ?? {};
  const duplicate = applied.duplicate === true;

  if (duplicate && !c.replay) {
    // гонка двух запросов одного броска (две вкладки, повтор, пока первый ещё считался): записан другой
    // запрос, и его угол мог быть другим. Свой расчёт не отдаём — берём записанный бросок и считаем его.
    const again = await admin.rpc('comp_begin_throw', { p_match: body.matchId, p_user: userId, p_throw_no: body.throwNo });
    if (again.error) return fail(dbErrorCode(again.error), origin, started);
    const ctx2 = throwContext(again.data, body);
    if (!ctx2.ok || !ctx2.value.replay) {
      log('duplicate_lost', { throwNo: body.throwNo });
      return fail('stale_throw', origin, started);
    }
    run = await simulate(ctx2.value, body.matchId, body.throwNo);
    if (!run) return fail('server', origin, started);
    mismatch = !sameSlots(run.knocked, ctx2.value.replayKnocked);
    if (mismatch) log('replay_mismatch', { throwNo: body.throwNo });
  }
  if (duplicate && mismatch) {
    // запись разошлась с базой — вымышленный бросок не показываем: клиент возьмёт кон из comp_state
    return fail('stale_throw', origin, started);
  }

  // 7. рассылка — только для нового броска (повтор соперник уже видел или взял итог из базы)
  if (!duplicate) {
    await background(broadcast(body.matchId, body.throwNo, run).catch(() => log('broadcast_error', { throwNo: body.throwNo })));
  }

  log('ok', {
    throwNo: body.throwNo,
    steps: run.steps,
    knocked: run.knocked.length,
    settled: run.settled,
    duplicate,
    ms: Date.now() - started,
  });
  return json(
    200,
    {
      throwNo: body.throwNo,
      duplicate,
      start: run.start,
      chunks: run.chunks,
      end: run.end,
      knocked: run.knocked,
      next: applied.next ?? null,
    },
    origin,
  );
}

Deno.serve(async (req: Request) => {
  try {
    return await handle(req);
  } catch (e) {
    log('exception', { error: e instanceof Error ? e.name : 'unknown' });
    return json(500, { error: 'server' }, req.headers.get('Origin'));
  }
});
