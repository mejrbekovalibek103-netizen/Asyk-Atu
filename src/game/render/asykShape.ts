/**
 * Силуэт асыка (вид сверху) как SVG-path. Один источник формы и для Canvas (Path2D),
 * и для SVG-иконок интерфейса. Длинная ось — по X, центр в (0, 0).
 */
export function asykPathD(w: number, h: number): string {
  const a = w / 2;
  const b = h / 2;
  const f = (n: number) => n.toFixed(2);
  const P = (x: number, y: number) => `${f(x * a)} ${f(y * b)}`;
  return [
    `M ${P(-0.55, -1)}`,
    `C ${P(-0.2, -0.72)} ${P(0.2, -0.72)} ${P(0.55, -1)}`,
    `C ${P(0.95, -1.12)} ${P(1.08, -0.45)} ${P(0.93, 0)}`,
    `C ${P(1.08, 0.45)} ${P(0.95, 1.12)} ${P(0.55, 1)}`,
    `C ${P(0.2, 0.72)} ${P(-0.2, 0.72)} ${P(-0.55, 1)}`,
    `C ${P(-0.95, 1.12)} ${P(-1.08, 0.45)} ${P(-0.93, 0)}`,
    `C ${P(-1.08, -0.45)} ${P(-0.95, -1.12)} ${P(-0.55, -1)}`,
    'Z',
  ].join(' ');
}

export type AsykPalette = 'bone' | 'saka' | 'saka2' | 'saka3' | 'saka4' | 'target';

export const PALETTES: Record<AsykPalette, { light: string; mid: string; dark: string; stroke: string }> = {
  bone: { light: '#fbf1dc', mid: '#ecd6ae', dark: '#c9a472', stroke: 'rgba(110, 76, 38, 0.55)' },
  saka: { light: '#f47a58', mid: '#d4442b', dark: '#8f2417', stroke: 'rgba(80, 18, 10, 0.6)' },
  /** сақа второго игрока в матче — крашеный в фиолетовый */
  saka2: { light: '#b693ff', mid: '#7b4fd6', dark: '#45228f', stroke: 'rgba(35, 12, 70, 0.6)' },
  /** третий и четвёртый игроки онлайн-матча — зелёный и жёлтый */
  saka3: { light: '#7ad6a0', mid: '#2f9e5f', dark: '#165c34', stroke: 'rgba(10, 45, 25, 0.6)' },
  saka4: { light: '#ffd76a', mid: '#e0a610', dark: '#8a6100', stroke: 'rgba(70, 48, 0, 0.6)' },
  target: { light: '#7fd9ee', mid: '#27a6c8', dark: '#136a86', stroke: 'rgba(10, 50, 70, 0.6)' },
};
