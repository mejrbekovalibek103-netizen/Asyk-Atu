import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLevel } from '../game/levels/levels';
import { getMatchLayout } from '../game/levels/matchLayouts';
import { PhysicsWorld } from '../game/physics/PhysicsWorld';
import type { AsykSpawn, MatchConfig } from '../game/types';
import { clearAllRounds, clearDuelRound, clearSoloRound, layoutSignature, loadDuelRound, loadSoloRound, ROUND_TTL_MS, saveDuelRound, saveSoloRound, updateSoloElapsed } from './roundSave';

/** Минимальная подмена localStorage для среды без браузера. */
function fakeStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), raw: m };
}

let store: ReturnType<typeof fakeStorage>;
beforeEach(() => {
  store = fakeStorage();
  vi.stubGlobal('localStorage', store);
});
afterEach(() => vi.unstubAllGlobals());

const SOLO_KEY = 'asyk-atu:round:solo:v1';
const DUEL_KEY = 'asyk-atu:round:duel:v1';

const level = getLevel('uime'); // 10 асыков, 5 бросков
const layout = getMatchLayout('ulken-kon'); // 12 асыков

/** Настоящий кон после того, как выбили указанные асыки (как его экспортирует движок). */
function asyksAfter(spawns: AsykSpawn[], knockedIds: number[]) {
  const w = new PhysicsWorld();
  w.addAsyks(spawns);
  for (const i of knockedIds) {
    const p = w.pieceByIndex(i)!;
    w.markOut(p, 1);
    w.removePiece(p);
  }
  return w.exportAsyks(spawns.length);
}

const soloState = () => ({
  asyks: asyksAfter(level.asyks, [0, 1, 2]),
  rules: { throwsUsed: 2, score: 45, knocked: 3, streak: 2, bestCombo: 2, hitThrows: 2, targetThrow: null, elapsedMs: 0 },
});

const config: MatchConfig = { layoutId: layout.id, players: ['Айдос', 'Дана'], first: 0 };
const duelState = () => ({
  asyks: asyksAfter(layout.asyks, [4, 5, 6]),
  rules: { current: 1, turnId: 4, knocked: [2, 1], throws: [2, 1], bestCombo: [2, 1], total: 3, finished: false },
});

const SOLO_SIG = layoutSignature(level, level.throws);
const DUEL_SIG = layoutSignature(layout);
const put = (key: string, value: unknown, savedAt = Date.now()) => store.raw.set(key, JSON.stringify({ v: 1, savedAt, ...(value as object) }));

