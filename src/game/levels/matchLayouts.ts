import type { KonLayout } from '../types';
import { getLevel } from './levels';

/** Расстановки для матча вдвоём. Координаты — в единицах мира 800×1200. */

const BIG_KON_COUNT = 12;
const BIG_KON_PITCH = 59;

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
