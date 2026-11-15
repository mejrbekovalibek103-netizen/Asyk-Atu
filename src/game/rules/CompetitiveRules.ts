import { sound } from '../audio/sound';
import { getStakeLayout, isStakeLayout, type StakeLayoutId } from '../levels/matchLayouts';
import { zoneEdgePoint } from '../levels/zone';
import type { AsykState, Piece } from '../physics/PhysicsWorld';
import type { AsykPalette, OwnerMark } from '../render/asykShape';
import { parseKonState } from '../sim/edgeEntry';
import type { KonLayout, MatchHud, Seat } from '../types';
import { plural } from '../../ui/format';
import { PLAYER_STYLE } from './MatchRules';
import type { CanonicalState, NextStep, Rules, RulesHost } from './Rules';

/**
 * Соревновательный матч «на асыки». Эти правила НИЧЕГО не решают сами: чей ход, сколько выбито, сколько бросков
 * и когда конец — всё берётся из состояния базы (`comp_state`), которое движок передаёт через `applyCanonical`.
 * Сами правила только показывают бросок (очки «+1», комбо, подсказки) и отдают интерфейсу HUD в формате
 * обычного матча (`MatchHud`), чтобы работали те же карточки игроков и баннер хода.
 *
 * Пока проигрывается запись броска, к счёту из базы временно прибавляется то, что видно на экране
 * (выбитые этим броском); следующее состояние из базы заменяет эти прибавки точными числами.
 */

export type CompStatus = 'forming' | 'ready' | 'active' | 'settled' | 'cancelled' | 'void';

/** Игрок матча из comp_state.players. */
export interface CompPlayerView {
  /** Место за «столом»; null — места ещё не розданы (до старта). */
  seat: Seat | null;
  lobbySlot: number;
  name: string;
  isMe: boolean;
  isHost: boolean;
  staked: boolean;
  ready: boolean;
  forfeited: boolean;
  active: boolean;
  throws: number;
  realThrows: number;
  knocked: number;
  bestCombo: number;
  skipsInRow: number;
  /** Сколько мс назад был пульс (null — не было). */
  seenAgoMs: number | null;
  online: boolean;
}

/** Слот кона из comp_state.slots (слот = номер асыка в раскладке). */
export interface CompSlotView {
  slot: number;
  ownerSeat: Seat | null;
  knockedBySeat: Seat | null;
  knockedThrow: number | null;
  mine: boolean;
}

export interface CompResultView {
  /** Матч отменён — все ставки вернулись. */
  refunded: boolean;
  /** Слоты чужих асыков, которые достались мне. */
  won: number[];
  /** Мои асыки, вернувшиеся мне. */
  returned: number[];
  /** Мои асыки, выбитые соперником. */
  lost: number[];
  /** Итог: сколько асыков прибавилось (может быть меньше нуля). */
  delta: number;
}

export interface CompLastThrow {
  throwNo: number;
  seat: Seat;
  knocked: number[];
  steps: number;
}

/** Проверенное состояние соревновательного матча (из comp_state). Время — мс от эпохи (Date.parse). */
export interface CompView {
  matchId: string;
  joinCode: string;
  layoutId: StakeLayoutId;
  status: CompStatus;
  /** Число игроков (до старта — сколько сейчас в лобби). */
  players: number;
  maxPlayers: number;
  stakeSize: number;
  konSize: number;
  throwsPerPlayer: number;
  turnSeconds: number;
  currentSeat: Seat | null;
  /** Последний занятый номер броска; следующий = throwNo + 1. */
  throwNo: number;
  /** Кон после последнего броска; null — исходная раскладка. */
  konState: AsykState[] | null;
  lastThrow: CompLastThrow | null;
  serverNow: number;
  turnStartedAt: number | null;
  turnDeadline: number | null;
  skipAbsentAt: number | null;
  skipAt: number | null;
  readyDeadline: number | null;
  pending: boolean;
  playersRev: number;
  endReason: string | null;
  mySeat: Seat | null;
  myLobbySlot: number | null;
  isHost: boolean;
  myStaked: boolean;
  myReady: boolean;
  myForfeited: boolean;
  /** id моих асыков под замком этого матча. */
  stakedIds: number[];
  /** Игроки в порядке базы: по месту, потом по месту в лобби. */
  roster: CompPlayerView[];
  /** Слоты кона по порядку (до старта — пусто). */
  slots: CompSlotView[];
  result: CompResultView | null;
}

