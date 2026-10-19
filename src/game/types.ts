export interface Vec2 {
  x: number;
  y: number;
}

/** Игровая зона (кон), нарисованная мелом. Асык выбит, когда его центр покинул зону. */
export type Zone =
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  | { kind: 'circle'; cx: number; cy: number; r: number };

/** Стороны асыка — используются только для оформления (у каждого асыка свой «рисунок»). */
export type AsykFace = 'alshy' | 'taiky' | 'buk' | 'shik';

export type PieceKind = 'saka' | 'asyk' | 'target';

export interface AsykSpawn {
  x: number;
  y: number;
  /** Поворот в радианах. */
  angle?: number;
  /** 'target' — помеченный (синий) асык в испытании на меткость. */
  kind?: 'asyk' | 'target';
}

export type LevelGoal =
  | { type: 'knockout'; count: number }
  | { type: 'target' };

/** Условие для 2-й и 3-й звезды (1-я звезда = выполнена цель уровня). */
export type StarRule =
  | { type: 'knocked'; count: number }
  | { type: 'cleared' }
  | { type: 'score'; value: number }
  | { type: 'targetWithin'; throws: number };

/**
 * Неподвижное препятствие на поле — камень. Прямоугольник с центром в (x, y);
 * сақа и асыки отскакивают от него, а прямой бросок через камень невозможен.
 */
export interface Obstacle {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Расстановка: меловой кон, асыки в нём и препятствия. Общая для испытаний и матчей. */
export interface KonLayout {
  id: string;
  name: string;
  /** Название на казахском. */
  kazName: string;
  /** Короткое описание на карточке. */
  description: string;
  zone: Zone;
  asyks: AsykSpawn[];
  /** Камни на поле (необязательно). */
  obstacles?: Obstacle[];
}

/** Испытание одиночной игры: расстановка + число бросков, цель и звёзды. */
export interface LevelConfig extends KonLayout {
  /** Номер испытания (1…N). */
  order: number;
  /** Подсказка, показываемая перед раундом. */
  hint: string;
  throws: number;
  /**
   * Ограничение времени, секунд (у испытаний со временем). Отсчёт идёт с первого касания руки и стоит на паузе.
   * Когда время вышло, раунд заканчивается (бросок в полёте доигрывается), засчитывается выбитое.
   */
  timeLimit?: number;
  goal: LevelGoal;
  stars: [StarRule, StarRule];
}

/** Фазы игрового процесса внутри экрана игры. */
export type Phase =
  | 'READY' // сақа в руке, ждём игрока
  | 'AIMING' // игрок тянет/целится
  | 'THROWING' // сақа летит, физика в движении
  | 'RESOLVING' // всё остановилось, подводим итог броска
  | 'ROUND_COMPLETE'; // раунд окончен

export type TutorialStep = 'grab' | 'drag' | 'release' | 'watch';

export interface ThrowSummary {
  index: number;
  knocked: number;
  points: number;
  comboBonus: number;
  streakBonus: number;
  streak: number;
  targetKnocked: boolean;
  practice: boolean;
}

export interface HudMessage {
  id: number;
  text: string;
  tone: 'info' | 'good' | 'warn';
}

/** Данные HUD одиночного испытания. */
export interface SoloHud {
  kind: 'solo';
  throwsUsed: number;
  throwsTotal: number;
  score: number;
  knocked: number;
  totalAsyks: number;
  hasTarget: boolean;
  targetOut: boolean;
  streak: number;
  practice: boolean;
  lastThrow: ThrowSummary | null;
  /** Испытание со временем: лимит и сколько осталось, мс (null — времени нет). */
  timeLimitMs: number | null;
  timeLeftMs: number | null;
  /** Таймер уже запущен (игрок взял сақа): до этого время стоит. */
  timerRunning: boolean;
}

export type Seat = 0 | 1;

export interface MatchPlayerHud {
  name: string;
  knocked: number;
  throws: number;
}

/** Данные HUD матча вдвоём. */
export interface MatchHud {
  kind: 'match';
  players: [MatchPlayerHud, MatchPlayerHud];
  /** Чей сейчас ход. */
  current: Seat;
  /** Растёт при каждой смене хода — для баннера «Ход: …». */
  turnId: number;
  totalThrows: number;
  maxThrows: number;
  asyksLeft: number;
  totalAsyks: number;
  /** Онлайн: за какого игрока этот экран (null — оба на одном устройстве). */
  localSeat: Seat | null;
  finished: boolean;
  /** Одно устройство: ждём, пока ход примет следующий игрок (бросок заблокирован до «Готов»). */
  handoff: boolean;
}

export type ModeHud = SoloHud | MatchHud;

export interface HudSnapshot {
  phase: Phase;
  power: number;
  aiming: boolean;
  paused: boolean;
  tutorialStep: TutorialStep | null;
  message: HudMessage | null;
  /** Онлайн: соперник сейчас целится (видна его рука и пунктир). */
  remoteAiming: boolean;
  /** Онлайн: воспроизведение броска соперника ждёт данные из сети. */
  netWaiting: boolean;
  mode: ModeHud;
}

export interface RoundResult {
  levelId: string;
  score: number;
  knocked: number;
  totalAsyks: number;
  throwsUsed: number;
  throwsTotal: number;
  cleared: boolean;
  cleanBonus: number;
  targetOut: boolean;
  /** Номер броска (1…), которым выбит помеченный асык. */
  targetThrow: number | null;
  bestCombo: number;
  hitThrows: number;
  passed: boolean;
  stars: number;
  /** Раунд закончился, потому что вышло время (испытания со временем). */
  timeUp: boolean;
  /** Лимит времени испытания, секунд (null — без времени) и сколько ушло, мс. */
  timeLimit: number | null;
  timeUsedMs: number;
}

export interface MatchConfig {
  layoutId: string;
  players: [string, string];
  /** Кто бросает первым (результат жеребьёвки или очерёдность реванша). */
  first: Seat;
  /** Реванш: без жеребьёвки, первым бросает другой игрок. */
  rematch?: boolean;
  /** Одно устройство: перед каждым ходом показывать экран «Передайте устройство». */
  handoff?: boolean;
}

export interface MatchResult {
  layoutId: string;
  players: [MatchPlayerResult, MatchPlayerResult];
  /** null — ничья. */
  winner: Seat | null;
  totalThrows: number;
  /** 'cleared' — кон опустел, 'limit' — закончились броски. */
  reason: 'cleared' | 'limit';
}

export interface MatchPlayerResult {
  name: string;
  knocked: number;
  throws: number;
  bestCombo: number;
}
