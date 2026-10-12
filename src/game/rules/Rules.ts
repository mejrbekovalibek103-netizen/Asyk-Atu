import type { Piece } from '../physics/PhysicsWorld';
import type { AsykPalette } from '../render/asykShape';
import type { Effects } from '../render/effects';
import type { HudMessage, KonLayout, ModeHud, Vec2 } from '../types';

/** Что движок предоставляет правилам. */
export interface RulesHost {
  readonly layout: KonLayout;
  readonly effects: Effects;
  say(text: string, tone: HudMessage['tone'], ms?: number): void;
  /** Отложенное действие по игровым часам (останавливается на паузе, отменяется рестартом). */
  schedule(ms: number, fn: () => void): void;
  /** Сколько асыков ещё в коне. */
  asyksLeft(): number;
  zoneCenter(): Vec2;
}

/** Что делать после того, как бросок подведён. */
export type NextStep =
  /** следующий бросок (того же или другого игрока — решают правила) */
  | { kind: 'continue' }
  /** восстановить кон и начать заново (после пробного броска обучения) */
  | { kind: 'reset'; message: string }
  /** раунд / матч окончен */
  | { kind: 'finish' };

/**
 * Правила режима игры. Движок (`GameEngine`) отвечает за физику, ввод, руку и рендер,
 * а правила — за счёт, очередь ходов и конец игры.
 *
 * Порядок вызовов за один бросок:
 * `onLaunch` → `onKnockout`* → `onSettled` → `next` → (`onFinish`).
 * Движок гарантирует, что каждый метод вызывается не более одного раза на бросок.
 */
export interface Rules {
  attach(host: RulesHost): void;
  /** Начало раунда/матча (в том числе после рестарта). */
  onStart(): void;
  /** Может ли этот экран сейчас бросать (в онлайне — только в свой ход). */
  canThrow(): boolean;
  /** Почему бросать нельзя — подсказка игроку. */
  blockedHint(): string;
  /** Сақа сорвался с руки. Возвращает номер броска. */
  onLaunch(): number;
  /** Асык пересёк линию кона (вызывается один раз на асык). */
  onKnockout(piece: Piece, throwIndex: number): void;
  /** Всё остановилось — итог броска. */
  onSettled(throwIndex: number): void;
  next(): NextStep;
  /** Раунд/матч окончен (вызывается один раз). */
  onFinish(): void;
  /** Сброс счёта для рестарта. */
  reset(): void;
  hud(): ModeHud;
  /** Цвет сақа в руке и в полёте (у каждого игрока свой). */
  sakaPalette(): AsykPalette;
  /** Цвет браслета на руке. */
  braceletColor(): string;
  /** Состояние счёта для синхронизации онлайн-матча (после переподключения). */
  exportState?(): unknown;
  importState?(state: unknown): void;
}
