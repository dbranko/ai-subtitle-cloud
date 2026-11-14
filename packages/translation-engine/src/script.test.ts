import { describe, expect, it } from 'vitest';
import {
  containsCyrillic,
  extractTags,
  hasTranslatableText,
  measureScript,
  sameTags,
  serbianCyrillicToLatin,
  stripTags,
} from './index.js';

describe('serbianCyrillicToLatin', () => {
  it('transliterates the full alphabet', () => {
    expect(serbianCyrillicToLatin('абвгдђежзијклљмнњопрстћуфхцчџш')).toBe(
      'abvgdđežzijklljmnnjoprstćufhcčdžš',
    );
  });

  it('capitalises digraphs according to the word', () => {
    expect(serbianCyrillicToLatin('Љубав и Његош у Џибутију')).toBe('Ljubav i Njegoš u Džibutiju');
    expect(serbianCyrillicToLatin('ЉУБАВ, ЊЕГОШ, ЏИБУТИ')).toBe('LJUBAV, NJEGOŠ, DŽIBUTI');
    expect(serbianCyrillicToLatin('ПОЉЕ')).toBe('POLJE');
    expect(serbianCyrillicToLatin('Њ')).toBe('Nj');
  });

  it('leaves everything that is not Serbian Cyrillic untouched', () => {
    expect(serbianCyrillicToLatin('<i>Добро вече!</i> 12:30 — OK?')).toBe(
      '<i>Dobro veče!</i> 12:30 — OK?',
    );
    expect(serbianCyrillicToLatin('Već latinica.')).toBe('Već latinica.');
  });

  it('removes all Cyrillic from Serbian text', () => {
    const out = serbianCyrillicToLatin('Чича Глиша једе шљиве, ђак учи, ћуран бежи.');
    expect(containsCyrillic(out)).toBe(false);
    expect(out).toBe('Čiča Gliša jede šljive, đak uči, ćuran beži.');
  });
});

describe('measureScript', () => {
  it('measures the share of letters in the expected script', () => {
    expect(measureScript('Добро вече', 'Cyrl')).toEqual({ letters: 9, expected: 9, ratio: 1 });
    expect(measureScript('Dobro veče', 'Cyrl').ratio).toBe(0);
    expect(measureScript('Dobro вече', 'Latn').ratio).toBeCloseTo(5 / 9);
    expect(measureScript('こんにちは世界', 'Jpan').ratio).toBe(1);
    expect(measureScript('12:30 ... ♪', 'Latn')).toEqual({ letters: 0, expected: 0, ratio: 1 });
  });
});

describe('markup helpers', () => {
  it('extracts HTML-like tags and ASS override blocks', () => {
    expect(extractTags('{\\an8}<b>LISBON</b> <font color="#ffff00">x</font>')).toEqual([
      '{\\an8}',
      '<b>',
      '</b>',
      '<font color="#ffff00">',
      '</font>',
    ]);
    expect(extractTags('a < b and c > d')).toEqual([]);
    expect(stripTags('<i>Hello</i> {\\an8}there')).toBe('Hello there');
  });

  it('compares tag sets regardless of order and tag-name case', () => {
    expect(sameTags('<i>Hello</i> <b>you</b>', '<b>ti</b> <I>zdravo</I>')).toBe(true);
    expect(sameTags('<i>Hello</i>', 'Zdravo')).toBe(false);
    expect(sameTags('<i>Hello</i>', '<i>Zdravo</i></i>')).toBe(false);
    expect(sameTags('<font color="#ffff00">a</font>', '<font color="#ff0000">a</font>')).toBe(
      false,
    );
    expect(sameTags('plain', 'obično')).toBe(true);
  });

  it('detects whether there is anything to translate', () => {
    expect(hasTranslatableText('<i>Hello</i>')).toBe(true);
    expect(hasTranslatableText('♪♪')).toBe(false);
    expect(hasTranslatableText('<i>...</i>')).toBe(false);
    expect(hasTranslatableText('42')).toBe(true);
  });
});
