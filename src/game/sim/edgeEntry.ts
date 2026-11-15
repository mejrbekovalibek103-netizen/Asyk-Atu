import { COMP_JITTER_SCALE, PHYS } from '../config';
import { getStakeLayout, isStakeLayout, type StakeLayoutId } from '../levels/matchLayouts';
import { zoneContains } from '../levels/zone';
import { aimFromAnglePower, throwParams } from '../physics/aim';
import type { AsykState } from '../physics/PhysicsWorld';
import type { Zone } from '../types';
import { hexToBytes, sfc32 } from './rng';
import { runThrow, type ThrowRun } from './runThrow';
import { SIM_VERSION } from './version';

/**
 * Единая точка входа серверного броска (Edge Function `comp-throw`, Deno). Собирается командой `npm run build:edge`
 * в один ES-модуль supabase/functions/comp-throw/sim.js вместе с matter-js. Не обращается к window/document.
 *
 * Всё, что приходит снаружи (тело запроса, ответ базы), проверяется строго: неверный вход — SimInputError,
 * а не «примерно правильный» бросок.
 */

export { SIM_VERSION } from './version';
export { STAKE_LAYOUT_IDS, isStakeLayout } from '../levels/matchLayouts';
// HTTP-часть функции (CORS, тело, ключ, коды ответов, рассылка) — чистая логика, тесты в edgeHttp.test.ts
export * from './edgeHttp';

/** Ошибка входных данных (Edge Function отвечает 422 с этим кодом). */
export class SimInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SimInputError';
  }
}

/** Пределы чисел состояния кона — те же, что принимает клиент (net/limits.ts), с запасом за бордюр. */
const KON_COORD_MIN = -200;
const KON_COORD_MAX = 1_400;
const KON_MAX_ANGLE = 1_000;
/** Номер броска: в матче их не больше 15 × 4, но предел с большим запасом (пропуски тоже могут занимать номер). */
const MAX_THROW_NO = 9_999;
/** Наименьшая сила, при которой бросок вообще возможен (как aimFromAnglePower(…).valid). */
export const MIN_POWER = PHYS.minSlide / PHYS.maxSlide;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Состояние кона из базы (comp_matches.kon_state) или из запроса: ровно `count` записей [слот, x, y, угол, 1|0],
 * слоты по порядку 0…count-1, все числа конечные и в пределах. У выбитого асыка координаты обнуляются (как в
 * PhysicsWorld.exportAsyks). Если дана зона кона, асык «в коне» обязан стоять внутри линии: сервер так и пишет
 * (runThrow → keepInZone), а иначе следующий бросок «выбил» бы его даром. Неверное состояние — null.
 */
export function parseKonState(raw: unknown, count: number, zone?: Zone): AsykState[] | null {
  if (!Number.isInteger(count) || count < 1 || !Array.isArray(raw) || raw.length !== count) return null;
  const out: AsykState[] = [];
  for (let k = 0; k < count; k++) {
    const e = raw[k];
    if (!Array.isArray(e) || e.length !== 5) return null;
    const [i, x, y, a, inZone] = e as unknown[];
    if (i !== k) return null;
    if (!finite(x) || !finite(y) || !finite(a)) return null;
    if (inZone === 0) {
      out.push([k, 0, 0, 0, 0]);
      continue;
    }
    if (inZone !== 1) return null;
    if (x < KON_COORD_MIN || x > KON_COORD_MAX || y < KON_COORD_MIN || y > KON_COORD_MAX || Math.abs(a) > KON_MAX_ANGLE) return null;
    if (zone && !zoneContains(zone, { x, y })) return null;
    out.push([k, x, y, a, 1]);
  }
  return out;
}

/** Тело запроса бросающего: `POST { matchId, throwNo, angle, power }`. */
export interface ThrowBody {
  /** uuid матча, в нижнем регистре. */
  matchId: string;
  throwNo: number;
  angle: number;
  power: number;
}

