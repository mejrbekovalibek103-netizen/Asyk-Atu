import { describe, expect, it } from 'vitest';
import { getStakeLayout } from '../levels/matchLayouts';
import { zoneCenter } from '../levels/zone';
import type { Piece } from '../physics/PhysicsWorld';
import { Effects } from '../render/effects';
import { compStateFixture, type Json } from './compFixture';
import { CompetitiveRules, compLayout, parseCompState, type CompView } from './CompetitiveRules';
import { PLAYER_STYLE } from './MatchRules';
import type { RulesHost } from './Rules';

const layout = getStakeLayout('stake-line', 2);

function fakeHost(left: { n: number }): RulesHost & { said: string[] } {
  const said: string[] = [];
  return {
    layout,
    effects: new Effects(true),
    said,
    say: (t) => said.push(t),
    schedule: (_ms, fn) => fn(),
    asyksLeft: () => left.n,
    zoneCenter: () => zoneCenter(layout.zone),
  };
}

const piece = (index: number) => ({ id: 1000 + index, index, kind: 'asyk', body: { position: { x: 400, y: 420 } } }) as unknown as Piece;

function setup(raw: Json = compStateFixture()) {
  const view = parseCompState(raw);
  if (!view) throw new Error('fixture не разобрана');
  const left = { n: layout.asyks.length };
  const done: CompView[] = [];
  const rules = new CompetitiveRules(view, (v) => done.push(v));
  const host = fakeHost(left);
  rules.attach(host);
  return { rules, left, host, done, view };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('parseCompState: разбор ответа comp_state', () => {
  it('настоящий ответ разбирается целиком', () => {
    const v = parseCompState(compStateFixture())!;
    expect(v).not.toBeNull();
    expect(v.status).toBe('active');
    expect(v.players).toBe(2);
    expect(v.konSize).toBe(10);
    expect(v.currentSeat).toBe(0);
    expect(v.mySeat).toBe(0);
    expect(v.throwNo).toBe(0);
    expect(v.konState).toBeNull();
    expect(v.roster.map((p) => p.name)).toEqual(['Айдос', 'Дана']);
    expect(v.roster[1].seenAgoMs).toBeNull();
    expect(v.slots).toHaveLength(10);
    expect(v.slots[3]).toEqual({ slot: 3, ownerSeat: 1, knockedBySeat: null, knockedThrow: null, mine: false });
    expect(v.turnDeadline).toBe(Date.parse('2026-11-13T10:00:43.000Z'));
    expect(v.stakedIds).toEqual([100, 102, 104, 106, 108]);
    expect(compLayout(v)).toBe(layout);
  });

  it('кон после броска и последний бросок', () => {
    const kon = layout.asyks.map((a, i) => (i === 4 ? [i, 0, 0, 0, 0] : [i, a.x, a.y, 0, 1]));
    const v = parseCompState(compStateFixture({ match: { throw_no: 1, current_seat: 1, kon_state: kon, last_throw: { throw_no: 1, seat: 0, angle: 0.1, power: 0.9, kon_before: null, knocked: [4], steps: 400 } } }))!;
    expect(v.konState).toHaveLength(10);
    expect(v.konState![4]).toEqual([4, 0, 0, 0, 0]);
    expect(v.lastThrow).toEqual({ throwNo: 1, seat: 0, knocked: [4], steps: 400 });
  });

  it('лишние поля отбрасываются, имя чистится и обрезается', () => {
    const raw = compStateFixture();
    (raw.match as Json).seed = 'deadbeef';
    (raw.players as Json[])[1].name = '\u0007Дана' + 'а'.repeat(60);
    const v = parseCompState(raw)!;
    expect(JSON.stringify(v)).not.toContain('deadbeef');
    expect(v.roster[1].name.startsWith('Дана')).toBe(true);
    expect(v.roster[1].name.length).toBeLessThanOrEqual(24);
  });

  it('до старта: мест и слотов ещё нет', () => {
    const raw = compStateFixture({
      match: { status: 'ready', players: null, current_seat: null, turn_started_at: null, turn_deadline: null, skip_absent_at: null, skip_at: null },
      me: { seat: null },
      slots: [],
    });
    for (const p of raw.players as Json[]) p.seat = null;
    const v = parseCompState(raw)!;
    expect(v).not.toBeNull();
    expect(v.players).toBe(2);
    expect(v.mySeat).toBeNull();
    expect(v.slots).toEqual([]);
  });

  const garbage: [string, (r: Json) => void][] = [
    ['не объект', () => undefined],
    ['неизвестный статус', (r) => ((r.match as Json).status = 'won')],
    ['чужой кон', (r) => ((r.match as Json).layout_id = 'ulken-kon')],
    ['дробный номер броска', (r) => ((r.match as Json).throw_no = 1.5)],
    ['отрицательный номер броска', (r) => ((r.match as Json).throw_no = -1)],
    ['ход за несуществующим местом', (r) => ((r.match as Json).current_seat = 2)],
    ['активный матч без хода', (r) => ((r.match as Json).current_seat = null)],
    ['кон не той длины', (r) => ((r.match as Json).kon_state = [[0, 1, 2, 0, 1]])],
    ['кон с NaN', (r) => ((r.match as Json).kon_state = layout.asyks.map((a, i) => [i, i === 2 ? 'x' : a.x, a.y, 0, 1]))],
    ['слоты кона не по порядку', (r) => ((r.match as Json).kon_state = layout.asyks.map((a, i) => [9 - i, a.x, a.y, 0, 1]))],
    ['kon_size не равен 5 · игроков', (r) => ((r.match as Json).kon_size = 12)],
    ['последний бросок из будущего', (r) => ((r.match as Json).last_throw = { throw_no: 3, seat: 0, knocked: [], steps: 10 })],
    ['два игрока на одном месте', (r) => ((r.players as Json[])[1].seat = 0)],
    ['игроков меньше, чем мест', (r) => (r.players as Json[]).pop()],
    ['выбито больше, чем в коне', (r) => ((r.players as Json[])[0].knocked = 11)],
    ['комбо больше выбитого', (r) => ((r.players as Json[])[0].best_combo = 3)],
    ['слот не на своём месте', (r) => ((r.slots as Json[])[2].slot = 5)],
    ['слотов не столько, сколько асыков', (r) => (r.slots as Json[]).pop()],
    ['хозяин слота — несуществующее место', (r) => ((r.slots as Json[])[0].owner_seat = 3)],
    ['время — не дата', (r) => ((r.match as Json).turn_deadline = 'завтра')],
    ['нет now', (r) => delete r.now],
    ['результат с мусором', (r) => (r.result = { refunded: 'да', won: [], returned: [], lost: [], delta: 0 })],
    ['имя — не строка', (r) => ((r.players as Json[])[0].name = 42)],
  ];
  for (const [name, spoil] of garbage) {
    it(`отказ: ${name}`, () => {
      if (name === 'не объект') {
        for (const v of [null, 1, 'x', [], undefined]) expect(parseCompState(v)).toBeNull();
        return;
      }
      const raw = compStateFixture();
      spoil(raw);
      expect(parseCompState(raw)).toBeNull();
    });
  }
});

describe('CompetitiveRules: состояние только из базы', () => {
  it('ход и право броска — из comp_state', () => {
    const { rules } = setup();
    expect(rules.canThrow()).toBe(true);
    expect(rules.nextThrowNo()).toBe(1);
    rules.importState(compStateFixture({ match: { throw_no: 1, current_seat: 1 } }));
    expect(rules.canThrow()).toBe(false);
    expect(rules.blockedHint()).toBe('Сейчас бросает Дана');
    expect(rules.nextThrowNo()).toBe(2);
    expect(rules.hud().current).toBe(1);
  });

  it('счёт и броски в HUD — из базы, по местам', () => {
    const { rules } = setup();
    const raw = compStateFixture({ match: { throw_no: 3, current_seat: 1 } });
    const ps = raw.players as Json[];
    Object.assign(ps[0], { throws: 2, real_throws: 2, knocked: 3, best_combo: 2 });
    Object.assign(ps[1], { throws: 1, real_throws: 0, knocked: 0 });
    rules.importState(raw);
    const h = rules.hud();
    expect(h.kind).toBe('match');
    expect(h.players).toEqual([
      { name: 'Айдос', knocked: 3, throws: 2 },
      { name: 'Дана', knocked: 0, throws: 1 },
    ]);
    expect(h.totalThrows).toBe(3);
    expect(h.maxThrows).toBe(30);
    expect(h.throwsPerPlayer).toBe(15);
    expect(h.localSeat).toBe(0);
    expect(h.handoff).toBe(false);
  });

  it('на экране бросок прибавляет выбитые сразу, а ответ базы заменяет прибавки точными числами', () => {
    const { rules, left } = setup();
    rules.onLaunch();
    rules.onKnockout(piece(2));
    rules.onKnockout(piece(2)); // повтор того же асыка — не считается
    rules.onKnockout(piece(5));
    left.n -= 2;
    rules.onSettled();
    expect(rules.hud().players[0]).toEqual({ name: 'Айдос', knocked: 2, throws: 1 });
    const raw = compStateFixture({ match: { throw_no: 1, current_seat: 1 } });
    Object.assign((raw.players as Json[])[0], { throws: 1, real_throws: 1, knocked: 2, best_combo: 2 });
    rules.importState(raw);
    expect(rules.hud().players[0]).toEqual({ name: 'Айдос', knocked: 2, throws: 1 });
  });

  it('конец матча решает только база', () => {
    const { rules, left, done } = setup();
    left.n = 0; // даже пустой кон на экране — не конец, пока база не скажет
    expect(rules.next()).toEqual({ kind: 'continue' });
    expect(rules.isOver()).toBe(false);
    rules.importState(
      compStateFixture({ match: { status: 'settled', throw_no: 30, current_seat: null, end_reason: 'throws_out' }, result: { refunded: false, won: [1, 3], returned: [0, 2, 4, 6, 8], lost: [], delta: 2 } }),
    );
    expect(rules.isOver()).toBe(true);
    expect(rules.canThrow()).toBe(false);
    expect(rules.next()).toEqual({ kind: 'finish' });
    rules.onFinish();
    rules.onFinish();
    expect(done).toHaveLength(1);
    expect(done[0].result).toEqual({ refunded: false, won: [1, 3], returned: [0, 2, 4, 6, 8], lost: [], delta: 2 });
    expect(rules.hud().finished).toBe(true);
  });

  it('сдавшийся не бросает', () => {
    const { rules } = setup();
    rules.importState(compStateFixture({ me: { forfeited: true }, now: '2026-11-13T10:00:01.000Z' }));
    expect(rules.canThrow()).toBe(false);
    expect(rules.blockedHint()).toContain('сдался');
  });

  it('мусор, чужой матч и устаревшие ответы не применяются', () => {
    const { rules } = setup(compStateFixture({ match: { throw_no: 4, current_seat: 0 }, now: '2026-11-13T10:01:00.000Z' }));
    const before = clone(rules.view());
    rules.importState({ match: 'x' });
    rules.importState(compStateFixture({ match: { id: '11111111-2222-4333-8444-555555555555', throw_no: 5, current_seat: 1 } }));
    rules.importState(compStateFixture({ match: { layout_id: 'stake-ring', throw_no: 5, current_seat: 1 } }));
    rules.importState(compStateFixture({ match: { throw_no: 3, current_seat: 1 }, now: '2026-11-13T10:02:00.000Z' })); // меньший номер
    rules.importState(compStateFixture({ match: { throw_no: 4, current_seat: 1 }, now: '2026-11-13T10:00:30.000Z' })); // раньше по часам базы
    expect(rules.view()).toEqual(before);
    // после конца матча живой статус не возвращается
    rules.importState(compStateFixture({ match: { status: 'void', throw_no: 4, current_seat: null, end_reason: 'version' }, now: '2026-11-13T10:01:05.000Z' }));
    rules.importState(compStateFixture({ match: { throw_no: 4, current_seat: 0 }, now: '2026-11-13T10:01:10.000Z' }));
    expect(rules.view().status).toBe('void');
  });

  it('parseCanonical: номер броска, кон и ждать ли запись', () => {
    const { rules } = setup();
    const kon = layout.asyks.map((a, i) => [i, a.x, a.y + 1, 0, 1]);
    const thrown = rules.parseCanonical(compStateFixture({ match: { throw_no: 1, current_seat: 1, kon_state: kon, last_throw: { throw_no: 1, seat: 0, knocked: [], steps: 300 } } }))!;
    expect(thrown.throwNo).toBe(1);
    expect(thrown.kon![0]).toEqual([0, layout.asyks[0].x, layout.asyks[0].y + 1, 0, 1]);
    expect(thrown.recordExpected).toBe(true);
    // пропуск: номер занят, а последний настоящий бросок — раньше; записи не будет
    const skipped = rules.parseCanonical(compStateFixture({ match: { throw_no: 2, current_seat: 0, kon_state: kon, last_throw: { throw_no: 1, seat: 0, knocked: [], steps: 300 } } }))!;
    expect(skipped.recordExpected).toBe(false);
    expect(rules.parseCanonical({})).toBeNull();
    expect(rules.parseCanonical(compStateFixture({ match: { layout_id: 'stake-ring' } }))).toBeNull();
  });

  it('тамга: цвет и точки хозяина по слоту', () => {
    const { rules } = setup();
    const marks = rules.ownerMarks()!;
    expect(marks).toHaveLength(10);
    expect(marks[0]).toEqual({ color: PLAYER_STYLE[0].color, dots: 1 });
    expect(marks[1]).toEqual({ color: PLAYER_STYLE[1].color, dots: 2 });
    expect(rules.ownerMarks()).toBe(marks); // без пересоздания каждый кадр
  });

  it('цвет сақа — у того, чей бросок', () => {
    const { rules } = setup(compStateFixture({ match: { current_seat: 1, throw_no: 1 } }));
    expect(rules.sakaPalette()).toBe(PLAYER_STYLE[1].palette);
    expect(rules.braceletColor()).toBe(PLAYER_STYLE[1].bracelet);
  });
});