describe('сохранение одиночного раунда', () => {
  it('сохранённый раунд читается без потерь', () => {
    const st = soloState();
    saveSoloRound(level, st);
    expect(loadSoloRound(level)).toEqual(st);
  });

  it('очистка удаляет сохранение (конец раунда, рестарт, уход с экрана)', () => {
    saveSoloRound(level, soloState());
    clearSoloRound();
    expect(loadSoloRound(level)).toBeNull();
  });

  it('чужое испытание не подхватывается', () => {
    saveSoloRound(level, soloState());
    expect(loadSoloRound(getLevel('kon'))).toBeNull();
  });

  it('если уровень изменился в новой версии игры (асык, камень, число бросков), старое сохранение отбрасывается', () => {
    saveSoloRound(level, soloState());
    const moved = { ...level, asyks: level.asyks.map((a, i) => (i === 0 ? { ...a, x: a.x + 1 } : a)) };
    expect(loadSoloRound(moved)).toBeNull();
    expect(loadSoloRound({ ...level, obstacles: [{ x: 300, y: 600, w: 100, h: 50 }] })).toBeNull();
    expect(loadSoloRound({ ...level, throws: level.throws + 1 })).toBeNull();
    expect(loadSoloRound(level)).not.toBeNull();
  });

  it('подпись уровня стабильна и различает уровни', () => {
    expect(layoutSignature(level, level.throws)).toBe(layoutSignature({ ...level }, level.throws));
    expect(layoutSignature(level, 5)).not.toBe(layoutSignature(getLevel('kon'), 5));
  });

  it('устаревшее сохранение (дольше 12 часов) и «из будущего» отбрасываются', () => {
    const now = Date.now();
    put(SOLO_KEY, { levelId: level.id, sig: SOLO_SIG, state: soloState() }, now - ROUND_TTL_MS - 1000);
    expect(loadSoloRound(level, now)).toBeNull();
    put(SOLO_KEY, { levelId: level.id, sig: SOLO_SIG, state: soloState() }, now - ROUND_TTL_MS + 60_000);
    expect(loadSoloRound(level, now)).not.toBeNull();
    put(SOLO_KEY, { levelId: level.id, sig: SOLO_SIG, state: soloState() }, now + 3_600_000);
    expect(loadSoloRound(level, now)).toBeNull();
  });

  it('повреждённые данные: не JSON, не объект, неверная версия, огромный размер', () => {
    for (const raw of ['не json', 'null', '[]', '5', JSON.stringify({ v: 2, savedAt: Date.now(), levelId: level.id, state: soloState() }), 'x'.repeat(30_000)]) {
      store.raw.set(SOLO_KEY, raw);
      expect(loadSoloRound(level), raw.slice(0, 30)).toBeNull();
    }
  });

  it('счёт не совпадает с коном: выбито по счёту не столько, сколько убрано с поля', () => {
    const st = soloState();
    put(SOLO_KEY, { levelId: level.id, sig: SOLO_SIG, state: { ...st, rules: { ...st.rules, knocked: 4, score: 60 } } });
    expect(loadSoloRound(level)).toBeNull();
  });

  it('подделанный кон: нет асыков, повтор номера, номер за пределами, координаты в космосе', () => {
    const st = soloState();
    const bad = [
      st.asyks.slice(1), // не хватает асыка
      [...st.asyks.slice(0, 9), st.asyks[0]], // повтор номера
      [...st.asyks.slice(0, 9), [99, 400, 400, 0, 1]], // номер вне расстановки
      st.asyks.map((a, i) => (i === 5 ? [5, 1e12, 400, 0, 1] : a)), // координата за пределами мира
      st.asyks.map((a, i) => (i === 5 ? [5, NaN, 400, 0, 1] : a)),
      'асыки',
    ];
    for (const asyks of bad) {
      put(SOLO_KEY, { levelId: level.id, sig: SOLO_SIG, state: { ...st, asyks } });
      expect(loadSoloRound(level), JSON.stringify(asyks).slice(0, 40)).toBeNull();
    }
  });

  it('«__proto__» в сохранении не загрязняет прототипы', () => {
    store.raw.set(SOLO_KEY, `{"v":1,"savedAt":${Date.now()},"levelId":"${level.id}","state":null,"__proto__":{"polluted":1}}`);
    loadSoloRound(level);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('хранилище недоступно (приватный режим): без исключений', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    });
    expect(() => saveSoloRound(level, soloState())).not.toThrow();
    expect(loadSoloRound(level)).toBeNull();
    expect(() => clearAllRounds()).not.toThrow();
  });
});

