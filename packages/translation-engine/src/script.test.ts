import { describe, expect, it } from 'vitest';
import {
  containsCyrillic,
  extractTags,
  hasTranslatableText,
  measureScript,
  repairTags,
  sameTags,
  serbianCyrillicToLatin,
  simplifyTags,
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

describe('repairTags / simplifyTags', () => {
  it('returns the translation unchanged when the tags already match', () => {
    expect(repairTags('<i>Hello</i>', '<i>Zdravo</i>')).toBe('<i>Zdravo</i>');
  });

  it('restores tags that wrap the whole entry or every line', () => {
    expect(repairTags('<i>Hello</i>', 'Zdravo')).toBe('<i>Zdravo</i>');
    expect(repairTags('{\\an8}<b>LISBON, 1987</b>', 'LISABON, 1987.')).toBe(
      '{\\an8}<b>LISABON, 1987.</b>',
    );
    expect(repairTags('<i>Line one\nline two</i>', 'Prvi red\ndrugi red')).toBe(
      '<i>Prvi red\ndrugi red</i>',
    );
    expect(
      repairTags(
        '<font color="#ffff00">I can explain.</font>\n<i>If you let me.</i>',
        'Mogu objasniti.\nAko me pustiš.',
      ),
    ).toBe('<font color="#ffff00">Mogu objasniti.</font>\n<i>Ako me pustiš.</i>');
    // Per-line wrapping, but the translation merged the lines: tag counts cannot match.
    expect(
      repairTags('<i>- Is he gone?</i>\n<i>- For now.</i>', '- Otišao je? - Zasad.'),
    ).toBeNull();
  });

  it('removes tags the model added or duplicated', () => {
    expect(repairTags('Hello there', '<i>Zdravo</i>')).toBe('Zdravo');
    expect(repairTags('<i>Hello</i>', '<i>Zdravo</i></i>')).toBe('<i>Zdravo</i>');
  });

  it('does not guess where inline tags belong', () => {
    expect(repairTags('respond to <i>Pier 14</i>.', 'javite se na Mol 14.')).toBeNull();
    expect(repairTags('<u>Never</u> call again.', 'Nikad više ne zovi.')).toBeNull();
  });

  it('simplifies to plain text, keeping only leading positioning', () => {
    expect(simplifyTags('{\\an8}<u>Never</u> call again.', '<u>Nikad</u> više <i>ne zovi.')).toBe(
      '{\\an8}Nikad više ne zovi.',
    );
    expect(simplifyTags('respond to <i>Pier 14</i>.', 'javite se na Mol 14.')).toBe(
      'javite se na Mol 14.',
    );
  });

  it('compares tags case-, quote- and spacing-insensitively', () => {
    expect(sameTags('<font color="#ffff00">a</font>', "<FONT color='#FFFF00' >b</Font>")).toBe(
      true,
    );
    expect(sameTags('{\\an8}a', '{\\an 8}b')).toBe(true);
  });
});
