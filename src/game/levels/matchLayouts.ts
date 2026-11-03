import type { AsykSpawn, KonLayout, Obstacle, Zone } from '../types';
import { getLevel } from './levels';

/**
 * Расстановки для матча (вдвоём на одном устройстве и онлайн на 2–4 игрока). Координаты — в единицах мира 800×1200.
 *
 * Первые пять конов одинаковы при любом числе игроков. Остальные — «растущие»: чем больше игроков, тем больше
 * асыков (у двоих 16, у троих 20, у четверых 24–25 — решение владельца проекта). Кон строится детерминированно
 * из id и числа игроков, поэтому у всех игроков онлайн-матча он одинаковый и по сети не передаётся.
 */

const BIG_KON_COUNT = 12;
const BIG_KON_PITCH = 59;

/**
 * «Рассыпь»: сетка 5×3 с детерминированным смещением. Расстояние между асыками ≥ 77 единиц,
 * поэтому цепных столкновений мало, а матч получается долгим.
 */
function scattered(n: number): AsykSpawn[] {
  const jit = (k: number, amp: number) => (((k * 7919) % 13) / 12 - 0.5) * 2 * amp;
  return Array.from({ length: n }, (_, i) => {
    const c = i % 5;
    const r = Math.floor(i / 5);
    return {
      x: 400 + (c - 2) * 125 + jit(i + 1, 26) + (r === 1 ? 30 : 0),
      y: 320 + r * 95 + jit(i + 5, 14),
      angle: (((i * 37) % 11) - 5) * 0.03,
    };
  });
}

const FIXED_LAYOUTS: KonLayout[] = [
  {
    id: 'ulken-kon',
    name: 'Большой кон',
    kazName: 'Үлкен кон',
    description: '12 асыков плотно в ряд — как во дворе.',
    zone: { kind: 'rect', x: 30, y: 360, w: 740, h: 120 },
    asyks: Array.from({ length: BIG_KON_COUNT }, (_, i) => ({
      x: 400 + (i - (BIG_KON_COUNT - 1) / 2) * BIG_KON_PITCH,
      y: 420,
      angle: (((i * 37) % 11) - 5) * 0.014,
    })),
  },
  {
    id: 'uime',
    name: 'Горка',
    kazName: 'Үйме',
    description: '10 асыков треугольником в круге. Кто разобьёт строй?',
    zone: getLevel('uime').zone,
    asyks: getLevel('uime').asyks,
  },
  {
    id: 'korgan',
    name: 'Крепость',
    kazName: 'Қорған',
    description: '16 асыков в два кольца. Дуэль за центр.',
    zone: { kind: 'circle', cx: 400, cy: 430, r: 238 },
    asyks: [
      ...Array.from({ length: 10 }, (_, k) => ({
        x: 400 + Math.cos((k * 2 * Math.PI) / 10) * 175,
        y: 430 + Math.sin((k * 2 * Math.PI) / 10) * 175,
        angle: (((k * 37) % 11) - 5) * 0.014,
      })),
      ...Array.from({ length: 6 }, (_, k) => ({
        x: 400 + Math.cos(Math.PI / 6 + (k * 2 * Math.PI) / 6) * 95,
        y: 430 + Math.sin(Math.PI / 6 + (k * 2 * Math.PI) / 6) * 95,
        angle: (((k * 53) % 11) - 5) * 0.014,
      })),
    ],
  },
  {
    id: 'rassyp',
    name: 'Рассыпь',
    kazName: 'Шашылған',
    description: '15 асыков стоят врозь — почти каждый требует своего удара.',
    zone: { kind: 'rect', x: 80, y: 265, w: 640, h: 295 },
    asyks: scattered(15),
  },
  {
    id: 'series',
    name: 'Три ряда',
    kazName: 'Тізбек',
    description: '13 асыков в три ряда — долгий матч.',
    zone: getLevel('series').zone,
    asyks: getLevel('series').asyks,
  },
];

// ——— растущие коны ———

export type MatchPlayers = 2 | 3 | 4;

const clampPlayers = (n: number): MatchPlayers => (n <= 2 ? 2 : n >= 4 ? 4 : 3);