const STATUSES: readonly CompStatus[] = ['forming', 'ready', 'active', 'settled', 'cancelled', 'void'];
/** Матч окончен — ни бросков, ни смены хода больше не будет. */
const FINAL: readonly CompStatus[] = ['settled', 'cancelled', 'void'];
const MAX_PLAYERS = 4;
const MAX_KON = 5 * MAX_PLAYERS;
const MAX_THROW_NO = 9_999;
const MAX_NAME = 24;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** Признак «поле неверное»: парсер полей бросает его, а parseCompState превращает в null. */
class Bad extends Error {}
const bad = (): never => {
  throw new Bad();
};

function int(v: unknown, lo: number, hi: number): number {
  return isInt(v, lo, hi) ? v : bad();
}
function intOrNull(v: unknown, lo: number, hi: number): number | null {
  return v === null || v === undefined ? null : int(v, lo, hi);
}
function bool(v: unknown): boolean {
  return typeof v === 'boolean' ? v : bad();
}
/** Необязательный флаг: нет поля — false. */
function flag(v: unknown): boolean {
  return v === undefined || v === null ? false : bool(v);
}
function str(v: unknown, max: number): string {
  return typeof v === 'string' && v.length <= max ? v : bad();
}
/** Время timestamptz (ISO-строка) → мс; null — нет. */
function time(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' || v.length > 64) return bad();
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : bad();
}
function seatOrNull(v: unknown, n: number): Seat | null {
  return intOrNull(v, 0, n - 1) as Seat | null;
}
function intList(v: unknown, lo: number, hi: number, max: number): number[] {
  if (!Array.isArray(v) || v.length > max) return bad();
  return v.map((x) => int(x, lo, hi));
}
/** Имя из базы: только для показа — обрезаем, управляющие символы убираем. */
function cleanName(v: unknown): string {
  const s = str(v, 200).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s.slice(0, MAX_NAME) || 'Игрок';
}

/**
 * Строгая проверка ответа comp_state. Возвращает НОВЫЙ объект только с известными полями или null, если что-то
 * не так: неизвестный статус или кон, числа вне пределов, места не по порядку, кон не той длины и т. п.
 * Данные приходят из базы, но проверяются так же строго, как сообщения от соперника.
 */
export function parseCompState(raw: unknown): CompView | null {
  try {
    return parseOrThrow(raw);
  } catch (e) {
    if (e instanceof Bad) return null;
    throw e;
  }
}

