import type { AsykSpawn, KonLayout } from '../types';
import { getLevel } from './levels';

/** Расстановки для матча вдвоём. Координаты — в единицах мира 800×1200. */

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

export const MATCH_LAYOUTS: KonLayout[] = [
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

export function getMatchLayout(id: string): KonLayout {
  return MATCH_LAYOUTS.find((l) => l.id === id) ?? MATCH_LAYOUTS[0];
}
