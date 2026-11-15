import { describe, expect, it } from 'vitest';
import { STAKE_SIZE } from '../../net/collection';
import { COMP_JITTER_SCALE, COMP_STAKE, PHYS, THROW_JITTER } from '../config';
import { getStakeLayout } from '../levels/matchLayouts';
import { aimFromAnglePower, throwParams } from '../physics/aim';
import { computeServerThrow, MIN_POWER, parseKonState, SimInputError, throwKey, validateThrowBody, type ServerThrowInput } from './edgeEntry';
import { hexToBytes, sfc32 } from './rng';
import { runThrow } from './runThrow';
import { SIM_VERSION } from './version';

const SEED = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const MATCH = '123e4567-e89b-12d3-a456-426614174000';

const input = (over: Partial<ServerThrowInput> = {}): ServerThrowInput => ({
  seedHex: SEED,
  matchId: MATCH,
  throwNo: 1,
  angle: 0.05,
  power: 0.95,
  layoutId: 'stake-line',
  players: 2,
  konBefore: null,
  ...over,
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof SimInputError ? e.code : `не SimInputError: ${String(e)}`;
  }
  return 'нет ошибки';
}

describe('computeServerThrow', () => {
  it('ключ броска — HMAC-SHA256(seed, "matchId:throwNo")', async () => {
    const key = await throwKey(hexToBytes(SEED), MATCH, 3);
    // эталон посчитан независимо: node -e "crypto.createHmac('sha256', seed).update('<matchId>:3')"
    expect([...key]).toEqual([...hexToBytes('4c8e07b3df116bb04afe167e16228bbfb2e79dd722e3a816e13503519b192b84')]);
  });

  it('один и тот же вход → один и тот же результат (повтор запроса безопасен)', async () => {
    const a = JSON.stringify(await computeServerThrow(input()));
    for (let k = 0; k < 20; k++) expect(JSON.stringify(await computeServerThrow(input()))).toBe(a);
    // регистр uuid не важен
    expect(JSON.stringify(await computeServerThrow(input({ matchId: MATCH.toUpperCase() })))).toBe(a);
    // префикс \x (так Postgres отдаёт bytea) — тот же секрет
    expect(JSON.stringify(await computeServerThrow(input({ seedHex: `\\x${SEED}` })))).toBe(a);
  });

  it('«золотой» бросок: закреплены разброс и выбитые асыки', async () => {
    const r = await computeServerThrow(input());
    expect(r.simVersion).toBe(SIM_VERSION);
    expect(r.knocked).toEqual([5]);
    expect(r.start.angle).toBeCloseTo(0.040162992352040225, 12);
    expect(r.start).toMatchObject({ throwIndex: 1, power: 0.95 });
  });

  it('разброс из секрета: зависит от номера броска, матча и секрета, но не от клиента', async () => {
    const base = await computeServerThrow(input());
    const angles = new Set([base.start.angle]);
    angles.add((await computeServerThrow(input({ throwNo: 2 }))).start.angle);
    angles.add((await computeServerThrow(input({ matchId: '123e4567-e89b-12d3-a456-426614174001' }))).start.angle);
    angles.add((await computeServerThrow(input({ seedHex: SEED.replace(/^00/, '01') }))).start.angle);
    expect(angles.size).toBe(4);
  });

  it('разброс ×COMP_JITTER_SCALE и в допустимых пределах', async () => {
    expect(COMP_JITTER_SCALE).toBe(2);
    const sigma = (THROW_JITTER.angleMin + (THROW_JITTER.angleMax - THROW_JITTER.angleMin) * 0.95) * COMP_JITTER_SCALE;
    let spread = 0;
    for (let n = 1; n <= 60; n++) {
      const key = await throwKey(hexToBytes(SEED), MATCH, n);
      const p = throwParams(aimFromAnglePower(0.05, 0.95), sfc32(key), true, COMP_JITTER_SCALE);
      const d = Math.abs(p.angle - 0.05);
      expect(d).toBeLessThanOrEqual(2.5 * sigma + 1e-12);
      spread = Math.max(spread, d);
    }
    // шире обычного предела (2,5σ обычного разброса), хотя бы иногда
    expect(spread).toBeGreaterThan(2.5 * (sigma / COMP_JITTER_SCALE) * 0.5);
  });

  it('кон после броска передаётся в следующий: выбитые остаются выбитыми', async () => {
    const a = await computeServerThrow(input());
    const b = await computeServerThrow(input({ throwNo: 2, angle: -0.1, power: 1, konBefore: JSON.parse(JSON.stringify(a.final)) }));
    for (const i of a.knocked) expect(b.final[i]).toEqual([i, 0, 0, 0, 0]);
    expect(b.knocked.some((i) => a.knocked.includes(i))).toBe(false);
    expect(b.final).toHaveLength(10);
  });

  it('3–4 игрока: кон из 5·N асыков', async () => {
    expect((await computeServerThrow(input({ players: 3, layoutId: 'stake-ring' }))).final).toHaveLength(15);
    expect((await computeServerThrow(input({ players: 4, layoutId: 'stake-scatter' }))).final).toHaveLength(20);
  });

  it('совпадает с runThrow по той же раскладке и тем же параметрам', async () => {
    const r = await computeServerThrow(input({ throwNo: 4 }));
    const rng = sfc32(await throwKey(hexToBytes(SEED), MATCH, 4));
    const params = throwParams(aimFromAnglePower(0.05, 0.95), rng, true, COMP_JITTER_SCALE);
    const { simVersion, ...rest } = r;
    expect(simVersion).toBe(SIM_VERSION);
    expect(rest).toEqual(runThrow(getStakeLayout('stake-line', 2), null, params, 4, 0.95));
  });

  it('неверный вход отклоняется с кодом', async () => {
    const cases: [Partial<ServerThrowInput>, string][] = [
      [{ seedHex: 'zz' }, 'bad_seed'],
      [{ seedHex: '00ff' }, 'bad_seed'],
      [{ seedHex: 42 as unknown as string }, 'bad_seed'],
      [{ matchId: 'abc' }, 'bad_match'],
      [{ throwNo: 0 }, 'bad_throw_no'],
      [{ throwNo: 1.5 }, 'bad_throw_no'],
      [{ throwNo: '1' as unknown as number }, 'bad_throw_no'],
      [{ angle: Number.NaN }, 'bad_angle'],
      [{ angle: PHYS.maxAimAngle + 1e-9 }, 'bad_angle'],
      [{ angle: Infinity }, 'bad_angle'],
      [{ power: 1.0001 }, 'bad_power'],
      [{ power: MIN_POWER / 2 }, 'bad_power'],
      [{ power: -1 }, 'bad_power'],
      [{ layoutId: 'ulken-kon' }, 'bad_layout'],
      [{ players: 1 }, 'bad_players'],
      [{ players: 5 }, 'bad_players'],
      [{ players: 2.5 }, 'bad_players'],
      [{ konBefore: undefined }, 'bad_kon'],
      [{ konBefore: [] }, 'bad_kon'],
      [{ konBefore: 'x' }, 'bad_kon'],
    ];
    for (const [over, c] of cases) expect(await code(computeServerThrow(input(over))), JSON.stringify(over)).toBe(c);
    expect(await code(computeServerThrow(null as unknown as ServerThrowInput))).toBe('bad_input');
    // крайние допустимые значения проходят
    expect(await code(computeServerThrow(input({ angle: PHYS.maxAimAngle, power: 1 })))).toBe('нет ошибки');
    expect(await code(computeServerThrow(input({ angle: -PHYS.maxAimAngle, power: MIN_POWER })))).toBe('нет ошибки');
  });
});

