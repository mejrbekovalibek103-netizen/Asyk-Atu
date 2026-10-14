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

/** Сколько символов вообще рассматриваем: огромные строки отбрасываем до дорогой обработки. */
const NAME_RAW_MAX = 100;

/**
 * Безопасное имя игрока. Применяется и к своему вводу, и ко ВСЕМУ, что пришло от соперника или из хранилища.
 *
 * - не строка → fallback;
 * - нормализация Unicode (NFC);
 * - удаляются управляющие, «невидимые» и форматирующие символы (в том числе U+202E «переворот текста»,
 *   нулевой ширины, разделители строк), частные и неназначенные коды: ими подделывают надписи;
 * - пробелы схлопываются, длина — не больше NAME_MAX символов (по кодовым точкам, суррогаты не режутся).
 */
export function cleanName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const s = raw
    .slice(0, NAME_RAW_MAX)
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const cut = Array.from(s).slice(0, NAME_MAX).join('').trim();
  return cut || fallback;
}
