import { sound } from '../audio/sound';
import { KNOCKOUT_FADE_MS, PHYS, RELEASE_DELAY_MS, RESOLVE_PAUSE_MS, THROW_LINE_Y, THROW_ORIGIN } from '../config';
import { AimInput, type InputTarget } from '../input/AimInput';
import { zoneCenter } from '../levels/zone';
import { aimDirection, aimFromAnglePower, aimFromPoint, throwParams, type Aim, type ThrowParams } from '../physics/aim';
import { PhysicsWorld, type AsykState, type ContactEvent, type Piece } from '../physics/PhysicsWorld';
import type { AsykPalette, OwnerMark } from '../render/asykShape';
import { Effects } from '../render/effects';
import { Renderer, type HandAnim, type SceneView } from '../render/Renderer';
import { contactFromEvent, REPLAY_CAPS, ThrowPlayer, ThrowRecorder, type ThrowChunk, type ThrowEnd, type ThrowStart } from '../replay/throwRecord';
import type { CanonicalState, Rules, RulesHost } from '../rules/Rules';
import type { HudMessage, HudSnapshot, KonLayout, Phase, Seat, TutorialStep, Vec2 } from '../types';

/**
 * Разрешённые переходы между фазами. Любой другой переход игнорируется —
 * это защищает от двойного броска, повторного подсчёта и «гонок» таймеров.
 */
const TRANSITIONS: Record<Phase, readonly Phase[]> = {
  // READY → THROWING — только для воспроизведения броска соперника в онлайн-матче;
  // READY → ROUND_COMPLETE — вышло время испытания, пока сақа в руке
  READY: ['AIMING', 'THROWING', 'ROUND_COMPLETE'],
  AIMING: ['READY', 'THROWING'],
  THROWING: ['RESOLVING'],
  RESOLVING: ['READY', 'ROUND_COMPLETE'],
  ROUND_COMPLETE: [],
};

export interface EngineOptions {
  layout: KonLayout;
  /** Правила режима: одиночное испытание или матч. */
  rules: Rules;
  /** Первый запуск: пробный бросок с подсказками. */
  tutorial: boolean;
  reducedMotion: boolean;
  /** Продолжить сохранённый раунд/матч (после перезагрузки страницы): кон и счёт из сохранения. Данные должны быть проверены. */
  restore?: MatchSyncState;
  /**
   * Кто считает бросок. 'local' (по умолчанию) — физика на этом устройстве, всё как раньше.
   * 'server' — соревновательный режим: свой бросок уходит на сервер (`requestThrow`), а показывается запись
   * сервера (`pushServerThrow`) тем же путём, что бросок соперника в обычном онлайне; кон и счёт выставляет
   * состояние базы (`applyCanonical`). Правила должны уметь `parseCanonical` и `nextThrowNo` (CompetitiveRules).
   */
  authority?: 'local' | 'server';
  /**
   * 'server': игрок отпустил сақа. Ответ — запись броска (уже проверенная: parseThrowStart / Chunk / End)
   * или null/undefined, если запись придёт отдельно (srv → `pushServerThrow`). Отказ промиса — бросок не принят:
   * сақа возвращается в руку, вызывается `onServerThrowError`. Повторный запрос с тем же throwNo безопасен.
   */
  requestThrow?(req: ServerThrowRequest): Promise<ServerThrowRecord | null | void>;
  /** 'server': comp_state на момент создания движка — кон и счёт выставляются сразу, без ожидания записи. */
  serverState?: unknown;
  /** Рисовать тамгу хозяина на асыках (метки берутся у правил, `ownerMarks`). В обычных режимах не нужно. */
  ownerMarks?: boolean;
}

/** 'server': запрос своего броска. angle и power — прицел игрока до разброса (разброс добавит сервер). */
export interface ServerThrowRequest {
  angle: number;
  power: number;
  /** Номер броска: последний занятый в базе + 1. */
  throwNo: number;
}

/** 'server': запись броска от сервера в формате обычного онлайна (start.throwIndex = номер броска). Части — по мере прихода. */
export interface ServerThrowRecord {
  start?: ThrowStart | null;
  chunks?: readonly ThrowChunk[] | null;
  end?: ThrowEnd | null;
}

/** Онлайн-матч: что движок отправляет сопернику. */
export interface NetHooks {
  /** Прицел (не чаще ~12 раз в секунду); null — прицел отменён. */
  onAim(aim: { angle: number; power: number } | null): void;
  onThrowStart(start: ThrowStart): void;
  onThrowChunk(chunk: ThrowChunk): void;
  onThrowEnd(end: ThrowEnd): void;
}

export interface MatchSyncState {
  asyks: ReturnType<PhysicsWorld['exportAsyks']>;
  rules: unknown;
}

export interface EngineCallbacks {
  onTutorialDone?(): void;
  onPauseRequest?(): void;
  /** Бросок подведён, всё стоит на месте и игра продолжается: самый удобный момент сохранить раунд. */
  onCheckpoint?(state: MatchSyncState): void;
  net?: NetHooks;
  /** 'server': бросок не принят (отказ, ошибка сети или нет ответа за SERVER_THROW_TIMEOUT_MS). Сақа снова в руке. */
  onServerThrowError?(error: unknown, req: ServerThrowRequest): void;
}

const AIM_SEND_MS = 80;

/**
 * 'server': сколько ждать ответа на свой бросок, прежде чем вернуть сақа в руку. Запасной срок: обычно раньше
 * приходит отказ submitThrow. Не меньше всех его попыток (net/competitive: 3 × 8 с + паузы ≈ 25 с, это проверяет
 * тест), иначе сақа вернётся в руку, пока бросок ещё в работе. Ход — 45 с, так что 30 с укладываются.
 */
export const SERVER_THROW_TIMEOUT_MS = 30_000;
/** 'server': сколько ждать запись броска, о котором база уже знает, прежде чем выставить кон без показа. */
export const CANON_WAIT_MS = 3_000;
/** 'server': сколько записей держать в очереди (больше не бывает: бросок за броском, у каждого свой номер). */
const SERVER_QUEUE_MAX = 4;

/** Запись серверного броска, собранная из частей (start, chunk, end могут прийти в любом порядке). */
interface ServerRecordBuffer {
  start: ThrowStart | null;
  chunks: ThrowChunk[];
  end: ThrowEnd | null;
}

interface Task {
  at: number;
  fn: () => void;
}

const GRAB_RADIUS = 150;