/** Лёгкий «естественный» разворот асыков, детерминированный. */
const tilt = (i: number) => (((i * 37) % 11) - 5) * 0.014;

/** Поле вокруг асыков с запасом `pad` (половина асыка + место, чтобы выбитый асык успел выйти за линию). */
function rectAround(asyks: AsykSpawn[], pad: number): Zone {
  const xs = asyks.map((a) => a.x);
  const ys = asyks.map((a) => a.y);
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return { kind: 'rect', x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
}

function numbered(asyks: { x: number; y: number }[]): AsykSpawn[] {
  return asyks.map((a, i) => ({ x: a.x, y: a.y, angle: tilt(i) }));
}

/** Кольцо из n асыков радиуса r вокруг (cx, cy); phase — поворот первого асыка. */
function ring(n: number, cx: number, cy: number, r: number, phase = -Math.PI / 2): { x: number; y: number }[] {
  return Array.from({ length: n }, (_, k) => ({
    x: cx + Math.cos(phase + (k * 2 * Math.PI) / n) * r,
    y: cy + Math.sin(phase + (k * 2 * Math.PI) / n) * r,
  }));
}

interface GrowingLayout {
  id: string;
  name: string;
  kazName: string;
  description: string;
  build: (players: MatchPlayers) => { zone: Zone; asyks: AsykSpawn[]; obstacles?: Obstacle[] };
}

const PAD = 70;
/**
 * Камни на растущих конах стоят позади асыков: центр камня на столько выше верхнего ряда, то есть у дальнего края
 * кона (край кона — на PAD выше). Тень камня (куда сақа из руки не долетает) лежит уже за коном.
 */
const STONE_BACK = 58;

const GROWING_LAYOUTS: GrowingLayout[] = [
  {
    id: 'shenber-big',
    name: 'Большой круг',
    kazName: 'Үлкен шеңбер',
    description: 'Асыки кольцами в большом круге. Чем больше игроков, тем шире круг.',
    build: (n) => {
      const spec = { 2: { outer: 11, ro: 150, inner: 5, ri: 70, center: false }, 3: { outer: 13, ro: 165, inner: 6, ri: 82, center: true }, 4: { outer: 15, ro: 185, inner: 9, ri: 105, center: true } }[n];
      const cx = 400;
      const cy = 410;
      const pts = [...ring(spec.outer, cx, cy, spec.ro), ...ring(spec.inner, cx, cy, spec.ri, Math.PI / 2), ...(spec.center ? [{ x: cx, y: cy }] : [])];
      return { zone: { kind: 'circle', cx, cy, r: spec.ro + 62 }, asyks: numbered(pts) };
    },
  },
  {
    id: 'romb-big',
    name: 'Большой ромб',
    kazName: 'Үлкен ромб',
    description: 'Асыки ромбом: удар в нижнюю вершину разносит его цепочкой.',
    build: (n) => {
      const rows = { 2: [1, 2, 3, 4, 3, 2, 1], 3: [1, 2, 3, 4, 4, 3, 2, 1], 4: [1, 2, 3, 4, 5, 4, 3, 2, 1] }[n];
      const dy = 46;
      const top = 410 - ((rows.length - 1) * dy) / 2;
      const pts = rows.flatMap((k, r) => Array.from({ length: k }, (_, i) => ({ x: 400 + (i - (k - 1) / 2) * 60, y: top + r * dy })));
      const asyks = numbered(pts);
      return { zone: rectAround(asyks, PAD), asyks };
    },
  },
  {
    id: 'irek',
    name: 'Змейки',
    kazName: 'Ирек',
    description: 'Извилистые линии асыков поперёк двора — бей вдоль змейки.',
    build: (n) => {
      const lines = { 2: [{ k: 8, y: 350 }, { k: 8, y: 470 }], 3: [{ k: 10, y: 350 }, { k: 10, y: 470 }], 4: [{ k: 9, y: 300 }, { k: 8, y: 410 }, { k: 8, y: 520 }] }[n];
      const pts = lines.flatMap(({ k, y }) => {
        const pitch = Math.min(70, 560 / (k - 1));
        return Array.from({ length: k }, (_, i) => ({ x: 400 + (i - (k - 1) / 2) * pitch, y: y + (i % 2 ? 22 : -22) }));
      });
      const asyks = numbered(pts);
      return { zone: rectAround(asyks, PAD), asyks };
    },
  },
  {
    id: 'qaqpa-big',
    name: 'Большие ворота',
    kazName: 'Үлкен қақпа',
    description: 'Плотный блок асыков, а за ним два камня-«ворот»: выбивай в проход между ними — от камня асык отскочит назад.',
    build: (n) => {
      const [cols, rows] = ({ 2: [4, 4], 3: [5, 4], 4: [5, 5] } as const)[n];
      const pitchX = 60;
      const pitchY = 48;
      const top = 300;
      const pts = Array.from({ length: cols * rows }, (_, i) => ({ x: 400 + ((i % cols) - (cols - 1) / 2) * pitchX, y: top + Math.floor(i / cols) * pitchY }));
      const asyks = numbered(pts);
      // камни — позади блока, у дальнего края кона: за ними уже не кон, поэтому в коне нет «тени», где асык
      // не достать из руки, а выбитый прямо в камень асык отскакивает обратно
      const halfW = ((cols - 1) / 2) * pitchX;
      const obstacles: Obstacle[] = [
        { x: 400 - halfW, y: top - STONE_BACK, w: 60, h: 40 },
        { x: 400 + halfW, y: top - STONE_BACK, w: 60, h: 40 },
      ];
      return { zone: rectAround(asyks, PAD), asyks, obstacles };
    },
  },
  {
    id: 'tort-uime',
    name: 'Четыре кучки',
    kazName: 'Төрт үйме',
    description: 'Четыре кучки асыков, по кучке на каждого; за дальними кучками — камни.',
    build: (n) => {
      // кучка: 2×2 у двоих, 3+2 у троих, треугольник 3+2+1 у четверых
      const pile = {
        2: [[-29, -24], [29, -24], [-29, 24], [29, 24]],
        3: [[-58, -24], [0, -24], [58, -24], [-29, 24], [29, 24]],
        4: [[-58, -44], [0, -44], [58, -44], [-29, 0], [29, 0], [0, 44]],
      }[n];
      const centers = [[-125, -100], [125, -100], [-125, 100], [125, 100]];
      const pts = centers.flatMap(([cx, cy]) => pile.map(([dx, dy]) => ({ x: 400 + cx + dx, y: 410 + cy + dy })));
      const asyks = numbered(pts);
      const top = Math.min(...asyks.map((a) => a.y));
      return {
        zone: rectAround(asyks, PAD),
        asyks,
        obstacles: [
          { x: 400 - 125, y: top - STONE_BACK, w: 60, h: 40 },
          { x: 400 + 125, y: top - STONE_BACK, w: 60, h: 40 },
        ],
      };
    },
  },
];

const cache = new Map<string, KonLayout>();

function growingFor(g: GrowingLayout, players: MatchPlayers): KonLayout {
  const key = `${g.id}:${players}`;
  let layout = cache.get(key);
  if (!layout) {
    layout = { id: g.id, name: g.name, kazName: g.kazName, description: g.description, ...g.build(players) };
    cache.set(key, layout);
  }
  return layout;
}

/** Все коны матча для выбора (растущие — в виде для двоих). */
export const MATCH_LAYOUTS: KonLayout[] = [...FIXED_LAYOUTS, ...GROWING_LAYOUTS.map((g) => growingFor(g, 2))];

/** Кон растёт с числом игроков. */
export function isGrowingLayout(id: string): boolean {
  return GROWING_LAYOUTS.some((g) => g.id === id);
}

/** Сколько асыков на коне у 2, 3 и 4 игроков. */
export function layoutSizes(id: string): [number, number, number] {
  return ([2, 3, 4] as const).map((n) => getMatchLayout(id, n).asyks.length) as [number, number, number];
}

/** Кон по id для данного числа игроков (неизвестный id — первый кон). */
export function getMatchLayout(id: string, players = 2): KonLayout {
  const g = GROWING_LAYOUTS.find((l) => l.id === id);
  if (g) return growingFor(g, clampPlayers(players));
  return FIXED_LAYOUTS.find((l) => l.id === id) ?? FIXED_LAYOUTS[0];
}
