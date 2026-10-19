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
  {
    id: 'ekikatar',
    order: 6,
    name: 'Две линии',
    kazName: 'Екі қатар',
    description: '9 асыков в два ряда, второй ряд спрятан за щелями первого.',
    hint: 'Прямой бросок в щель между асыками первого ряда бьёт по асыку за ней.',
    throws: 5,
    zone: { kind: 'rect', x: 120, y: 285, w: 560, h: 210 },
    asyks: [...row(5, 400, 345, 100, 0), ...row(4, 400, 435, 100, 5)],
    goal: { type: 'knockout', count: 4 },
    stars: [{ type: 'knocked', count: 6 }, { type: 'cleared' }],
  },
  {
    id: 'korgan',
    order: 7,
    name: 'Крепость',
    kazName: 'Қорған',
    description: '12 асыков в два кольца: внешнее из восьми и внутреннее из четырёх.',
    hint: 'Удар в кольцо разгоняет асыки внутрь: целься так, чтобы задеть сразу два.',
    throws: 5,
    zone: { kind: 'circle', cx: 400, cy: 430, r: 205 },
    asyks: [
      ...Array.from({ length: 8 }, (_, k) => ({
        x: 400 + Math.cos((k * Math.PI) / 4) * 150,
        y: 430 + Math.sin((k * Math.PI) / 4) * 150,
        angle: tilt(k),
      })),
      ...Array.from({ length: 4 }, (_, k) => ({
        x: 400 + Math.cos(Math.PI / 4 + (k * Math.PI) / 2) * 62,
        y: 430 + Math.sin(Math.PI / 4 + (k * Math.PI) / 2) * 62,
        angle: tilt(8 + k),
      })),
    ],
    goal: { type: 'knockout', count: 5 },
    stars: [{ type: 'knocked', count: 8 }, { type: 'cleared' }],
  },
  {
    id: 'tas',
    order: 8,
    name: 'Камень',
    kazName: 'Тас',
    description: 'Ряд из 7 асыков, а посреди двора лежит камень: средний асык прямым броском не достать.',
    hint: 'Выбей соседние асыки так, чтобы они толкнули спрятанный за камнем, — цепочка дойдёт и до него.',
    throws: 5,
    zone: { kind: 'rect', x: 130, y: 335, w: 540, h: 110 },
    obstacles: [{ x: 370, y: 480, w: 60, h: 42 }],
    asyks: row(7, 400, 390, 62, 0),
    goal: { type: 'knockout', count: 3 },
    stars: [{ type: 'knocked', count: 5 }, { type: 'cleared' }],
  },
  {
    id: 'mergen2',
    order: 9,
    name: 'Мерген за камнем',
    kazName: 'Мерген-2',
    description: 'Синий асык прикрыт охраной, а сбоку лежит камень. Всего 5 бросков.',
    hint: 'Ищи узкий проход рядом с камнем: синий асык виден только под небольшим углом.',
    throws: 5,
    zone: { kind: 'rect', x: 210, y: 245, w: 380, h: 170 },
    obstacles: [{ x: 280, y: 470, w: 100, h: 44 }],
    asyks: [
      { x: 400, y: 305, angle: 0, kind: 'target' },
      { x: 332, y: 305, angle: tilt(1) },
      { x: 468, y: 305, angle: tilt(2) },
      { x: 365, y: 375, angle: tilt(3) },
      { x: 435, y: 375, angle: tilt(4) },
      { x: 270, y: 330, angle: tilt(5) },
      { x: 530, y: 330, angle: tilt(6) },
    ],
    goal: { type: 'target' },
    stars: [
      { type: 'targetWithin', throws: 2 },
      { type: 'targetWithin', throws: 1 },
    ],
  },
  {
    id: 'master',
    order: 10,
    name: 'Мастер двора',
    kazName: 'Аула шебері',
    description: '12 асыков плотным блоком и два камня по бокам. Финальное испытание: 7 бросков.',
    hint: 'Камни закрывают боковые подходы. Бей в центр блока и добивай крайние асыки через соседей.',
    throws: 7,
    zone: { kind: 'rect', x: 250, y: 250, w: 300, h: 208 },
    obstacles: [
      { x: 230, y: 480, w: 60, h: 40 },
      { x: 510, y: 480, w: 60, h: 40 },
    ],
    asyks: [...row(4, 400, 310, 60, 0), ...row(4, 400, 364, 60, 4), ...row(4, 400, 418, 60, 8)],
    goal: { type: 'knockout', count: 6 },
    stars: [{ type: 'knocked', count: 9 }, { type: 'cleared' }],
  },

  // ——— Испытания со временем (11–20) ———
  // Время отсчитывается с первого касания руки (до этого стоит) и на паузе. Сам бросок вместе с паузой занимает
  // около 2 секунд, остальное — прицеливание, поэтому лимит — 10–12 секунд на бросок (кратно 5 секундам, чуть
  // больше там, где нужно думать над камнями). Когда время вышло, бросок в полёте доигрывается, раунд
  // заканчивается, засчитывается выбитое. Каждое испытание проверено решателем: кон очищается с запасом хотя бы
  // в один бросок (solvability.test.ts). Лимит меняется одной цифрой `timeLimit`.
  {
    id: 'zhyldam',
    order: 11,
    name: 'Быстрая рука',
    kazName: 'Жылдам қол',
    description: 'Шесть асыков в ряд — первое испытание на время. Не засиживайся с прицелом!',
    hint: 'Не тяни с прицелом: выбивай по два асыка за бросок, пока не вышло время.',
    throws: 4,
    timeLimit: 60,
    zone: { kind: 'rect', x: 150, y: 340, w: 500, h: 120 },
    asyks: row(6, 400, 400, 80, 0),
    goal: { type: 'knockout', count: 3 },
    stars: [{ type: 'knocked', count: 5 }, { type: 'cleared' }],
  },
  {
    id: 'ekiqabyrga',
    order: 12,
    name: 'Две стенки',
    kazName: 'Екі қабырға',
    description: 'Десять асыков двумя плотными рядами. Бросков пять, а времени в обрез.',
    hint: 'Удар в стык передней стенки разгоняет и заднюю — ищи брешь.',
    throws: 5,
    timeLimit: 55,
    zone: { kind: 'rect', x: 225, y: 300, w: 350, h: 190 },
    asyks: [...row(5, 400, 360, 64, 0), ...row(5, 400, 424, 64, 5)],
    goal: { type: 'knockout', count: 5 },
    stars: [{ type: 'knocked', count: 8 }, { type: 'cleared' }],
  },
  {
    id: 'shenber',
    order: 13,
    name: 'Круг',
    kazName: 'Шеңбер',
    description: 'Кольцо из восьми асыков и один в центре. Четыре броска — решай быстро.',
    hint: 'Асык в центре толкает кольцо изнутри — бей так, чтобы задеть сразу два.',
    throws: 4,
    timeLimit: 45,
    zone: { kind: 'circle', cx: 400, cy: 420, r: 150 },
    asyks: [
      ...Array.from({ length: 8 }, (_, i) => ({
        x: 400 + Math.cos((i * 2 * Math.PI) / 8) * 90,
        y: 420 + Math.sin((i * 2 * Math.PI) / 8) * 90,
        angle: tilt(i),
      })),
      { x: 400, y: 420, angle: 0 },
    ],
    goal: { type: 'knockout', count: 4 },
    stars: [{ type: 'knocked', count: 7 }, { type: 'cleared' }],
  },
  {
    id: 'mergen3',
    order: 14,
    name: 'Снайпер',
    kazName: 'Мерген-3',
    description: 'Синий асык за стенкой из трёх охранников. Три броска — и целиться некогда.',
    hint: 'Бей в среднего охранника: он толкнёт синий асык. Или ищи угол сбоку.',
    throws: 3,
    timeLimit: 35,
    zone: { kind: 'rect', x: 250, y: 250, w: 300, h: 210 },
    asyks: [
      { x: 400, y: 300, angle: 0, kind: 'target' },
      { x: 346, y: 352, angle: tilt(1) },
      { x: 400, y: 352, angle: tilt(2) },
      { x: 454, y: 352, angle: tilt(3) },
      { x: 318, y: 305, angle: tilt(4) },
      { x: 482, y: 305, angle: tilt(5) },
    ],
    goal: { type: 'target' },
    stars: [
      { type: 'targetWithin', throws: 2 },
      { type: 'targetWithin', throws: 1 },
    ],
  },
  {
    id: 'bulau',
    order: 15,
    name: 'Зигзаг',
    kazName: 'Бұлау',
    description: 'Девять асыков зигзагом, а перед ними лежит камень.',
    hint: 'Камень закрывает середину зигзага — выбей боковые асыки, чтобы они толкнули остальных.',
    throws: 6,
    timeLimit: 70,
    zone: { kind: 'rect', x: 130, y: 320, w: 540, h: 150 },
    obstacles: [{ x: 400, y: 490, w: 80, h: 42 }],
    asyks: Array.from({ length: 9 }, (_, i) => ({ x: 400 + (i - 4) * 58, y: i % 2 ? 420 : 370, angle: tilt(i) })),
    goal: { type: 'knockout', count: 4 },
    stars: [{ type: 'knocked', count: 7 }, { type: 'cleared' }],
  },
  {
    id: 'romb',
    order: 16,
    name: 'Ромб',
    kazName: 'Ромб',
    description: 'Тринадцать асыков ромбом. Шесть бросков на всё.',
    hint: 'Сильный удар в верхнюю или нижнюю вершину разносит ромб цепочкой.',
    throws: 6,
    timeLimit: 70,
    zone: { kind: 'rect', x: 245, y: 245, w: 310, h: 290 },
    asyks: [...row(1, 400, 290, 60, 0), ...row(3, 400, 340, 60, 1), ...row(5, 400, 390, 60, 4), ...row(3, 400, 440, 60, 9), ...row(1, 400, 490, 60, 12)],
    goal: { type: 'knockout', count: 6 },
    stars: [{ type: 'knocked', count: 10 }, { type: 'cleared' }],
  },
  {
    id: 'qaqpa',
    order: 17,
    name: 'Ворота',
    kazName: 'Қақпа',
    description: 'Блок из десяти асыков и два камня-«ворота» у его основания.',
    hint: 'Камни закрывают боковые подходы: бей по центру, а края добивай через соседей.',
    throws: 6,
    timeLimit: 70,
    zone: { kind: 'rect', x: 230, y: 320, w: 340, h: 150 },
    obstacles: [
      { x: 250, y: 510, w: 60, h: 40 },
      { x: 510, y: 510, w: 60, h: 40 },
    ],
    asyks: [...row(5, 400, 370, 62, 0), ...row(5, 400, 430, 62, 5)],
    goal: { type: 'knockout', count: 5 },
    stars: [{ type: 'knocked', count: 8 }, { type: 'cleared' }],
  },
  {
    id: 'mergen4',
    order: 18,
    name: 'Снайпер за камнем',
    kazName: 'Мерген-4',
    description: 'Синий асык, охрана и камень на подходе. Четыре броска.',
    hint: 'Камень сдвинут влево: синий асык виден под небольшим углом справа от него.',
    throws: 4,
    timeLimit: 50,
    zone: { kind: 'rect', x: 250, y: 250, w: 300, h: 190 },
    obstacles: [{ x: 340, y: 510, w: 60, h: 42 }],
    asyks: [
      { x: 400, y: 300, angle: 0, kind: 'target' },
      { x: 350, y: 345, angle: tilt(1) },
      { x: 450, y: 345, angle: tilt(2) },
      { x: 310, y: 305, angle: tilt(3) },
      { x: 490, y: 305, angle: tilt(4) },
      { x: 375, y: 400, angle: tilt(5) },
      { x: 425, y: 400, angle: tilt(6) },
    ],
    goal: { type: 'target' },
    stars: [
      { type: 'targetWithin', throws: 2 },
      { type: 'targetWithin', throws: 1 },
    ],
  },
  {
    id: 'ushuime',
    order: 19,
    name: 'Три кучки',
    kazName: 'Үш үйме',
    description: 'Три кучки по четыре асыка, а по краям лежат камни.',
    hint: 'Кучки стоят рядом: удар по краю одной кучки задевает соседнюю.',
    throws: 7,
    timeLimit: 85,
    zone: { kind: 'rect', x: 190, y: 290, w: 420, h: 180 },
    obstacles: [
      { x: 262, y: 500, w: 60, h: 40 },
      { x: 538, y: 500, w: 60, h: 40 },
    ],
    asyks: [262, 400, 538].flatMap((cx, g) =>
      [
        [-29, 0],
        [29, 0],
        [-29, 58],
        [29, 58],
      ].map(([dx, dy], i) => ({ x: cx + dx, y: 340 + dy, angle: tilt(g * 4 + i) })),
    ),
    goal: { type: 'knockout', count: 6 },
    stars: [{ type: 'knocked', count: 9 }, { type: 'cleared' }],
  },
  {
    id: 'champion',
    order: 20,
    name: 'Чемпион двора',
    kazName: 'Аула чемпионы',
    description: 'Шестнадцать асыков плотным квадратом и три камня. Финал: восемь бросков.',
    hint: 'Квадрат плотный: каждый бросок должен задевать как можно больше асыков. Камни закрывают подходы снизу.',
    throws: 8,
    timeLimit: 90,
    zone: { kind: 'rect', x: 270, y: 250, w: 260, h: 250 },
    obstacles: [
      { x: 275, y: 520, w: 60, h: 40 },
      { x: 525, y: 520, w: 60, h: 40 },
      { x: 400, y: 555, w: 50, h: 40 },
    ],
    asyks: Array.from({ length: 16 }, (_, i) => ({ x: 400 + ((i % 4) - 1.5) * 56, y: 300 + Math.floor(i / 4) * 50, angle: tilt(i) })),
    goal: { type: 'knockout', count: 8 },
    stars: [{ type: 'knocked', count: 13 }, { type: 'cleared' }],
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