/** Замах: на сколько рука оттягивается назад при полной силе (единицы мира). */
const HAND_PULL = 44;
/** После выпуска рука по инерции проходит вперёд на столько… */
const HAND_FOLLOW = 34;
/** …за это время, а затем возвращается. */
const HAND_FOLLOW_MS = 170;
const HAND_RETURN_MS = 460;
/** Высота руки при замахе: чем сильнее бросок, тем выше. */
const handLift = (power: number) => 0.3 + 0.55 * power;

/**
 * Игровой движок: цикл, физика, ввод, анимация руки, рендер и фазы броска.
 * Счёт, очередь ходов и конец игры решают правила (`Rules`).
 */
export class GameEngine implements SceneView, InputTarget, RulesHost {
  // ——— SceneView / RulesHost ———
  readonly layout: KonLayout;
  phase: Phase = 'READY';
  /** Свой прицел (пока тянем). */
  private localAim: Aim | null = null;
  /** Прицел соперника в онлайн-матче. */
  private remoteAim: Aim | null = null;
  hoverGrab = false;
  hand: HandAnim = { offset: 0, angle: 0, open: 0, sakaInHand: true, reload: 1, lift: 0 };
  readonly effects: Effects;
  clock = 0;
  sakaLaunchedAt = 0;
  trail: Vec2[] = [];
  showGrabHint = false;

  // ——— внутреннее состояние ———
  private physics: PhysicsWorld;
  private readonly rules: Rules;
  private readonly renderer: Renderer;
  private readonly input: AimInput;
  private aimSource: 'pointer' | 'keyboard' | null = null;
  private lastAngle = 0;
  private lastPower = 0.6;
  /** Номер текущего броска (его выдают правила при запуске). */
  private currentThrow = 0;
  private launched = false;
  private settledFor = 0;
  /** Обучение ещё не пройдено (пробный бросок впереди). */
  private tutorialPending: boolean;
  private tutorialStep: TutorialStep | null;
  private paused = false;
  private tasks: Task[] = [];
  /** Выброс руки: когда начался, откуда (смещение замаха) и с какой высоты. */
  private release: { at: number; from: number; lift: number } | null = null;
  private message: HudMessage | null = null;
  private msgId = 0;
  private waitHintShown = false;
  /** Запись своего броска для соперника (онлайн). */
  private recorder: ThrowRecorder | null = null;
  /** Воспроизведение броска соперника (онлайн). */
  private player: ThrowPlayer | null = null;
  private lastAimSentAt = 0;
  /** Есть положение прицела, которое не успели отправить из-за ограничения частоты. */
  private aimDirty = false;
  private replayStalled = false;
  /** С какого момента (игровые часы) воспроизведение ждёт данные. */
  private stalledSince: number | null = null;

  // ——— «сервер решает» (authority: 'server') ———
  private readonly serverMode: boolean;
  private readonly requestThrowFn: EngineOptions['requestThrow'];
  private readonly showOwners: boolean;
  /** Свой бросок отправлен, ждём ответ сервера. */
  private serverWait: { req: ServerThrowRequest; aim: Aim; token: number; at: number } | null = null;
  private serverToken = 0;
  /** Записи серверных бросков, ещё не начатые, по номеру броска. */
  private readonly srvQueue = new Map<number, ServerRecordBuffer>();
  /** Номер броска, запись которого сейчас проигрывается. */
  private srvPlaying: number | null = null;
  /** Наибольший номер броска, который уже показан или выставлен по базе: записи с номером не больше — повтор. */
  private srvDone = 0;
  /** Состояние базы, ждущее конца показа броска (или прихода его записи). */
  private canon: CanonicalState | null = null;
  /** С какого момента ждём запись броска, о котором база уже знает. */
  private recordWaitSince: number | null = null;

  private raf = 0;
  private lastNow = 0;
  private accumulator = 0;
  private destroyed = false;
  private readonly listeners = new Set<() => void>();
  private snapshot: HudSnapshot;

  constructor(
    canvas: HTMLCanvasElement,
    opts: EngineOptions,
    private readonly cb: EngineCallbacks = {},
  ) {
    this.layout = opts.layout;
    this.rules = opts.rules;
    this.serverMode = opts.authority === 'server';
    this.requestThrowFn = opts.requestThrow;
    this.showOwners = !!opts.ownerMarks;
    this.tutorialPending = opts.tutorial;
    this.tutorialStep = opts.tutorial ? 'grab' : null;
    this.effects = new Effects(opts.reducedMotion);
    this.renderer = new Renderer(canvas, this.layout);
    this.physics = this.buildWorld();
    this.rules.attach(this);
    if (opts.restore) {
      // продолжаем сохранённый раунд: обучение уже пройдено (пробный бросок делается до первого сохранения)
      this.physics.importAsyks(opts.restore.asyks, this.layout.asyks, true);
      this.rules.importState?.(opts.restore.rules);
      this.tutorialPending = false;
      this.tutorialStep = null;
    }
    this.input = new AimInput(canvas, (x, y) => this.renderer.screenToWorld(x, y), this);
    this.snapshot = this.buildSnapshot();
    if (this.serverMode && opts.serverState !== undefined) {
      // матч уже идёт (переподключение): кон и счёт — сразу из базы, запись прошлого броска не ждём
      const st = this.rules.parseCanonical?.(opts.serverState);
      if (st) this.applyCanonNow(st);
    }
    // шрифты для надписей мелом на фоне
    document.fonts?.ready.then(() => this.renderer.invalidateBackground()).catch(() => undefined);
  }

  // ——— жизненный цикл ———

  start(): void {
    this.lastNow = performance.now();
    this.raf = requestAnimationFrame(this.frame);
    this.rules.onStart();
  }

  destroy(): void {
    this.destroyed = true;
    this.serverWait = null;
    this.srvQueue.clear();
    cancelAnimationFrame(this.raf);
    this.input.destroy();
    this.physics.destroy();
    this.tasks = [];
    this.listeners.clear();
  }

