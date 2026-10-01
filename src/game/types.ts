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

export interface LevelConfig {
  id: string;
  /** Номер испытания (1…N). */
  order: number;
  name: string;
  /** Название на казахском. */
  kazName: string;
  /** Короткое описание на карточке. */
  description: string;
  /** Подсказка, показываемая перед раундом. */
  hint: string;
  throws: number;
  zone: Zone;
  asyks: AsykSpawn[];
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

export interface HudSnapshot {
  phase: Phase;
  levelId: string;
  throwsUsed: number;
  throwsTotal: number;
  score: number;
  knocked: number;
  totalAsyks: number;
  hasTarget: boolean;
  targetOut: boolean;
  power: number;
  aiming: boolean;
  streak: number;
  practice: boolean;
  tutorialStep: TutorialStep | null;
  paused: boolean;
  lastThrow: ThrowSummary | null;
  message: HudMessage | null;
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
}
