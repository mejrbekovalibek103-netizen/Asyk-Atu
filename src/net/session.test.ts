import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMatchLayout } from '../game/levels/matchLayouts';
import { PhysicsWorld } from '../game/physics/PhysicsWorld';
import { makeClientId } from './protocol';
import { loadRoomSession, saveRoomSession, type RoomSession } from './session';

/** Минимальная подмена sessionStorage для среды без браузера. */
function fakeStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), raw: m };
}

const CODE = 'ABCDEFGHJK';
const KEY = `asyk-atu:room:${CODE}`;
let store: ReturnType<typeof fakeStorage>;

beforeEach(() => {
  store = fakeStorage();
  vi.stubGlobal('sessionStorage', store);
});
afterEach(() => vi.unstubAllGlobals());

const good = (): RoomSession => ({
  clientId: makeClientId(),
  seat: 0,
  name: 'Айдос',
  layoutId: 'ulken-kon',
  match: { config: { layoutId: 'ulken-kon', players: ['Айдос', 'Дана'], first: 0 }, matchId: 3 },
});

describe('сессия комнаты в sessionStorage', () => {
  it('корректная сессия читается без потерь', () => {
    const s = good();
    saveRoomSession(CODE, s);
    expect(loadRoomSession(CODE)).toEqual(s);
  });

  it('настоящий снимок матча (после нескольких бросков) читается без потерь', () => {
    const layout = getMatchLayout('ulken-kon');
    const w = new PhysicsWorld();
    w.addAsyks(layout.asyks);
    const out = w.pieceByIndex(4)!;
    w.markOut(out, 1);
    w.removePiece(out); // асык №4 выбит
    const base = good();
    const state = {
      asyks: w.exportAsyks(layout.asyks.length),
      rules: { current: 1, turnId: 4, knocked: [1, 0], throws: [2, 1], bestCombo: [1, 0], total: 3, finished: false },
    };
    const s: RoomSession = { ...base, match: { ...base.match!, state } };
    saveRoomSession(CODE, s);
    const loaded = loadRoomSession(CODE)!;
    expect(loaded.match?.state).toEqual(state);
  });

  it('подделка не принимается: неверный id, место, не JSON, не объект', () => {
    for (const raw of ['не json', 'null', '[]', '5', '"x"', JSON.stringify({ ...good(), clientId: '../../x' }), JSON.stringify({ ...good(), seat: 4 }), JSON.stringify({ ...good(), seat: -1 }), JSON.stringify({ ...good(), seat: 1.5 }), JSON.stringify({ ...good(), clientId: 5 })]) {
      store.raw.set(KEY, raw);
      expect(loadRoomSession(CODE), raw.slice(0, 40)).toBeNull();
    }
  });

  it('огромная строка отвергается без разбора', () => {
    store.raw.set(KEY, JSON.stringify({ ...good(), name: 'x'.repeat(300_000) }));
    expect(loadRoomSession(CODE)).toBeNull();
  });

  it('имя очищается, неизвестный кон сбрасывается', () => {
    store.raw.set(KEY, JSON.stringify({ ...good(), name: '‮evil​', layoutId: '../hack' }));
    const s = loadRoomSession(CODE)!;
    expect(s.name).toBe('evil');
    expect(s.layoutId).toBe('');
  });

  it('подделанный матч отбрасывается, а сама сессия (место) остаётся', () => {
    store.raw.set(KEY, JSON.stringify({ ...good(), match: { config: { layoutId: 'нет такого', players: ['a', 'b'], first: 0 }, matchId: 1 } }));
    const s = loadRoomSession(CODE)!;
    expect(s.match).toBeNull();
    expect(s.seat).toBe(0);
  });

  it('подделанный снимок отбрасывается, а матч остаётся', () => {
    const base = good();
    store.raw.set(KEY, JSON.stringify({ ...base, match: { ...base.match, state: { asyks: [[0, 1e12, 1, 0, 1]], rules: { current: 0 } } } }));
    const s = loadRoomSession(CODE)!;
    expect(s.match?.matchId).toBe(3);
    expect(s.match?.state).toBeUndefined();
  });

  it('«__proto__» в сохранённых данных не загрязняет прототипы', () => {
    store.raw.set(KEY, `{"clientId":"${makeClientId()}","seat":1,"name":"x","layoutId":"","match":null,"__proto__":{"polluted":1}}`);
    loadRoomSession(CODE);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
