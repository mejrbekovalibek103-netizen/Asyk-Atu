import { describe, expect, it } from 'vitest';
import { getLevel } from '../levels/levels';
import { zoneCenter } from '../levels/zone';
import type { Piece } from '../physics/PhysicsWorld';
import { Effects } from '../render/effects';
import type { RoundResult } from '../types';
import type { RulesHost } from './Rules';
import { SoloRules } from './SoloRules';
import { parseSoloState } from './soloState';

const level = getLevel('uime'); // 10 асыков, 5 бросков
const mergen = getLevel('mergen'); // 3 броска, синий асык

function fakeHost(layout: typeof level, left: { n: number }, said: string[] = []): RulesHost {
  return {
    layout,
    effects: new Effects(true),
    say: (text) => void said.push(text),
    schedule: (_ms, fn) => fn(),
    asyksLeft: () => left.n,
    zoneCenter: () => zoneCenter(layout.zone),
  };
}

const piece = (id: number, kind: 'asyk' | 'target' = 'asyk') => ({ id, kind, body: { position: { x: 400, y: 300 } } }) as unknown as Piece;

/** Один бросок по правилам одиночной игры: выбивает указанные асыки. */
function play(rules: SoloRules, left: { n: number }, ...ids: number[]) {
  const throwIndex = rules.onLaunch();
  for (const id of ids) {
    rules.onKnockout(piece(id), throwIndex);
    left.n -= 1;
  }
  rules.onSettled(throwIndex);
  return rules.next();
}

function make(lv = level) {
  const left = { n: lv.asyks.length };
  const said: string[] = [];
  let result: RoundResult | null = null;
  const rules = new SoloRules(lv, false, (r) => (result = r));
  rules.attach(fakeHost(lv, left, said));
  return { rules, left, said, result: () => result };
}

describe('SoloRules: сохранение и продолжение раунда', () => {
  it('восстановленный раунд ведёт счёт так же, как оригинал (комбо, серия, итог)', () => {
    const a = make();
    play(a.rules, a.left, 0, 1); // комбо ×2
    play(a.rules, a.left, 2); // серия
    const saved = JSON.parse(JSON.stringify(a.rules.exportState())); // как через localStorage

    const b = make();
    b.left.n = level.asyks.length - 3; // в коне осталось на 3 асыка меньше (их убирает движок по снимку кона)
    b.rules.importState(saved);
    expect(b.rules.hud()).toMatchObject({ throwsUsed: 2, knocked: 3, score: a.rules.hud().kind === 'solo' ? (a.rules.hud() as { score: number }).score : 0 });

    // дальше оба играют одинаково — и счёт, и итог совпадают
    play(a.rules, a.left, 3);
    play(b.rules, b.left, 3);
    const ha = a.rules.hud() as { score: number; streak: number; knocked: number; throwsUsed: number };
    const hb = b.rules.hud() as { score: number; streak: number; knocked: number; throwsUsed: number };
    expect(hb).toMatchObject({ score: ha.score, streak: ha.streak, knocked: ha.knocked, throwsUsed: ha.throwsUsed });
    expect(hb.streak).toBe(3);
  });

  it('при запуске сообщает, что раунд продолжен, и считает оставшиеся броски', () => {
    const a = make();
    play(a.rules, a.left, 0);
    const b = make();
    b.rules.importState(a.rules.exportState());
    b.rules.onStart();
    expect(b.said[0]).toContain('Раунд продолжен');
    expect(b.said[0]).toContain('осталось 4');
    // повторный запуск (рестарт) сообщения не повторяет
    b.rules.onStart();
    expect(b.said).toHaveLength(1);
  });

  it('рестарт после восстановления обнуляет счёт', () => {
    const a = make();
    play(a.rules, a.left, 0, 1);
    const b = make();
    b.rules.importState(a.rules.exportState());
    b.rules.reset();
    expect(b.rules.hud()).toMatchObject({ throwsUsed: 0, knocked: 0, score: 0 });
  });

  it('раунд можно доиграть до конца и получить итог', () => {
    const a = make();
    play(a.rules, a.left, 0);
    play(a.rules, a.left);
    const b = make();
    b.left.n = level.asyks.length - 1;
    b.rules.importState(JSON.parse(JSON.stringify(a.rules.exportState())));
    expect(play(b.rules, b.left, 1).kind).toBe('continue'); // 3-й бросок
    expect(play(b.rules, b.left).kind).toBe('continue'); // 4-й
    expect(play(b.rules, b.left).kind).toBe('finish'); // 5-й: броски кончились
    b.rules.onFinish();
    expect(b.result()).toMatchObject({ throwsUsed: 5, knocked: 2 });
  });

  it('подделанное состояние не принимается: раунд остаётся чистым', () => {
    const b = make();
    b.rules.importState({ throwsUsed: 2, score: 1e9, knocked: 3, streak: 1, bestCombo: 2, hitThrows: 2, targetThrow: null });
    expect(b.rules.hud()).toMatchObject({ throwsUsed: 0, knocked: 0, score: 0 });
  });
});

