import { sound } from '../audio/sound';
import { zoneEdgePoint } from '../levels/zone';
import type { Piece } from '../physics/PhysicsWorld';
import type { AsykPalette } from '../render/asykShape';
import type { MatchConfig, MatchHud, MatchResult, Seat } from '../types';
import { plural } from '../../ui/format';
import { matchThrowLimit, parseMatchState, throwsPerPlayer, type MatchState } from './matchState';
import type { NextStep, Rules, RulesHost } from './Rules';

export { matchThrowLimit, throwsPerPlayer };

/** Оформление игроков: у каждого свой крашеный сақа и браслет (до четырёх игроков за «столом»). */
export const PLAYER_STYLE: readonly PlayerStyle[] = [
  { palette: 'saka', bracelet: '#c8372d', color: '#e0553a' },
  { palette: 'saka2', bracelet: '#6b3fc4', color: '#8b5cf6' },
  { palette: 'saka3', bracelet: '#1f7a45', color: '#2f9e5f' },
  { palette: 'saka4', bracelet: '#a87600', color: '#d99a00' },
];

interface PlayerStyle {
  palette: AsykPalette;
  bracelet: string;
  /** Цвет игрока в интерфейсе и во всплывающих очках. */
  color: string;
}

export type { MatchState };

/**
 * Матч на 2–4 игрока:
 * - кон общий, игроки бросают строго по очереди по кругу — один бросок, и ход переходит к следующему;
 * - матч идёт, пока кон не опустеет (или пока не кончится лимит бросков — поровну на каждого);
 * - побеждает тот, кто выбил больше асыков (при равенстве — несколько победителей, ничья).
 *
 * `localSeat` — для онлайн-режима: какой игрок управляет этим экраном (null — все на одном устройстве).
 */
export class MatchRules implements Rules {
  private host!: RulesHost;
  /** Число игроков. */
  private readonly n: number;
  private current: Seat;
  private turnId = 1;
  private knocked: number[];
  private throws: number[];
  private bestCombo: number[];
  private total = 0;
  private thisThrow = 0;
  private readonly knockedIds = new Set<number>();
  private reason: MatchResult['reason'] = 'cleared';
  private finished = false;
  private started = false;
  /** Передача устройства нужна только при игре на одном экране. */
  private readonly handoffEnabled: boolean;
  /** Ждём, пока следующий игрок нажмёт «Готов»: до этого бросок невозможен. */
  private handoffPending: boolean;

  constructor(
    private readonly config: MatchConfig,
    private readonly onComplete: (r: MatchResult) => void,
    private readonly localSeat: Seat | null = null,
  ) {
    this.n = config.players.length;
    this.current = config.first;
    this.knocked = new Array<number>(this.n).fill(0);
    this.throws = new Array<number>(this.n).fill(0);
    this.bestCombo = new Array<number>(this.n).fill(0);
    this.handoffEnabled = !!config.handoff && localSeat === null;
    this.handoffPending = this.handoffEnabled;
  }

  attach(host: RulesHost): void {
    this.host = host;
  }

  private name(s: Seat): string {
    return this.config.players[s];
  }

  /** Следующий по кругу. */
  private after(s: Seat): Seat {
    return ((s + 1) % this.n) as Seat;
  }

  private get limit(): number {
    return matchThrowLimit(this.n);
  }

  onStart(): void {
    // жеребьёвка — только в самом первом матче; в реванше и при рестарте очерёдность уже известна
    const toss = !this.config.rematch && !this.started;
    this.started = true;
    const who = this.name(this.current);
    // броски уже есть — матч восстановлен после перезагрузки страницы
    if (this.total > 0) {
      this.host.say(`Матч продолжен · ходит ${who}`, 'info', 2600);
      return;
    }
    this.host.say(toss ? `Жеребьёвка асыком: первым бросает ${who}` : `Первым бросает ${who}`, 'info', 2600);
  }

  canThrow(): boolean {
    return !this.finished && !this.handoffPending && (this.localSeat === null || this.localSeat === this.current);
  }

  blockedHint(): string {
    if (this.handoffPending) return `Передайте устройство: ходит ${this.name(this.current)}. Нажмите «Готов»`;
    return `Сейчас бросает ${this.name(this.current)}`;
  }

  confirmHandoff(): void {
    this.handoffPending = false;
  }

  onLaunch(): number {
    this.total += 1;
    this.throws[this.current] += 1;
    this.thisThrow = 0;
    return this.total;
  }

  onKnockout(p: Piece): void {
    if (this.knockedIds.has(p.id) || this.finished) return;
    this.knockedIds.add(p.id);
    this.knocked[this.current] += 1;
    this.thisThrow += 1;
    const pos = p.body.position;
    this.host.effects.chalkBurst(zoneEdgePoint(this.host.layout.zone, pos));
    this.host.effects.popup(pos.x, pos.y - 24, '+1', PLAYER_STYLE[this.current].color, 36);
    sound.knockout(this.thisThrow);
  }