function parseOrThrow(raw: unknown): CompView {
  if (!isObj(raw) || !isObj(raw.match) || !isObj(raw.me) || !Array.isArray(raw.players) || !Array.isArray(raw.slots)) return bad();
  const m = raw.match;
  const me = raw.me;

  const status = STATUSES.find((s) => s === m.status) ?? bad();
  const layoutId = isStakeLayout(m.layout_id) ? m.layout_id : bad();
  if (raw.players.length < 1 || raw.players.length > MAX_PLAYERS) return bad();
  const players = m.players === null || m.players === undefined ? raw.players.length : int(m.players, 2, MAX_PLAYERS);
  const started = status !== 'forming' && status !== 'ready';
  // после старта число игроков закреплено; до старта его может не быть
  if (started && m.players !== players) return bad();
  const stakeSize = int(m.stake_size, 1, 5);
  const konSize = int(m.kon_size, 1, MAX_KON);
  if (konSize !== stakeSize * players && started) return bad();
  const throwNo = int(m.throw_no, 0, MAX_THROW_NO);
  const currentSeat = seatOrNull(m.current_seat, players);
  if (status === 'active' && currentSeat === null) return bad();

  const konState = m.kon_state === null || m.kon_state === undefined ? null : (parseKonState(m.kon_state, konSize) ?? bad());

  let lastThrow: CompLastThrow | null = null;
  if (m.last_throw !== null && m.last_throw !== undefined) {
    const lt = isObj(m.last_throw) ? m.last_throw : bad();
    lastThrow = {
      throwNo: int(lt.throw_no, 1, MAX_THROW_NO),
      seat: int(lt.seat, 0, players - 1) as Seat,
      knocked: intList(lt.knocked, 0, konSize - 1, konSize),
      steps: int(lt.steps, 0, 3_000),
    };
    if (lastThrow.throwNo > throwNo) return bad();
  }

  const roster: CompPlayerView[] = raw.players.map((p) => {
    if (!isObj(p)) return bad();
    return {
      seat: seatOrNull(p.seat, players),
      lobbySlot: int(p.lobby_slot, 0, 63),
      name: cleanName(p.name),
      isMe: flag(p.is_me),
      isHost: flag(p.is_host),
      staked: flag(p.staked),
      ready: flag(p.ready),
      forfeited: flag(p.forfeited),
      active: flag(p.active),
      throws: int(p.throws, 0, MAX_THROW_NO),
      realThrows: int(p.real_throws, 0, MAX_THROW_NO),
      knocked: int(p.knocked, 0, MAX_KON),
      bestCombo: int(p.best_combo, 0, MAX_KON),
      skipsInRow: int(p.skips_in_row, 0, MAX_THROW_NO),
      seenAgoMs: intOrNull(p.seen_ago_ms, 0, Number.MAX_SAFE_INTEGER),
      online: flag(p.online),
    };
  });
  if (roster.filter((p) => p.isMe).length > 1) return bad();
  if (started) {
    // после старта у каждого своё место 0…N-1, без повторов
    const seats = roster.map((p) => p.seat);
    if (roster.length !== players || seats.some((s, i) => s === null || seats.indexOf(s) !== i)) return bad();
    if (roster.reduce((a, p) => a + p.knocked, 0) > konSize) return bad();
    if (roster.some((p) => p.bestCombo > p.knocked || p.realThrows > p.throws)) return bad();
  }

  if (raw.slots.length > MAX_KON) return bad();
  const slots: CompSlotView[] = raw.slots.map((s, k) => {
    if (!isObj(s) || s.slot !== k) return bad();
    return {
      slot: k,
      ownerSeat: seatOrNull(s.owner_seat, players),
      knockedBySeat: seatOrNull(s.knocked_by_seat, players),
      knockedThrow: intOrNull(s.knocked_throw, 1, MAX_THROW_NO),
      mine: flag(s.mine),
    };
  });
  if (started && slots.length !== konSize) return bad();

  let result: CompResultView | null = null;
  if (raw.result !== null && raw.result !== undefined) {
    const r = isObj(raw.result) ? raw.result : bad();
    result = {
      refunded: bool(r.refunded),
      won: intList(r.won, 0, MAX_KON - 1, MAX_KON),
      returned: intList(r.returned, 0, MAX_KON - 1, MAX_KON),
      lost: intList(r.lost, 0, MAX_KON - 1, MAX_KON),
      delta: int(r.delta, -MAX_KON, MAX_KON),
    };
  }

  const serverNow = time(raw.now) ?? bad();
  return {
    matchId: str(m.id, 64).toLowerCase(),
    joinCode: str(m.join_code, 32),
    layoutId,
    status,
    players,
    maxPlayers: int(m.max_players, 2, MAX_PLAYERS),
    stakeSize,
    konSize,
    throwsPerPlayer: int(m.throws_per_player, 1, 100),
    turnSeconds: int(m.turn_seconds, 1, 3_600),
    currentSeat,
    throwNo,
    konState,
    lastThrow,
    serverNow,
    turnStartedAt: time(m.turn_started_at),
    turnDeadline: time(m.turn_deadline),
    skipAbsentAt: time(m.skip_absent_at),
    skipAt: time(m.skip_at),
    readyDeadline: time(m.ready_deadline),
    pending: flag(m.pending),
    playersRev: m.players_rev === undefined || m.players_rev === null ? 0 : int(m.players_rev, 0, Number.MAX_SAFE_INTEGER),
    endReason: m.end_reason === null || m.end_reason === undefined ? null : str(m.end_reason, 32),
    mySeat: seatOrNull(me.seat, players),
    myLobbySlot: intOrNull(me.lobby_slot, 0, 63),
    isHost: flag(me.is_host),
    myStaked: flag(me.staked),
    myReady: flag(me.ready),
    myForfeited: flag(me.forfeited),
    stakedIds: me.staked_ids === undefined || me.staked_ids === null ? [] : intList(me.staked_ids, 1, Number.MAX_SAFE_INTEGER, 64),
    roster,
    slots,
    result,
  };
}

