/** Русское склонение по числу: plural(5, ['асык', 'асыка', 'асыков']) → 'асыков'. */
export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

export const NAME_MAX = 16;

/** Имя игрока: без лишних пробелов, не длиннее NAME_MAX, пустое → fallback. */
export function cleanName(raw: string, fallback: string): string {
  const s = raw.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  return s || fallback;
}