  onSettled(): void {
    const me = this.current;
    const n = this.thisThrow;
    this.bestCombo[me] = Math.max(this.bestCombo[me], n);
    const left = this.host.asyksLeft();
    if (n >= 2) {
      const c = this.host.zoneCenter();
      this.host.effects.popup(c.x, c.y - 40, `КОМБО ×${n}`, '#ffb13b', 40, 1500);
      sound.bonus();
    }
    const nextName = this.name(this.after(me));
    if (left === 0) {
      this.host.say(`${this.name(me)}: +${n} — кон пуст!`, 'good');
    } else if (this.total >= this.limit) {
      this.host.say('Броски закончились', 'info');
    } else if (n > 0) {
      this.host.say(`${this.name(me)}: +${n} ${plural(n, ['асык', 'асыка', 'асыков'])}! Ход: ${nextName}`, 'good', 1600);
    } else {
      this.host.say(`Мимо! Ход: ${nextName}`, 'warn', 1600);
      sound.miss();
    }
  }

  next(): NextStep {
    if (this.host.asyksLeft() === 0) {
      this.reason = 'cleared';
      return { kind: 'finish' };
    }
    if (this.total >= this.limit) {
      this.reason = 'limit';
      return { kind: 'finish' };
    }
    // строго по очереди: после каждого броска ход переходит к следующему по кругу
    this.current = this.after(this.current);
    this.turnId += 1;
    this.handoffPending = this.handoffEnabled;
    return { kind: 'continue' };
  }

  /**
   * Онлайн, 3–4 игрока: ход игрока, который не в сети, пропускается и засчитывается как бросок мимо
   * (иначе остальные ждали бы его бесконечно). Ход определяется номером броска `throwNo` (сделано бросков + 1):
   * он одинаков у всех игроков, поэтому повторный или запоздалый пропуск ничего не меняет.
   * Дальше движок вызывает `next()`, как после броска.
   */
  skipTurn(seat: Seat, throwNo: number): boolean {
    if (this.finished || this.n < 3 || seat !== this.current || throwNo !== this.total + 1) return false;
    this.total += 1;
    this.throws[seat] += 1;
    this.thisThrow = 0;
    this.host.say(`${this.name(seat)} не в сети — ход пропущен`, 'warn', 1800);
    return true;
  }

  onFinish(): void {
    if (this.finished) return;
    this.finished = true;
    const best = Math.max(...this.knocked);
    const winners = this.knocked.flatMap((k, i) => (k === best ? [i as Seat] : []));
    const result: MatchResult = {
      layoutId: this.host.layout.id,
      players: this.config.players.map((name, i) => ({
        name,
        knocked: this.knocked[i],
        throws: this.throws[i],
        bestCombo: this.bestCombo[i],
      })),
      winners,
      totalThrows: this.total,
      throwsPerPlayer: throwsPerPlayer(this.n),
      reason: this.reason,
    };
    sound.roundEnd(true);
    this.host.schedule(900, () => this.onComplete(result));
  }

  reset(): void {
    this.current = this.config.first;
    this.turnId += 1;
    this.knocked.fill(0);
    this.throws.fill(0);
    this.bestCombo.fill(0);
    this.total = 0;
    this.thisThrow = 0;
    this.knockedIds.clear();
    this.reason = 'cleared';
    this.finished = false;
    this.handoffPending = this.handoffEnabled;
  }

  hud(): MatchHud {
    return {
      kind: 'match',
      players: this.config.players.map((name, i) => ({ name, knocked: this.knocked[i], throws: this.throws[i] })),
      current: this.current,
      turnId: this.turnId,
      totalThrows: this.total,
      maxThrows: this.limit,
      throwsPerPlayer: throwsPerPlayer(this.n),
      asyksLeft: this.host.asyksLeft(),
      totalAsyks: this.host.layout.asyks.length,
      localSeat: this.localSeat,
      finished: this.finished,
      handoff: this.handoffPending && !this.finished,
    };
  }

  exportState(): MatchState {
    return {
      current: this.current,
      turnId: this.turnId,
      knocked: [...this.knocked],
      throws: [...this.throws],
      bestCombo: [...this.bestCombo],
      total: this.total,
      finished: this.finished,
    };
  }

  /** Принимает только проверенное состояние: данные приходят из сети и из хранилища браузера. */
  importState(raw: unknown): void {
    const st = parseMatchState(raw, this.host.layout.asyks.length, this.n);
    if (!st) return;
    this.current = st.current;
    this.turnId = Math.max(this.turnId, st.turnId) + 1;
    this.knocked = [...st.knocked];
    this.throws = [...st.throws];
    this.bestCombo = [...st.bestCombo];
    this.total = st.total;
    this.started = true;
    // онлайн экран передачи не используется (handoffEnabled = false); на одном устройстве после перезагрузки
    // страницы телефон могли отдать другому игроку, поэтому снова просим нажать «Готов»
    this.handoffPending = this.handoffEnabled;
  }

  sakaPalette(): AsykPalette {
    return PLAYER_STYLE[this.current].palette;
  }

  braceletColor(): string {
    return PLAYER_STYLE[this.current].bracelet;
  }
}