/** Кон матча: раскладка ядра для его id и числа игроков (слот = номер асыка). */
export function compLayout(v: CompView): KonLayout {
  return getStakeLayout(v.layoutId, v.players);
}

/** Матч окончен (раздача, отмена или аннулирование). */
export function isCompFinal(status: CompStatus): boolean {
  return FINAL.includes(status);
}

export class CompetitiveRules implements Rules {
  private host!: RulesHost;
  private v: CompView;
  private turnId = 1;
  /** Чей бросок сейчас показывается (место); null — бросок не идёт. */
  private thrower: Seat | null = null;
  /** Выбито этим броском на экране (до ответа базы). */
  private thisThrow = 0;
  private readonly thisThrowIds = new Set<number>();
  /** Прибавки к счёту базы по местам, пока база не прислала новое состояние. */
  private liveKnocked: number[];
  private liveThrows: number[];
  private finished = false;
  private marks: (OwnerMark | null)[] | null = null;

  /**
   * @param initial проверенное состояние (parseCompState); раскладку движку дать `compLayout(initial)`
   * @param onComplete матч окончен — вызывается один раз, с последним состоянием базы (итоги в `result`)
   */
  constructor(
    initial: CompView,
    private readonly onComplete?: (v: CompView) => void,
  ) {
    this.v = initial;
    this.liveKnocked = new Array<number>(initial.players).fill(0);
    this.liveThrows = new Array<number>(initial.players).fill(0);
  }

  attach(host: RulesHost): void {
    this.host = host;
  }

  /** Последнее принятое состояние базы. */
  view(): CompView {
    return this.v;
  }

  private player(seat: Seat | null): CompPlayerView | undefined {
    return seat === null ? undefined : this.v.roster.find((p) => p.seat === seat);
  }

  private name(seat: Seat | null): string {
    return this.player(seat)?.name ?? 'соперник';
  }

  onStart(): void {
    if (this.v.status !== 'active') return;
    const who = this.name(this.v.currentSeat);
    this.host.say(this.v.throwNo > 0 ? `Матч продолжен · ходит ${who}` : `Первым бросает ${who}`, 'info', 2600);
  }

  canThrow(): boolean {
    const v = this.v;
    return !this.finished && v.status === 'active' && v.mySeat !== null && v.currentSeat === v.mySeat && !v.myForfeited;
  }

  blockedHint(): string {
    const v = this.v;
    if (isCompFinal(v.status) || this.finished) return 'Матч окончен';
    if (v.status !== 'active') return 'Матч ещё не начался';
    if (v.mySeat === null) return 'Ты смотришь матч';
    if (v.myForfeited) return 'Ты сдался — бросать больше нельзя';
    return `Сейчас бросает ${this.name(v.currentSeat)}`;
  }

  nextThrowNo(): number {
    return this.v.throwNo + 1;
  }

  onLaunch(): number {
    this.thrower = this.v.currentSeat;
    this.thisThrow = 0;
    this.thisThrowIds.clear();
    if (this.thrower !== null) this.liveThrows[this.thrower] += 1;
    return this.v.throwNo + 1;
  }

  onKnockout(p: Piece): void {
    const seat = this.thrower;
    if (seat === null || this.finished || this.thisThrowIds.has(p.index)) return;
    this.thisThrowIds.add(p.index);
    this.liveKnocked[seat] += 1;
    this.thisThrow += 1;
    const pos = p.body.position;
    this.host.effects.chalkBurst(zoneEdgePoint(this.host.layout.zone, pos));
    this.host.effects.popup(pos.x, pos.y - 24, '+1', PLAYER_STYLE[seat].color, 36);
    sound.knockout(this.thisThrow);
  }

  onSettled(): void {
    const n = this.thisThrow;
    const who = this.name(this.thrower);
    if (n >= 2) {
      const c = this.host.zoneCenter();
      this.host.effects.popup(c.x, c.y - 40, `КОМБО ×${n}`, '#ffb13b', 40, 1500);
      sound.bonus();
    }
    if (this.host.asyksLeft() === 0) this.host.say(`${who}: +${n} — кон пуст!`, 'good');
    else if (n > 0) this.host.say(`${who}: +${n} ${plural(n, ['асык', 'асыка', 'асыков'])}!`, 'good', 1600);
    else {
      this.host.say('Мимо!', 'warn', 1400);
      sound.miss();
    }
  }