describe('parseKonState', () => {
  const layout = getStakeLayout('stake-line', 2);
  const start = layout.asyks.map((a, i) => [i, a.x, a.y, a.angle ?? 0, 1]);

  it('принимает настоящее состояние и обнуляет координаты выбитых', () => {
    expect(parseKonState(start, 10)).toEqual(start);
    const withOut = start.map((s, i) => (i === 3 ? [3, 999, -5, 7, 0] : s));
    expect(parseKonState(withOut, 10)![3]).toEqual([3, 0, 0, 0, 0]);
  });

  it('отклоняет подделки', () => {
    const bad: unknown[] = [
      null,
      {},
      start.slice(1), // не хватает асыка
      [...start, [10, 1, 1, 0, 1]], // лишний
      start.map((s, i) => (i === 2 ? [5, ...s.slice(1)] : s)), // слот не по порядку
      start.map((s, i) => (i === 2 ? [2, Number.NaN, 1, 0, 1] : s)),
      start.map((s, i) => (i === 2 ? [2, 1e6, 1, 0, 1] : s)),
      start.map((s, i) => (i === 2 ? [2, 1, 1, 5e3, 1] : s)),
      start.map((s, i) => (i === 2 ? [2, 1, 1, 0, 2] : s)),
      start.map((s, i) => (i === 2 ? [2, '1', 1, 0, 1] : s)),
      start.map((s, i) => (i === 2 ? [2, 1, 1, 0] : s)),
    ];
    for (const b of bad) expect(parseKonState(b, 10)).toBeNull();
    expect(parseKonState(start, 0)).toBeNull();
  });

  it('с зоной кона: асык «в коне» за линией — подделка (bad_kon), выбитый — нет', async () => {
    expect(parseKonState(start, 10, layout.zone)).toEqual(start);
    const outside = start.map((s, i) => (i === 4 ? [4, 1300, 420, 0, 1] : s));
    expect(parseKonState(outside, 10)).not.toBeNull(); // без зоны — только пределы чисел
    expect(parseKonState(outside, 10, layout.zone)).toBeNull();
    const knockedFar = start.map((s, i) => (i === 4 ? [4, 1300, 420, 0, 0] : s));
    expect(parseKonState(knockedFar, 10, layout.zone)![4]).toEqual([4, 0, 0, 0, 0]);
    expect(await code(computeServerThrow(input({ konBefore: outside })))).toBe('bad_kon');
  });
});

describe('validateThrowBody', () => {
  it('тело запроса бросающего', () => {
    expect(validateThrowBody({ matchId: MATCH.toUpperCase(), throwNo: 3, angle: -0.2, power: 0.5, extra: 1 })).toEqual({
      ok: true,
      value: { matchId: MATCH, throwNo: 3, angle: -0.2, power: 0.5 },
    });
    expect(validateThrowBody([1, 2])).toEqual({ ok: false, error: 'bad_body' });
    expect(validateThrowBody({ matchId: MATCH, throwNo: 1, angle: 0 })).toEqual({ ok: false, error: 'bad_power' });
  });
});

describe('константы соревновательного режима', () => {
  it('ставка в config.ts совпадает со ставкой коллекции', () => {
    expect(COMP_STAKE).toBe(STAKE_SIZE);
  });
});