describe('parseSoloState: проверка сохранённого счёта', () => {
  const good = { throwsUsed: 2, score: 45, knocked: 3, streak: 2, bestCombo: 2, hitThrows: 2, targetThrow: null };

  it('честное состояние читается без потерь, лишние поля отбрасываются', () => {
    expect(parseSoloState(good, level)).toEqual(good);
    expect(parseSoloState({ ...good, evil: 1, __proto__: { x: 1 } }, level)).toEqual(good);
    expect(parseSoloState({ ...good, targetThrow: undefined }, level)).toEqual(good);
  });

  it('не объект / не числа / дробные / NaN', () => {
    for (const raw of [null, undefined, 5, 'x', [], [good]]) expect(parseSoloState(raw, level)).toBeNull();
    for (const k of Object.keys(good) as (keyof typeof good)[]) {
      if (k === 'targetThrow') continue;
      for (const v of ['2', NaN, Infinity, -1, 1.5, null]) expect(parseSoloState({ ...good, [k]: v }, level), `${k}=${String(v)}`).toBeNull();
    }
  });

  it('границы: броски 1…(лимит−1), выбито не больше асыков', () => {
    expect(parseSoloState({ ...good, throwsUsed: 0 }, level)).toBeNull(); // нечего сохранять
    expect(parseSoloState({ ...good, throwsUsed: level.throws }, level)).toBeNull(); // раунд уже окончен
    expect(parseSoloState({ ...good, knocked: level.asyks.length + 1 }, level)).toBeNull();
  });

  it('взаимосвязи: очки, серия, комбо, результативные броски', () => {
    expect(parseSoloState({ ...good, score: 1_000_000 }, level)).toBeNull(); // слишком много очков
    expect(parseSoloState({ ...good, score: 5 }, level)).toBeNull(); // меньше, чем за выбитые асыки
    expect(parseSoloState({ ...good, hitThrows: 5, throwsUsed: 4 }, level)).toBeNull(); // результативных бросков больше, чем бросков
    expect(parseSoloState({ ...good, streak: 3 }, level)).toBeNull(); // серия длиннее числа результативных бросков
    expect(parseSoloState({ ...good, bestCombo: 4 }, level)).toBeNull(); // комбо больше выбитых
    expect(parseSoloState({ ...good, knocked: 1, hitThrows: 2 }, level)).toBeNull(); // 2 результативных броска при 1 асыке
    expect(parseSoloState({ ...good, knocked: 0, score: 0, hitThrows: 1, streak: 1, bestCombo: 0 }, level)).toBeNull(); // «результативный» без асыков
  });

  it('синий асык: номер броска допустим только на уровне с синим асыком и не позже сделанных бросков', () => {
    const withTarget = { throwsUsed: 2, score: 70, knocked: 1, streak: 1, bestCombo: 1, hitThrows: 1, targetThrow: 2 };
    expect(parseSoloState(withTarget, mergen)).toEqual(withTarget);
    expect(parseSoloState(withTarget, level)).toBeNull(); // на «Горке» синего асыка нет
    expect(parseSoloState({ ...withTarget, targetThrow: 3 }, mergen)).toBeNull(); // бросок №3 ещё не сделан
    expect(parseSoloState({ ...withTarget, targetThrow: 0 }, mergen)).toBeNull();
  });
});