  /** Конец решает только база: матч окончен, когда её статус — раздача, отмена или аннулирование. */
  next(): NextStep {
    this.thrower = null;
    return this.isOver() ? { kind: 'finish' } : { kind: 'continue' };
  }

  isOver(): boolean {
    return isCompFinal(this.v.status);
  }

  onFinish(): void {
    if (this.finished) return;
    this.finished = true;
    this.thrower = null;
    sound.roundEnd(true);
    // итоги (result) могут прийти чуть позже — отдаём самое свежее состояние на момент показа
    this.host.schedule(900, () => this.onComplete?.(this.v));
  }

  reset(): void {
    this.thrower = null;
    this.thisThrow = 0;
    this.thisThrowIds.clear();
    this.liveKnocked.fill(0);
    this.liveThrows.fill(0);
  }

  hud(): MatchHud {
    const v = this.v;
    const n = v.players;
    const bySeat = Array.from({ length: n }, (_, s) => this.player(s as Seat));
    // до раздачи мест (лобби, «Я здесь») — по порядку базы
    const list = bySeat.every((p) => p) ? (bySeat as CompPlayerView[]) : v.roster.slice(0, n);
    const players = Array.from({ length: n }, (_, s) => {
      const p = list[s];
      return {
        name: p?.name ?? '—',
        knocked: (p?.knocked ?? 0) + (this.liveKnocked[s] ?? 0),
        throws: (p?.throws ?? 0) + (this.liveThrows[s] ?? 0),
      };
    });
    return {
      kind: 'match',
      players,
      current: (this.thrower ?? v.currentSeat ?? 0) as Seat,
      turnId: this.turnId,
      totalThrows: players.reduce((a, p) => a + p.throws, 0),
      maxThrows: v.throwsPerPlayer * n,
      throwsPerPlayer: v.throwsPerPlayer,
      asyksLeft: this.host.asyksLeft(),
      totalAsyks: this.host.layout.asyks.length,
      localSeat: v.mySeat,
      finished: this.finished || isCompFinal(v.status),
      handoff: false,
    };
  }

  exportState(): CompView {
    return this.v;
  }

  parseCanonical(raw: unknown): CanonicalState | null {
    const v = parseCompState(raw);
    if (!v || !this.accepts(v)) return null;
    return {
      throwNo: v.throwNo,
      kon: v.konState,
      recordExpected: v.lastThrow !== null && v.lastThrow.throwNo === v.throwNo,
      rules: raw,
    };
  }

  /**
   * Принимает только проверенное состояние своего матча и не даёт ему «откатиться»: устаревший ответ
   * (меньший номер броска, более ранние часы базы, живой статус после конца) отбрасывается.
   */
  importState(raw: unknown): void {
    const v = parseCompState(raw);
    if (!v || !this.accepts(v)) return;
    const old = this.v;
    if (v.throwNo < old.throwNo) return;
    if (v.throwNo === old.throwNo && v.serverNow < old.serverNow) return;
    if (isCompFinal(old.status) && !isCompFinal(v.status)) return;
    if (v.throwNo !== old.throwNo || v.currentSeat !== old.currentSeat || v.status !== old.status) this.turnId += 1;
    this.v = v;
    this.marks = null;
    // база прислала точные числа — временные прибавки больше не нужны
    this.liveKnocked.fill(0);
    this.liveThrows.fill(0);
  }

  private accepts(v: CompView): boolean {
    const layout = this.host?.layout;
    if (v.matchId !== this.v.matchId || v.layoutId !== this.v.layoutId || v.players !== this.v.players) return false;
    return !layout || (layout.id === v.layoutId && layout.asyks.length === v.konSize);
  }

  ownerMarks(): readonly (OwnerMark | null)[] | null {
    if (!this.v.slots.length) return null;
    if (!this.marks) {
      this.marks = this.v.slots.map((s) => (s.ownerSeat === null ? null : { color: PLAYER_STYLE[s.ownerSeat].color, dots: (s.ownerSeat + 1) as OwnerMark['dots'] }));
    }
    return this.marks;
  }

  sakaPalette(): AsykPalette {
    return PLAYER_STYLE[this.thrower ?? this.v.currentSeat ?? 0].palette;
  }

  braceletColor(): string {
    return PLAYER_STYLE[this.thrower ?? this.v.currentSeat ?? 0].bracelet;
  }
}