describe('сохранение матча вдвоём', () => {
  it('матч читается без потерь, включая «Передайте устройство»', () => {
    const st = duelState();
    saveDuelRound({ ...config, handoff: true }, st);
    expect(loadDuelRound()).toEqual({ config: { ...config, handoff: true }, state: st });
    saveDuelRound(config, st);
    expect(loadDuelRound()?.config.handoff).toBeUndefined();
  });

  it('кон изменился — старое сохранение матча отбрасывается', () => {
    saveDuelRound(config, duelState());
    expect(loadDuelRound()).not.toBeNull();
    store.raw.set(DUEL_KEY, store.raw.get(DUEL_KEY)!.replace(`"sig":"${DUEL_SIG}"`, '"sig":"0"'));
    expect(loadDuelRound()).toBeNull();
  });

  it('очистка удаляет сохранение', () => {
    saveDuelRound(config, duelState());
    clearDuelRound();
    expect(loadDuelRound()).toBeNull();
  });

  it('имена очищаются как любой ввод, неизвестный кон отвергается', () => {
    put(DUEL_KEY, { sig: DUEL_SIG, config: { ...config, players: ['‮evil​', 'Дана'] }, state: duelState() });
    expect(loadDuelRound()?.config.players).toEqual(['evil', 'Дана']);
    put(DUEL_KEY, { sig: DUEL_SIG, config: { ...config, layoutId: '../hack' }, state: duelState() });
    expect(loadDuelRound()).toBeNull();
  });

  it('счёт не совпадает с коном, окончен матч или нет бросков — не принимается', () => {
    const st = duelState();
    put(DUEL_KEY, { sig: DUEL_SIG, config, state: { ...st, rules: { ...st.rules, knocked: [3, 1] } } }); // выбито 4, убрано 3
    expect(loadDuelRound()).toBeNull();
    put(DUEL_KEY, { sig: DUEL_SIG, config, state: { ...st, rules: { ...st.rules, finished: true } } });
    expect(loadDuelRound()).toBeNull();
    put(DUEL_KEY, { sig: DUEL_SIG, config, state: { asyks: asyksAfter(layout.asyks, []), rules: { ...st.rules, knocked: [0, 0], throws: [0, 0], bestCombo: [0, 0], total: 0 } } });
    expect(loadDuelRound()).toBeNull();
  });

  it('очистка всех сохранений', () => {
    saveSoloRound(level, soloState());
    saveDuelRound(config, duelState());
    clearAllRounds();
    expect(loadSoloRound(level)).toBeNull();
    expect(loadDuelRound()).toBeNull();
  });
});

describe('испытание со временем: прошедшее время сохраняется между бросками', () => {
  const timed = { ...level, timeLimit: 60 };
  const stateWith = (elapsedMs: number) => {
    const st = soloState();
    return { ...st, rules: { ...st.rules, elapsedMs } };
  };

  it('время, записанное вместе с раундом, возвращается при загрузке', () => {
    saveSoloRound(timed, stateWith(20_000));
    expect(loadSoloRound(timed)?.rules).toMatchObject({ elapsedMs: 20_000 });
  });

  it('updateSoloElapsed дописывает время в сохранённый раунд, и только вперёд', () => {
    saveSoloRound(timed, stateWith(20_000));
    updateSoloElapsed(timed, 31_400);
    expect(loadSoloRound(timed)?.rules).toMatchObject({ elapsedMs: 31_400 });
    updateSoloElapsed(timed, 25_000); // запоздалый вызов не откатывает время назад
    expect(loadSoloRound(timed)?.rules).toMatchObject({ elapsedMs: 31_400 });
  });

  it('время ограничено лимитом: раунд с исчерпанным временем не «воскресает»', () => {
    saveSoloRound(timed, stateWith(20_000));
    updateSoloElapsed(timed, 999_999);
    expect(loadSoloRound(timed)?.rules).toMatchObject({ elapsedMs: 59_999 });
  });

  it('без сохранения, для другого испытания и без лимита времени — ничего не делает', () => {
    updateSoloElapsed(timed, 10_000); // сохранения нет
    expect(store.raw.has(SOLO_KEY)).toBe(false);
    saveSoloRound(timed, stateWith(5_000));
    updateSoloElapsed({ ...getLevel('kon'), timeLimit: 60 }, 40_000); // чужое испытание
    updateSoloElapsed(level, 40_000); // у этого испытания лимита времени нет
    expect(loadSoloRound(timed)?.rules).toMatchObject({ elapsedMs: 5_000 });
  });

  it('подделанное время (больше лимита, дробное) не принимается', () => {
    for (const bad of [60_000, 1e12, -1, 1.5, '5']) {
      put(SOLO_KEY, { levelId: timed.id, sig: layoutSignature(timed, timed.throws), state: stateWith(bad as number) });
      expect(loadSoloRound(timed), String(bad)).toBeNull();
    }
  });
});
