import { describe, expect, it } from 'vitest';
import { clock, cleanName, NAME_MAX, plural, timeLimitText } from './format';

describe('cleanName: имя из недоверенного источника', () => {
  it('обычные имена остаются как есть, пробелы схлопываются', () => {
    expect(cleanName('Айдос', 'x')).toBe('Айдос');
    expect(cleanName('  Дана   Ахметова  ', 'x')).toBe('Дана Ахметова');
    expect(cleanName('Қарлығаш', 'x')).toBe('Қарлығаш');
  });

  it('не строка → запасное имя', () => {
    for (const v of [null, undefined, 5, {}, [], true, NaN]) expect(cleanName(v, 'Игрок')).toBe('Игрок');
  });

  it('пустое после очистки → запасное имя', () => {
    expect(cleanName('', 'Игрок')).toBe('Игрок');
    expect(cleanName('   \t\n', 'Игрок')).toBe('Игрок');
    expect(cleanName('​‍‮', 'Игрок')).toBe('Игрок');
  });

  it('удаляет символы-подделки: переворот текста, нулевую ширину, управляющие, разделители строк', () => {
    expect(cleanName('‮evil', 'x')).toBe('evil'); // U+202E: «переворот» — подменяет порядок букв
    expect(cleanName('a​b⁠c﻿d', 'x')).toBe('abcd'); // нулевой ширины
    expect(cleanName('a\u0000b\u0007c\u001bd', 'x')).toBe('abcd'); // управляющие
    expect(cleanName('a b c', 'x')).toBe('abc'); // разделители строк и абзацев
    expect(cleanName('ab', 'x')).toBe('ab'); // частная область
    expect(cleanName('a⁦b⁩c', 'x')).toBe('abc'); // bidi-изоляции
  });

  it('длина ограничена по символам, а не по байтам; суррогатные пары не режутся', () => {
    const long = 'я'.repeat(500);
    expect([...cleanName(long, 'x')].length).toBe(NAME_MAX);
    const emoji = '😀'.repeat(40);
    const cut = cleanName(emoji, 'x');
    expect([...cut].length).toBe(NAME_MAX);
    expect(cut).toBe('😀'.repeat(NAME_MAX)); // ни одной «половинки» пары
  });

  it('огромная строка не вешает обработку', () => {
    const t = performance.now();
    cleanName('a'.repeat(5_000_000), 'x');
    expect(performance.now() - t).toBeLessThan(200);
  });

  it('текст с разметкой остаётся текстом (экранирует React), но не длиннее предела', () => {
    expect(cleanName('<script>alert(1)</script>', 'x')).toBe('<script>alert(1)');
  });

  it('нормализует Unicode (составные и раздельные формы дают одно имя)', () => {
    expect(cleanName('é', 'x')).toBe(cleanName('é', 'x'));
  });
});

describe('plural', () => {
  it('склонение по числу', () => {
    expect(plural(1, ['асык', 'асыка', 'асыков'])).toBe('асык');
    expect(plural(3, ['асык', 'асыка', 'асыков'])).toBe('асыка');
    expect(plural(11, ['асык', 'асыка', 'асыков'])).toBe('асыков');
    expect(plural(21, ['асык', 'асыка', 'асыков'])).toBe('асык');
  });
});

describe('время испытания', () => {
  it('clock: m:ss, секунды округляются вверх, «0:00» — только когда время вышло', () => {
    expect(clock(60_000)).toBe('1:00');
    expect(clock(83_000)).toBe('1:23');
    expect(clock(59_001)).toBe('1:00');
    expect(clock(9_100)).toBe('0:10');
    expect(clock(1)).toBe('0:01');
    expect(clock(0)).toBe('0:00');
    expect(clock(-500)).toBe('0:00');
    expect(clock(600_000)).toBe('10:00');
  });

  it('timeLimitText: словами', () => {
    expect(timeLimitText(35)).toBe('35 с');
    expect(timeLimitText(60)).toBe('1 мин');
    expect(timeLimitText(90)).toBe('1 мин 30 с');
    expect(timeLimitText(75)).toBe('1 мин 15 с');
    expect(timeLimitText(120)).toBe('2 мин');
  });
});