export type BodyCheck = { ok: true; value: ThrowBody } | { ok: false; error: string };

/**
 * Строгая проверка тела запроса: лишние поля игнорируются, остальное — типы и пределы.
 * Угол проверяется ровно по PHYS.maxAimAngle (запрошенный угол, до разброса), сила — MIN_POWER…1.
 */
export function validateThrowBody(raw: unknown): BodyCheck {
  if (!isObj(raw)) return { ok: false, error: 'bad_body' };
  const { matchId, throwNo, angle, power } = raw;
  if (typeof matchId !== 'string' || !UUID_RE.test(matchId)) return { ok: false, error: 'bad_match' };
  if (!Number.isInteger(throwNo) || (throwNo as number) < 1 || (throwNo as number) > MAX_THROW_NO) return { ok: false, error: 'bad_throw_no' };
  if (!finite(angle) || Math.abs(angle) > PHYS.maxAimAngle) return { ok: false, error: 'bad_angle' };
  if (!finite(power) || power < MIN_POWER || power > 1 || !aimFromAnglePower(angle, power).valid) return { ok: false, error: 'bad_power' };
  return { ok: true, value: { matchId: matchId.toLowerCase(), throwNo: throwNo as number, angle, power } };
}

export interface ServerThrowInput {
  /** Секрет матча (comp_match_secrets.seed) в hex, не меньше 16 байт; допускается префикс `\x`. */
  seedHex: string;
  matchId: string;
  throwNo: number;
  angle: number;
  power: number;
  layoutId: string;
  /** Игроков в матче (2–4; первая версия — 2). */
  players: number;
  /** comp_matches.kon_state до броска; null — начальная раскладка (undefined — ошибка bad_kon). */
  konBefore: unknown;
}

export interface ServerThrowResult extends ThrowRun {
  simVersion: number;
}

/** Ключ броска: HMAC-SHA256(seed, `${matchId}:${throwNo}`) через Web Crypto (есть и в Node, и в Deno). */
export async function throwKey(seed: Uint8Array, matchId: string, throwNo: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', seed as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${matchId}:${throwNo}`));
  return new Uint8Array(mac);
}

/**
 * Серверный бросок: проверка входа → ключ броска из секрета матча → разброс руки (×COMP_JITTER_SCALE) →
 * runThrow по кону ставок. Один и тот же вход всегда даёт один и тот же результат (повтор запроса безопасен).
 */
export async function computeServerThrow(input: ServerThrowInput): Promise<ServerThrowResult> {
  if (!isObj(input)) throw new SimInputError('bad_input');
  const body = validateThrowBody(input);
  if (!body.ok) throw new SimInputError(body.error);
  const { matchId, throwNo, angle, power } = body.value;

  let seed: Uint8Array;
  try {
    seed = hexToBytes(input.seedHex);
  } catch {
    throw new SimInputError('bad_seed');
  }
  if (seed.length < 16) throw new SimInputError('bad_seed');

  if (!isStakeLayout(input.layoutId)) throw new SimInputError('bad_layout');
  const players = input.players;
  if (players !== 2 && players !== 3 && players !== 4) throw new SimInputError('bad_players');
  const layout = getStakeLayout(input.layoutId as StakeLayoutId, players);

  let konBefore: AsykState[] | null = null;
  // только явный null значит «начальная раскладка»: забытое поле не должно молча вернуть кон в начало
  if (input.konBefore === undefined) throw new SimInputError('bad_kon');
  if (input.konBefore !== null) {
    konBefore = parseKonState(input.konBefore, layout.asyks.length, layout.zone);
    if (!konBefore) throw new SimInputError('bad_kon');
  }

  const rng = sfc32(await throwKey(seed, matchId, throwNo));
  const params = throwParams(aimFromAnglePower(angle, power), rng, true, COMP_JITTER_SCALE);
  return { ...runThrow(layout, konBefore, params, throwNo, power), simVersion: SIM_VERSION };
}
