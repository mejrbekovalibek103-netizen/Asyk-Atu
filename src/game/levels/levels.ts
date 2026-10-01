import type { AsykSpawn, LevelConfig } from '../types';

/**
 * Конфигурация испытаний.
 *
 * Все координаты — в единицах игрового мира 800×1200 (см. config.ts).
 * Сақа всегда бросается снизу из точки (400, 1062).
 */

/** Лёгкий «естественный» разворот асыков, детерминированный (одинаков при каждом запуске). */
function tilt(i: number): number {
  return (((i * 37) % 11) - 5) * 0.014;
}

/** Ряд из n асыков с шагом pitch, центрированный по x = cx. */
function row(n: number, cx: number, y: number, pitch: number, startIndex = 0): AsykSpawn[] {
  return Array.from({ length: n }, (_, i) => ({
    x: cx + (i - (n - 1) / 2) * pitch,
    y,
    angle: tilt(startIndex + i),
  }));
}

export const LEVELS: LevelConfig[] = [
  {
    id: 'warmup',
    order: 1,
    name: 'Разминка',
    kazName: 'Жаттығу',
    description: '5 асыков стоят свободно. Почувствуй силу броска.',
    hint: 'Целься чуть дальше асыка — сақа должен пройти сквозь линию кона.',
    throws: 5,
    zone: { kind: 'rect', x: 120, y: 350, w: 560, h: 160 },
    asyks: row(5, 400, 430, 110),
    goal: { type: 'knockout', count: 3 },
    stars: [{ type: 'knocked', count: 4 }, { type: 'cleared' }],
  },
  {
    id: 'kon',
    order: 2,
    name: 'Кон',
    kazName: 'Кон',
    description: 'Классика двора: 8 асыков плотно в ряд на меловой линии.',
    hint: 'Попади между двумя асыками — выбьешь сразу оба (комбо).',
    throws: 5,
    zone: { kind: 'rect', x: 140, y: 358, w: 520, h: 124 },
    asyks: row(8, 400, 420, 59),
    goal: { type: 'knockout', count: 4 },
    stars: [{ type: 'knocked', count: 6 }, { type: 'cleared' }],
  },
  {
    id: 'uime',
    order: 3,
    name: 'Горка',
    kazName: 'Үйме',
    description: '10 асыков собраны треугольником в круге. Разбей строй!',
    hint: 'Сильный удар в вершину треугольника разлетится цепочкой.',
    throws: 5,
    zone: { kind: 'circle', cx: 400, cy: 458, r: 150 },
    asyks: [
      ...row(4, 400, 392, 60, 0),
      ...row(3, 400, 436, 60, 4),
      ...row(2, 400, 480, 60, 7),
      ...row(1, 400, 524, 60, 9),
    ],
    goal: { type: 'knockout', count: 5 },
    stars: [{ type: 'knocked', count: 8 }, { type: 'cleared' }],
  },
  {
    id: 'mergen',
    order: 4,
    name: 'Мастер меткости',
    kazName: 'Мерген',
    description: 'Синий асык спрятан за охраной. Выбей именно его — всего 3 броска.',
    hint: 'Между передними асыками есть узкий проход. Или выбей охрану в цель.',
    throws: 3,
    zone: { kind: 'rect', x: 190, y: 240, w: 420, h: 240 },
    asyks: [
      { x: 400, y: 330, angle: 0, kind: 'target' },
      { x: 322, y: 330, angle: tilt(1) },
      { x: 478, y: 330, angle: tilt(2) },
      { x: 340, y: 405, angle: tilt(3) },
      { x: 460, y: 405, angle: tilt(4) },
      { x: 262, y: 395, angle: tilt(5) },
      { x: 538, y: 395, angle: tilt(6) },
    ],
    goal: { type: 'target' },
    stars: [
      { type: 'targetWithin', throws: 2 },
      { type: 'targetWithin', throws: 1 },
    ],
  },
  {
    id: 'series',
    order: 5,
    name: 'Серия',
    kazName: 'Тізбек',
    description: '13 асыков и 5 бросков. Каждое попадание подряд — бонус серии.',
    hint: 'Не промахивайся: серия попаданий подряд увеличивает бонус.',
    throws: 5,
    zone: { kind: 'rect', x: 205, y: 332, w: 390, h: 216 },
    asyks: [...row(4, 400, 372, 75, 0), ...row(5, 400, 440, 75, 4), ...row(4, 400, 508, 75, 9)],
    goal: { type: 'knockout', count: 7 },
    stars: [{ type: 'knocked', count: 10 }, { type: 'cleared' }],
  },
];

export function getLevel(id: string): LevelConfig {
  const level = LEVELS.find((l) => l.id === id);
  if (!level) throw new Error(`Unknown level: ${id}`);
  return level;
}

export function nextLevelId(id: string): string | null {
  const i = LEVELS.findIndex((l) => l.id === id);
  return i >= 0 && i < LEVELS.length - 1 ? LEVELS[i + 1].id : null;
}

/** Текст цели уровня для интерфейса. */
export function goalText(level: LevelConfig): string {
  return level.goal.type === 'target'
    ? 'Выбей синий асык'
    : `Выбей минимум ${level.goal.count} из ${level.asyks.length}`;
}

export function starRuleText(rule: LevelConfig['stars'][number], level: LevelConfig): string {
  switch (rule.type) {
    case 'knocked':
      return `Выбей ${rule.count} из ${level.asyks.length}`;
    case 'cleared':
      return 'Очисти весь кон';
    case 'score':
      return `Набери ${rule.value} очков`;
    case 'targetWithin':
      return rule.throws === 1 ? 'Выбей синий асык первым броском' : `Выбей синий асык за ${rule.throws} броска`;
  }
}
