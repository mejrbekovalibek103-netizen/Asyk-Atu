/** Русское склонение по числу: plural(5, ['асык', 'асыка', 'асыков']) → 'асыков'. */
export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

/** Оставшееся время для таймера: 83000 → «1:23». Секунды округляются вверх, поэтому «0:00» — только когда время вышло. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Лимит времени словами: 60 → «1 мин», 90 → «1 мин 30 с», 45 → «45 с». */
export function timeLimitText(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m === 0) return `${s} с`;
  return s === 0 ? `${m} мин` : `${m} мин ${s} с`;
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
