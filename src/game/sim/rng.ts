/**
 * Свой генератор случайных чисел для серверного броска (sfc32, Chris Doty-Humphrey).
 *
 * Math.random нельзя: его нельзя «засеять», и повтор того же броска дал бы другой результат.
 * sfc32 — только 32-битная целочисленная арифметика, поэтому последовательность одинакова в Node, Deno и браузере.
 */

/** Генератор из ≥16 байт (первые 16 — четыре 32-битных слова, little-endian). Числа в [0, 1). */
export function sfc32(seed: Uint8Array): () => number {
  if (!(seed instanceof Uint8Array) || seed.length < 16) throw new Error('sfc32: нужно не меньше 16 байт');
  const word = (k: number) => (seed[k] | (seed[k + 1] << 8) | (seed[k + 2] << 16) | (seed[k + 3] << 24)) | 0;
  let a = word(0);
  let b = word(4);
  let c = word(8);
  let d = word(12);
  const next = (): number => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  // разогрев: первые числа после «плохого» зерна (например, из нулей) ещё плохо перемешаны
  for (let i = 0; i < 12; i++) next();
  return next;
}

/** Строка hex → байты. Допускается префикс `\x` (так Postgres отдаёт bytea) или `0x`. Неверная строка — ошибка. */
export function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== 'string') throw new Error('hexToBytes: нужна строка');
  const h = hex.startsWith('\\x') || hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error('hexToBytes: неверная строка hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