  resize(cssW: number, cssH: number, topInset: number): void {
    this.renderer.resize(cssW, cssH, topInset);
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused && this.phase === 'AIMING') this.cancelAim(false);
    if (paused) this.input.reset();
    this.lastNow = performance.now();
    this.emit();
  }

  /** Перезапуск раунда/матча в любой момент (в том числе во время движения физики). */
  restart(): void {
    this.resetWorld();
    this.rules.onStart();
    this.emit();
  }

  private resetWorld(): void {
    this.tasks = []; // отменяем все отложенные действия старого раунда
    this.release = null;
    this.physics.destroy();
    this.physics = this.buildWorld();
    this.rules.reset();
    this.currentThrow = 0;
    this.launched = false;
    this.localAim = null;
    this.remoteAim = null;
    this.recorder = null;
    this.player = null;
    this.serverWait = null;
    this.srvPlaying = null;
    this.srvQueue.clear();
    this.canon = null;
    this.recordWaitSince = null;
    this.aimSource = null;
    this.trail = [];
    this.message = null;
    this.effects.clear();
    this.hand = { offset: 0, angle: 0, open: 0, sakaInHand: true, reload: 0, lift: 0 };
    this.phase = 'READY';
    this.paused = false;
    this.tutorialStep = this.tutorialPending ? 'grab' : null;
    this.input.reset();
  }

  // ——— подписка для React (useSyncExternalStore) ———

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): HudSnapshot => this.snapshot;

  // ——— SceneView ———

  get pieces(): readonly Piece[] {
    return this.physics.pieces;
  }

  get physicsTime(): number {
    return this.physics.time;
  }

  /** Одно устройство: следующий игрок готов — снимаем блокировку броска. */
  confirmHandoff(): void {
    this.rules.confirmHandoff?.();
    this.message = null; // подсказка «Передайте устройство» больше не нужна
    this.emit();
  }

  /** Прицел на экране: свой, пока тянем, или соперника, пока он целится. */
  get aim(): Aim | null {
    if (this.phase === 'AIMING') return this.localAim;
    if (this.phase === 'READY') return this.remoteAim;
    // 'server': пока сервер считает бросок, рука держит замах, а пунктир показывает отправленный прицел
    if (this.serverWait && this.phase === 'THROWING') return this.serverWait.aim;
    return null;
  }

  get localTurn(): boolean {
    return this.canThrowNow();
  }

  /** Тамга хозяина на асыках — только с опцией ownerMarks. */
  get ownerMarks(): readonly (OwnerMark | null)[] | null {
    return this.showOwners ? (this.rules.ownerMarks?.() ?? null) : null;
  }

  /**
   * Может ли этот экран сейчас начать бросок. В обычном режиме — ровно `rules.canThrow()`.
   * 'server': ещё и не ждём ответ на свой бросок, ничего не проигрываем, и база уже знает обо всех показанных
   * бросках (иначе бросок ушёл бы со старым номером).
   */
  private canThrowNow(): boolean {
    if (!this.rules.canThrow()) return false;
    if (!this.serverMode) return true;
    return !this.serverWait && !this.canon && this.srvPlaying === null && this.srvDone < (this.rules.nextThrowNo?.() ?? 0);
  }

  private blockedHintNow(): string {
    return this.serverMode && this.rules.canThrow() ? 'Ждём сервер…' : this.rules.blockedHint();
  }

  get sakaPalette(): AsykPalette {
    return this.rules.sakaPalette();
  }

  get braceletColor(): string {
    return this.rules.braceletColor();
  }

  // ——— RulesHost ———

  asyksLeft(): number {
    return this.physics.asyksIn().length;
  }

  zoneCenter(): Vec2 {
    return zoneCenter(this.layout.zone);
  }

  schedule(ms: number, fn: () => void): void {
    this.tasks.push({ at: this.clock + ms, fn });
  }

  say(text: string, tone: HudMessage['tone'], ms = 1800): void {
    const id = ++this.msgId;
    this.message = { id, text, tone };
    this.schedule(ms, () => {
      if (this.message?.id === id) {
        this.message = null;
        this.emit();
      }
    });
    this.emit();
  }

  // ——— InputTarget ———

  pointerDown(p: Vec2): boolean {
    sound.unlock();
    if (this.paused) return false;
    if (this.phase !== 'READY') {
      // 'server': бросок уже отправлен — второе нажатие ничего не делает (интерфейс показывает «Бросок…»)
      if (this.serverWait) return false;
      if ((this.phase === 'THROWING' || this.phase === 'RESOLVING') && !this.waitHintShown) {
        this.waitHintShown = true;
        this.say('Дождись, пока всё остановится', 'info', 1200);
      }
      return false;
    }
    if (!this.canThrowNow()) {
      this.say(this.blockedHintNow(), 'info', 1600);
      return false;
    }
    if (!this.inGrabArea(p)) {
      this.say('Зажми сақа в руке внизу и тяни к асыкам', 'info', 2200);
      this.showGrabHint = true;
      this.schedule(1600, () => (this.showGrabHint = false));
      return false;
    }
    if (!this.setPhase('AIMING')) return false;
    this.rules.onAim?.();
    this.aimSource = 'pointer';
    this.localAim = aimFromPoint(THROW_ORIGIN, p, this.lastAngle);
    if (this.tutorialStep === 'grab') this.tutorialStep = 'drag';
    this.sendAim(true);
    this.emit();
    return true;
  }

  pointerMove(p: Vec2, pressed: boolean): void {
    if (!pressed) {
      const hover = this.phase === 'READY' && !this.paused && this.canThrowNow() && this.inGrabArea(p);
      if (hover !== this.hoverGrab) this.hoverGrab = hover;
      return;
    }
    if (this.phase !== 'AIMING' || this.aimSource !== 'pointer') return;
    this.localAim = aimFromPoint(THROW_ORIGIN, p, this.localAim?.angle ?? this.lastAngle);
    this.advanceTutorialOnAim();
    this.sendAim(false);
    this.emit();
  }

  pointerUp(p: Vec2): void {
    if (this.phase !== 'AIMING' || this.aimSource !== 'pointer') return;
    this.localAim = aimFromPoint(THROW_ORIGIN, p, this.localAim?.angle ?? this.lastAngle);
    this.releaseThrow();
  }

  pointerCancel(): void {
    if (this.phase === 'AIMING' && this.aimSource === 'pointer') this.cancelAim(false);
  }

  keyAim(dAngle: number, dPower: number): void {
    if (this.paused) return;
    if (this.phase === 'READY') {
      if (!this.canThrowNow()) return;
      if (!this.setPhase('AIMING')) return;
      this.rules.onAim?.();
      this.aimSource = 'keyboard';
      this.localAim = aimFromAnglePower(this.lastAngle, this.lastPower);
      if (this.tutorialStep === 'grab') this.tutorialStep = 'drag';
    }
    if (this.phase !== 'AIMING' || this.aimSource !== 'keyboard' || !this.localAim) return;
    this.localAim = aimFromAnglePower(this.localAim.angle + dAngle, this.localAim.power + dPower);
    this.advanceTutorialOnAim();
    this.sendAim(false);
    this.emit();
  }

  keyThrow(): void {
    if (this.paused) return;
    if (this.phase === 'READY') {
      this.keyAim(0, 0); // первое нажатие показывает прицел
      return;
    }
    if (this.phase === 'AIMING' && this.aimSource === 'keyboard') this.releaseThrow();
  }

  keyEscape(): void {
    if (this.phase === 'AIMING') this.cancelAim(false);
    else this.cb.onPauseRequest?.();
  }

  cursor(): string {
    if (this.phase === 'AIMING') return 'grabbing';
    if (this.phase === 'READY' && this.hoverGrab) return 'grab';
    return 'default';
  }

  // ——— основной цикл ———

  private frame = (now: number): void => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(PHYS.maxFrameMs, Math.max(0, now - this.lastNow));
    this.lastNow = now;

    if (!this.paused) {
      this.clock += dt;
      // фиксированный шаг физики независимо от частоты кадров экрана (60/120/144 Гц)
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= PHYS.stepMs && steps < 24) {
        this.fixedStep();
        this.accumulator -= PHYS.stepMs;
        steps++;
      }
      if (steps >= 24) this.accumulator = 0;
      this.runTasks();
      if (this.serverMode) this.serverTick();
      // таймер испытания со временем: интерфейс обновляется раз в секунду; вышло время при сақа в руке — раунд окончен
      if (this.phase !== 'ROUND_COMPLETE' && this.rules.tick?.(dt)) this.emit();
      if ((this.phase === 'READY' || this.phase === 'AIMING') && this.rules.timeIsUp?.()) this.finishByTime();
      if (this.aimDirty && this.phase === 'AIMING') this.sendAim(false);
      this.effects.update(dt);
      this.animateHand(dt);
      this.updateTrail();
    }
    this.renderer.render(this);
  };

  private fixedStep(): void {
    if (this.player && this.launched) {
      this.replayStep();
      return;
    }
    this.physics.step();
    const contacts = this.physics.drainContacts();
    for (const c of contacts) this.onContact(c);
    this.removeFaded();

    if (this.phase !== 'THROWING' || !this.launched) return;

    const out = this.physics.checkKnockouts(this.layout.zone, this.currentThrow);
    for (const p of out) this.rules.onKnockout(p, this.currentThrow);
    if (out.length) this.emit();
    if (this.recorder) {
      const chunk = this.recorder.onStep(contacts, out);
      if (chunk) this.cb.net?.onThrowChunk(chunk);
    }

    if (this.physics.isSettled()) {
      this.settledFor += PHYS.stepMs;
      if (this.settledFor >= PHYS.settleMs) this.resolveThrow();
    } else {
      this.settledFor = 0;
    }
    if (this.phase === 'THROWING' && this.physics.time - this.sakaLaunchedAt > PHYS.maxThrowMs) {
      this.physics.stopAll();
      this.resolveThrow();
    }
  }

  /** Выбитые асыки растворяются и удаляются из мира. */
  private removeFaded(): void {
    for (const p of [...this.physics.pieces]) {
      if (p.status === 'out' && p.outAt !== null && this.physics.time - p.outAt > KNOCKOUT_FADE_MS) {
        this.physics.removePiece(p);
      }
    }
  }

  // ——— онлайн: бросок соперника ———

  /** Соперник отпустил сақа: показываем выброс его руки, дальше проигрываем запись. */
  remoteThrowStart(start: ThrowStart): void {
    // 'server': это запись сервера — в том числе своего броска; номер броска берётся из самой записи
    if (this.serverMode) {
      this.pushServerThrow(start.throwIndex, { start });
      return;
    }
    if (this.phase !== 'READY' || this.rules.canThrow()) return;
    if (!this.setPhase('THROWING')) return;
    this.remoteAim = null;
    this.player = new ThrowPlayer(start);
    this.launched = false;
    this.hand.angle = start.angle;
    this.release = { at: this.clock, from: -start.power * HAND_PULL, lift: handLift(start.power) };
    sound.throw(start.power);
    this.schedule(RELEASE_DELAY_MS, () => this.startReplay(start));
    this.emit();
  }

  remoteThrowChunk(chunk: ThrowChunk): void {
    this.player?.push(chunk);
  }

  remoteThrowEnd(end: ThrowEnd): void {
    this.player?.end(end);
  }

  /** Прицел соперника — видно, как он тянет руку. */
  setRemoteAim(a: { angle: number; power: number } | null): void {
    const show = this.phase === 'READY' && !this.rules.canThrow();
    const next = show && a ? aimFromAnglePower(a.angle, a.power) : null;
    if (!next && !this.remoteAim) return;
    this.remoteAim = next;
    this.emit();
  }

  private startReplay(start: ThrowStart): void {
    if (this.phase !== 'THROWING' || !this.player || this.launched) return;
    this.currentThrow = this.rules.onLaunch();
    // 'server': номер броска — из записи сервера (он же номер в базе)
    if (this.serverMode) this.currentThrow = start.throwIndex;
    this.physics.launchSaka(THROW_ORIGIN, start.angle, 0, 0);
    this.sakaLaunchedAt = this.physics.time;
    this.launched = true;
    this.hand.sakaInHand = false;
    const d = aimDirection(start.angle);
    this.effects.dust(THROW_ORIGIN.x + d.x * 30, THROW_ORIGIN.y + d.y * 30, 2, 'rgba(230, 220, 200, 1)');
    this.emit();
  }

  /**
   * Шаг воспроизведения: тела ставятся по записи, физика не считается.
   * Если запись из сети ещё не пришла — бросок «замирает» и ждёт.
   */
  private replayStep(): void {
    const player = this.player!;
    if (player.done()) {
      this.finishReplay();
      return;
    }
    const stalled = !player.canAdvance();
    if (stalled !== this.replayStalled) {
      this.replayStalled = stalled;
      this.stalledSince = stalled ? this.clock : null;
      this.emit(); // интерфейс покажет «связь…», если данные задерживаются
    }
    if (stalled) return;
    this.physics.advanceTime(PHYS.stepMs);
    for (const e of player.advance(this.physics)) {
      if (e.t === 'c') this.onContact(contactFromEvent(e));
      else this.knockRemote(e.i);
    }
    this.removeFaded();
    if (player.done()) this.finishReplay();
  }

  private knockRemote(index: number): void {
    const p = this.physics.pieceByIndex(index);
    if (p && this.physics.markOut(p, this.currentThrow)) {
      this.rules.onKnockout(p, this.currentThrow);
      this.emit();
    }
  }

  private finishReplay(): void {
    const end = this.player?.ended;
    if (!end) return;
    this.player = null;
    this.stalledSince = null;
    if (this.srvPlaying !== null) {
      this.srvDone = Math.max(this.srvDone, this.srvPlaying);
      this.srvPlaying = null;
    }
    // итоговое состояние соперника — истина: досчитываем выбитые, которых не было в событиях
    for (const [i, , , , inZone] of end.final) if (!inZone) this.knockRemote(i);
    this.physics.importAsyks(end.final, this.layout.asyks, false);
    const saka = this.physics.saka;
    if (end.saka && saka) this.physics.place(saka, end.saka[0], end.saka[1], end.saka[2]);
    this.resolveThrow();
  }

  /**
   * Онлайн, 3–4 игрока: ход отсутствующего игрока пропускается (решение принято снаружи по присутствию в
   * комнате и проверено). Возможно только между бросками; дальше всё как после обычного броска.
   */
  skipTurn(seat: Seat, throwNo: number): boolean {
    if (this.phase !== 'READY' || !this.rules.skipTurn?.(seat, throwNo)) return false;
    this.remoteAim = null;
    const step = this.rules.next();
    if (step.kind === 'finish' && this.setPhase('ROUND_COMPLETE')) this.rules.onFinish();
    this.emit();
    return true;
  }

  /** Счёт и кон для переподключившегося соперника. */
  exportMatchState(): MatchSyncState {
    return { asyks: this.physics.exportAsyks(this.layout.asyks.length), rules: this.rules.exportState?.() };
  }

  /**
   * Применить состояние матча от соперника.
   * Обычно — только между бросками; `force` — прервать застрявшее воспроизведение
   * (например, соперник переподключился, и часть записи броска потерялась).
   */
  importMatchState(st: MatchSyncState, force = false, trusted = true): boolean {
    if (this.phase === 'ROUND_COMPLETE') return false;
    if (this.phase !== 'READY') {
      if (!force || this.recorder) return false; // свой бросок не прерываем
      this.player = null;
      this.launched = false;
      this.localAim = null;
      this.aimSource = null;
      this.release = null;
      this.physics.removeSaka();
      this.phase = 'READY';
      this.hand = { offset: 0, angle: 0, open: 0, sakaInHand: true, reload: 0, lift: 0 };
    }
    this.physics.importAsyks(st.asyks, this.layout.asyks, trusted);
    this.rules.importState?.(st.rules);
    this.remoteAim = null;
    // снимок с последнего броска (перезагрузка в итогах, отставший зритель): матч окончен и здесь
    if (this.rules.isOver?.() && this.setPhase('ROUND_COMPLETE')) this.rules.onFinish();
    this.emit();
    return true;
  }

  // ——— «сервер решает» (authority: 'server', соревновательный режим) ———

  /**
   * Запись серверного броска — часть (srv: start / chunk / end) или весь ответ на свой бросок.
   * Части проверяет вызывающий (net/validate: parseThrowStart, parseThrowChunk, parseThrowEnd).
   * Повторы и уже показанные номера отбрасываются; запись «наперёд» ждёт, пока движок освободится.
   * Проигрывается тем же путём, что бросок соперника в обычном онлайне (ThrowPlayer → finishReplay).
   */
  pushServerThrow(throwNo: number, part: ServerThrowRecord): void {
    if (!this.serverMode || this.destroyed || !Number.isInteger(throwNo) || throwNo < 1) return;
    if (throwNo <= this.srvDone) return; // уже показан или выставлен по базе
    const start = part.start && part.start.throwIndex === throwNo ? part.start : null;
    const chunks = part.chunks ?? [];
    const end = part.end ?? null;
    if (throwNo === this.srvPlaying && this.player) {
      for (const c of chunks) this.player.push(c);
      if (end) this.player.end(end);
      return;
    }
    let buf = this.srvQueue.get(throwNo);
    if (!buf) {
      if (this.srvQueue.size >= SERVER_QUEUE_MAX || throwNo > this.srvDone + 100) return;
      buf = { start: null, chunks: [], end: null };
      this.srvQueue.set(throwNo, buf);
    }
    if (start && !buf.start) buf.start = start;
    for (const c of chunks) if (buf.chunks.length < REPLAY_CAPS.maxPending) buf.chunks.push(c);
    if (end && !buf.end) buf.end = end;
    this.tryStartServerReplay();
  }

  /**
   * Состояние матча из базы (ответ comp_state) — истина: кон, счёт, чей ход, конец матча.
   * Пока проигрывается бросок (или его запись вот-вот придёт), состояние ждёт конца показа, чтобы кон не
   * «прыгал». Если запись броска, о котором база уже знает, не пришла за CANON_WAIT_MS — кон выставляется сразу,
   * без анимации. Асыки, которые уже стоят как в базе, не трогаются.
   * false — состояние не принято (не режим 'server', мусор, чужой матч, устарело).
   */
  applyCanonical(compState: unknown): boolean {
    if (!this.serverMode || this.destroyed) return false;
    const st = this.rules.parseCanonical?.(compState);
    if (!st) return false;
    const known = (this.rules.nextThrowNo?.() ?? 1) - 1;
    // старее уже показанного броска (ответ на запрос, ушедший до записи броска): иначе выбитые «воскреснут»
    if (st.throwNo < known || st.throwNo < this.srvDone || (this.canon && st.throwNo < this.canon.throwNo)) return false;
    if (this.srvPlaying !== null && st.throwNo < this.srvPlaying) return false;
    this.canon = st;
    if (this.phase === 'ROUND_COMPLETE' || this.canonBlocker(st, false) === 'none') this.applyCanonNow(st);
    else this.emit(); // бросать нельзя, пока база и экран не сойдутся
    return true;
  }

  /** Номер последнего броска, который этот экран показал или выставил по базе. */
  get serverThrowsDone(): number {
    return this.srvDone;
  }

  private requestServerThrow(aim: Aim): void {
    const fn = this.requestThrowFn;
    const throwNo = this.rules.nextThrowNo?.() ?? 0;
    if (!fn || throwNo < 1 || !this.canThrowNow()) {
      this.cancelAim(false);
      this.say(fn ? this.blockedHintNow() : 'Бросок сейчас недоступен', 'warn', 1800);
      return;
    }
    if (!this.setPhase('THROWING')) return;
    this.lastAngle = aim.angle;
    this.lastPower = aim.power;
    this.aimSource = null;
    this.launched = false;
    this.waitHintShown = false;
    this.localAim = null;
    // прицел уходит как есть, без округления: сервер проверяет предел угла по тем же числам
    const req: ServerThrowRequest = { angle: aim.angle, power: aim.power, throwNo };
    const token = ++this.serverToken;
    this.serverWait = { req, aim, token, at: this.clock };
    this.emit();
    let reply: Promise<ServerThrowRecord | null | void>;
    try {
      reply = Promise.resolve(fn(req));
    } catch (e) {
      reply = Promise.reject(e);
    }
    reply.then(
      // запись принимается и после таймаута: сервер бросок засчитал — его надо показать
      (rec) => {
        if (rec && !this.destroyed) this.pushServerThrow(throwNo, rec);
      },
      (err) => {
        if (this.serverWait?.token === token) this.failServerThrow(err);
      },
    );
  }

  /** Бросок не принят: сақа обратно в руку, прицел можно взять снова (с того же угла и силы). */
  private failServerThrow(err: unknown): void {
    const w = this.serverWait;
    if (!w) return;
    this.serverWait = null;
    if (this.phase === 'THROWING' && !this.player) this.backToHand();
    this.say('Бросок не прошёл — брось ещё раз', 'warn', 2400);
    this.cb.onServerThrowError?.(err, w.req);
    this.emit();
    this.serverResume();
  }

  /** Вернуть сақа в руку без показа броска (ответа нет, или бросок уже выставлен по базе). */
  private backToHand(): void {
    if (this.srvPlaying !== null) this.srvDone = Math.max(this.srvDone, this.srvPlaying);
    this.srvPlaying = null;
    this.serverWait = null;
    this.player = null;
    this.launched = false;
    this.replayStalled = false;
    this.stalledSince = null;
    this.release = null;
    this.localAim = null;
    this.aimSource = null;
    this.trail = [];
    this.physics.removeSaka();
    this.phase = 'READY';
    this.hand.sakaInHand = true;
    this.hand.reload = 0;
  }

  /** Начать следующую запись из очереди, если движок свободен. */
  private tryStartServerReplay(): void {
    if (this.player || this.srvPlaying !== null) return;
    if (this.phase === 'RESOLVING' || this.phase === 'ROUND_COMPLETE') return;
    for (const no of [...this.srvQueue.keys()]) if (no <= this.srvDone) this.srvQueue.delete(no);
    let next: number | null = null;
    for (const [no, b] of this.srvQueue) if (b.start && (next === null || no < next)) next = no;
    if (next === null) return;
    const own = this.serverWait;
    if (this.phase === 'THROWING') {
      // бросок уже идёт только в одном случае — ждём ответ на свой: подходит лишь его запись
      if (!own || own.req.throwNo !== next) return;
    } else if (this.phase === 'AIMING') {
      // бросок с этим номером уже сделан (например, с другой вкладки): прицел больше не нужен
      this.cancelAim(false);
    }
    const buf = this.srvQueue.get(next)!;
    this.srvQueue.delete(next);
    this.serverWait = null;
    this.srvPlaying = next;
    const player = this.beginServerReplay(buf.start!, !!own);
    if (!player) {
      this.srvPlaying = null;
      return;
    }
    for (const c of buf.chunks) player.push(c);
    if (buf.end) player.end(buf.end);
  }

  /** Выброс руки и запуск воспроизведения записи сервера (как remoteThrowStart в обычном онлайне). */
  private beginServerReplay(start: ThrowStart, own: boolean): ThrowPlayer | null {
    if (!own && !this.setPhase('THROWING')) return null;
    this.remoteAim = null;
    const player = new ThrowPlayer(start);
    this.player = player;
    this.launched = false;
    this.replayStalled = false;
    this.stalledSince = null;
    // свой бросок: рука срывается из замаха, в котором ждала ответ; чужой — как в обычном онлайне
    this.release = own
      ? { at: this.clock, from: this.hand.offset, lift: this.hand.lift }
      : { at: this.clock, from: -start.power * HAND_PULL, lift: handLift(start.power) };
    this.hand.angle = start.angle;
    sound.throw(start.power);
    this.schedule(RELEASE_DELAY_MS, () => {
      if (this.player === player) this.startReplay(start);
    });
    this.emit();
    return player;
  }

  /**
   * Что мешает применить состояние базы прямо сейчас:
   * 'busy' — движок занят и сам применит его, когда освободится; 'replay' — идёт показ броска;
   * 'record' — база знает о броске, запись которого ещё не пришла (ждём не дольше CANON_WAIT_MS).
   */
  private canonBlocker(st: CanonicalState, inResolve: boolean): 'none' | 'busy' | 'replay' | 'record' {
    if (this.phase === 'RESOLVING' && !inResolve) return 'busy';
    if (this.player || this.srvPlaying !== null) return 'replay';
    const w = this.serverWait;
    if (w) return w.req.throwNo <= st.throwNo ? 'record' : 'busy';
    for (const [no, b] of this.srvQueue) if (b.start && no > this.srvDone && no <= st.throwNo) return 'record';
    if (st.recordExpected && st.throwNo > this.srvDone) return 'record';
    return 'none';
  }

  /** Каждый кадр (режим 'server'): сроки ожидания ответа сервера и записи броска. */
  private serverTick(): void {
    const w = this.serverWait;
    if (w && this.clock - w.at >= SERVER_THROW_TIMEOUT_MS) this.failServerThrow(new Error('timeout'));
    const st = this.canon;
    if (!st) return;
    const b = this.canonBlocker(st, false);
    if (b === 'none') {
      this.applyCanonNow(st);
      return;
    }
    if (b === 'record') {
      this.recordWaitSince ??= this.clock;
      if (this.clock - this.recordWaitSince >= CANON_WAIT_MS) this.applyCanonNow(st);
      return;
    }
    this.recordWaitSince = null;
    // запись застряла (часть потерялась): дольше ждать незачем — итог этого броска база уже знает
    const stuck = b === 'replay' && this.stalledSince !== null && this.clock - this.stalledSince >= CANON_WAIT_MS;
    if (stuck && this.srvPlaying !== null && this.srvPlaying <= st.throwNo) this.applyCanonNow(st);
  }

  /** Движок освободился: применить ждущее состояние базы и начать следующую запись. */
  private serverResume(): void {
    if (this.canon && this.canonBlocker(this.canon, false) === 'none') this.applyCanonNow(this.canon);
    this.tryStartServerReplay();
  }

  private applyCanonNow(st: CanonicalState): void {
    this.canon = null;
    this.recordWaitSince = null;
    // пока ждало, экран показал более поздний бросок: состояние устарело, кон и счёт не трогаем
    if (st.throwNo < this.srvDone) {
      this.tryStartServerReplay();
      return;
    }
    // бросок, итог которого база уже знает, не показан (запись не пришла или застряла) — выставляем итог
    if (this.phase === 'THROWING') this.backToHand();
    this.srvDone = Math.max(this.srvDone, st.throwNo);
    for (const no of [...this.srvQueue.keys()]) if (no <= this.srvDone) this.srvQueue.delete(no);
    if (this.phase !== 'ROUND_COMPLETE') this.syncKon(st.kon);
    this.rules.importState?.(st.rules);
    if (this.rules.canThrow()) this.remoteAim = null;
    if (this.phase === 'AIMING' && !this.canThrowNow()) this.cancelAim(false);
    if (this.phase === 'READY' && this.rules.isOver?.() && this.setPhase('ROUND_COMPLETE')) this.rules.onFinish();
    this.emit();
    this.tryStartServerReplay();
  }

  /**
   * Выставить кон ровно как в базе, без анимации, трогая только асыки, которые расходятся.
   * null — исходная раскладка. Лишний асык в коне растворяется (как выбитый), недостающий возвращается.
   */
  private syncKon(kon: AsykState[] | null): void {
    const n = this.layout.asyks.length;
    const target: AsykState[] = kon ?? this.layout.asyks.map((a, i): AsykState => [i, a.x, a.y, a.angle ?? 0, 1]);
    const cur = this.physics.exportAsyks(n);
    const move: AsykState[] = [];
    for (const t of target) {
      const c = cur[t[0]];
      if (!c) continue;
      if (t[4] === 0) {
        const p = c[4] === 1 ? this.physics.pieceByIndex(t[0]) : undefined;
        if (p) this.physics.markOut(p, this.currentThrow);
        continue;
      }
      const off = c[4] !== 1 || Math.abs(c[1] - t[1]) > 0.05 || Math.abs(c[2] - t[2]) > 0.05 || Math.abs(c[3] - t[3]) > 0.005;
      if (off) move.push(t);
    }
    if (move.length) this.physics.importAsyks(move, this.layout.asyks, true);
  }

  private sendAim(force: boolean): void {
    const net = this.cb.net;
    if (!net || !this.localAim) return;
    const now = performance.now();
    if (!force && now - this.lastAimSentAt < AIM_SEND_MS) {
      this.aimDirty = true; // досылаем в ближайшем кадре, когда пауза пройдёт
      return;
    }
    this.aimDirty = false;
    this.lastAimSentAt = now;
    net.onAim({ angle: Math.round(this.localAim.angle * 1000) / 1000, power: Math.round(this.localAim.power * 1000) / 1000 });
  }

  // ——— бросок ———

  private releaseThrow(): void {
    const aim = this.localAim;
    if (this.phase !== 'AIMING' || !aim) return;
    if (!aim.valid) {
      this.cancelAim(true);
      return;
    }
    if (this.serverMode) {
      this.requestServerThrow(aim);
      return;
    }
    if (!this.setPhase('THROWING')) return;
    this.lastAngle = aim.angle;
    this.lastPower = aim.power;
    this.aimSource = null;
    this.launched = false;
    this.waitHintShown = false;
    this.release = { at: this.clock, from: this.hand.offset, lift: this.hand.lift };
    if (this.tutorialStep) this.tutorialStep = 'watch';
    sound.throw(aim.power);
    const params = throwParams(aim);
    // рука делает выброс, и только в конце движения сақа «срывается» с пальцев
    this.schedule(RELEASE_DELAY_MS, () => this.launch(params));
    this.emit();
  }

  private launch(params: ThrowParams): void {
    if (this.phase !== 'THROWING' || this.launched) return;
    this.currentThrow = this.rules.onLaunch();
    this.settledFor = 0;
    this.physics.launchSaka(THROW_ORIGIN, params.angle, params.speed, params.spin);
    this.sakaLaunchedAt = this.physics.time;
    this.launched = true;
    this.hand.sakaInHand = false;
    this.localAim = null;
    if (this.cb.net) {
      this.recorder = new ThrowRecorder(this.physics);
      this.cb.net.onThrowStart({ throwIndex: this.currentThrow, angle: params.angle, power: this.lastPower });
    }
    const d = aimDirection(params.angle);
    this.effects.dust(THROW_ORIGIN.x + d.x * 30, THROW_ORIGIN.y + d.y * 30, 2, 'rgba(230, 220, 200, 1)');
    this.emit();
  }

  private cancelAim(tooWeak: boolean): void {
    if (this.phase !== 'AIMING') return;
    const hadPower = (this.localAim?.power ?? 0) > 0.01;
    this.localAim = null;
    this.aimSource = null;
    this.setPhase('READY');
    this.cb.net?.onAim(null);
    if (tooWeak) {
      this.say(hadPower ? 'Слишком слабо — потяни дальше от руки' : 'Потяни от руки вверх, к асыкам', 'warn', 2000);
      if (this.tutorialStep === 'release') this.tutorialStep = 'drag';
    }
    this.emit();
  }

  private resolveThrow(): void {
    if (this.phase !== 'THROWING') return;
    if (!this.setPhase('RESOLVING')) return;
    this.trail = [];
    if (this.recorder) {
      const { chunk, end } = this.recorder.finish(this.layout.asyks.length);
      this.recorder = null;
      this.cb.net?.onThrowChunk(chunk);
      this.cb.net?.onThrowEnd(end);
    }
    this.rules.onSettled(this.currentThrow);
    this.emit();
    this.schedule(RESOLVE_PAUSE_MS, () => this.afterResolve());
  }

  /**
   * Время вышло, пока сақа в руке (или игрок целится): раунд заканчивается сразу.
   * Если сақа уже летит, бросок доигрывается, а раунд заканчивается в `afterResolve` (правила отвечают `finish`).
   */
  private finishByTime(): void {
    if (this.phase === 'AIMING') this.cancelAim(false);
    this.localAim = null;
    this.release = null;
    if (!this.setPhase('ROUND_COMPLETE')) return;
    this.rules.onFinish();
    this.emit();
  }

  private afterResolve(): void {
    if (this.phase !== 'RESOLVING') return;
    const saka = this.physics.saka;
    if (saka) this.effects.dust(saka.body.position.x, saka.body.position.y, 3, 'rgba(230,220,200,1)');
    this.physics.removeSaka();
    // 'server': состояние базы, пришедшее во время показа, применяем до решения «что дальше» — конец матча решает база
    if (this.serverMode && this.canon && this.canonBlocker(this.canon, true) === 'none') this.applyCanonNow(this.canon);

    const step = this.rules.next();
    switch (step.kind) {
      case 'reset':
        // пробный бросок обучения не считается: возвращаем кон в исходное состояние
        this.tutorialPending = false;
        this.resetWorld();
        this.say(step.message, 'good', 2600);
        this.cb.onTutorialDone?.();
        break;
      case 'finish':
        if (!this.setPhase('ROUND_COMPLETE')) return;
        this.rules.onFinish();
        break;
      case 'continue':
        this.remoteAim = null;
        this.setPhase('READY');
        this.hand.sakaInHand = true;
        this.hand.reload = 0;
        this.cb.onCheckpoint?.(this.exportMatchState());
        break;
    }
    this.emit();
    if (this.serverMode) this.serverResume();
  }

  // ——— события физики ———

  private onContact(c: ContactEvent): void {
    if (c.type === 'wall') {
      sound.thud(c.impact);
      if (c.impact > 2) this.effects.dust(c.x, c.y, c.impact * 0.5, 'rgba(205, 200, 190, 1)');
      return;
    }
    const heavy = c.type === 'saka-asyk';
    sound.clack(c.impact, heavy);
    if (c.impact > 1.2) this.effects.dust(c.x, c.y, c.impact * (heavy ? 1 : 0.6));
    if (heavy && c.impact > 7) this.effects.addShake(0.35);
  }

  // ——— анимация руки ———

  /**
   * Движение руки — только картинка: сақа всегда вылетает из THROW_ORIGIN через RELEASE_DELAY_MS
   * после отпускания (на этом держится и онлайн-синхронизация), рука лишь показывает бросок.
   *
   * Замах: рука поворачивается к цели, поднимается и оттягивается назад тем сильнее, чем больше сила.
   * Выброс: разгон вперёд и вниз — в точку выпуска рука приходит у самой земли и на полной скорости,
   * пальцы раскрываются, рука по инерции проходит вперёд, приподнимается и плавно возвращается.
   */
  private animateHand(dt: number): void {
    const h = this.hand;
    const k = 1 - Math.pow(0.001, dt / 1000); // сглаживание, не зависящее от FPS
    if (this.release) {
      const r = this.release;
      const t = this.clock - r.at;
      if (t < RELEASE_DELAY_MS) {
        // разгон: скорость растёт до самого выпуска
        const u = t / RELEASE_DELAY_MS;
        h.offset = r.from * (1 - u * u);
        h.lift = r.lift * (1 - u);
        h.open = 0;
      } else if (t < RELEASE_DELAY_MS + HAND_FOLLOW_MS) {
        // проход вперёд по инерции, пальцы раскрываются — сақа сорвался с них
        const u = (t - RELEASE_DELAY_MS) / HAND_FOLLOW_MS;
        h.offset = HAND_FOLLOW * (1 - (1 - u) * (1 - u));
        h.lift = 0.3 * u;
        h.open = Math.min(1, u * 2.2);
      } else if (t < RELEASE_DELAY_MS + HAND_FOLLOW_MS + HAND_RETURN_MS) {
        const u = (t - RELEASE_DELAY_MS - HAND_FOLLOW_MS) / HAND_RETURN_MS;
        const s = u * u * (3 - 2 * u);
        h.offset = HAND_FOLLOW * (1 - s);
        h.lift = 0.3 * (1 - s);
        h.open = 1 - 0.75 * s;
      } else {
        this.release = null;
      }
    } else if (this.aim) {
      // замах (в онлайне так же двигается рука соперника, пока он целится)
      const aim = this.aim;
      const f = Math.min(1, k * 3);
      h.angle += (aim.angle - h.angle) * f;
      h.offset += (-aim.power * HAND_PULL - h.offset) * f;
      h.lift += (handLift(aim.power) - h.lift) * f;
      h.open += (0 - h.open) * k;
    } else {
      h.offset += (0 - h.offset) * k;
      h.open += (0 - h.open) * k;
      h.lift += (0 - h.lift) * k;
      if (this.phase === 'READY') h.angle += (0 - h.angle) * k * 0.6;
    }
    if (h.sakaInHand && h.reload < 1) h.reload = Math.min(1, h.reload + dt / 320);
  }

  private updateTrail(): void {
    const saka = this.physics.saka;
    if (!saka || this.phase !== 'THROWING') {
      if (this.trail.length) this.trail = [];
      return;
    }
    const v = saka.body.velocity;
    if (Math.hypot(v.x, v.y) > 1.2) {
      this.trail.push({ x: saka.body.position.x, y: saka.body.position.y });
      if (this.trail.length > 10) this.trail.shift();
    } else if (this.trail.length) {
      this.trail.shift();
    }
  }

  // ——— вспомогательное ———

  private buildWorld(): PhysicsWorld {
    const w = new PhysicsWorld();
    w.addObstacles(this.layout.obstacles ?? []);
    w.addAsyks(this.layout.asyks);
    return w;
  }

  private inGrabArea(p: Vec2): boolean {
    const dx = p.x - THROW_ORIGIN.x;
    const dy = p.y - THROW_ORIGIN.y;
    return dx * dx + dy * dy < GRAB_RADIUS * GRAB_RADIUS || p.y > THROW_LINE_Y + 10;
  }

  private advanceTutorialOnAim(): void {
    if (this.tutorialStep === 'drag' && this.localAim && this.localAim.valid && this.localAim.power >= 0.3) {
      this.tutorialStep = 'release';
    }
  }

  private setPhase(next: Phase): boolean {
    if (!TRANSITIONS[this.phase].includes(next)) return false;
    this.phase = next;
    if (next !== 'READY') this.hoverGrab = false;
    return true;
  }

  private runTasks(): void {
    if (!this.tasks.length) return;
    const due = this.tasks.filter((t) => t.at <= this.clock);
    if (!due.length) return;
    this.tasks = this.tasks.filter((t) => t.at > this.clock);
    for (const t of due) t.fn();
  }

  private buildSnapshot(): HudSnapshot {
    return {
      phase: this.phase,
      power: this.localAim?.power ?? 0,
      aiming: this.phase === 'AIMING',
      paused: this.paused,
      tutorialStep: this.tutorialStep,
      message: this.message,
      remoteAiming: this.phase === 'READY' && !!this.remoteAim,
      netWaiting: !!this.player && this.launched && this.replayStalled,
      throwPending: !!this.serverWait,
      mode: this.rules.hud(),
    };
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot();
    for (const l of this.listeners) l();
  }
}
