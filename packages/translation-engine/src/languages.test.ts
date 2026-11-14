import { describe, expect, it } from 'vitest';
import {
  findLanguage,
  getProfile,
  LANGUAGES,
  listProfiles,
  resolveSourceLanguage,
  resolveTargetLanguage,
  sourceLanguages,
  targetLanguages,
  UnsupportedLanguageError,
} from './index.js';

describe('language registry', () => {
  it('has unique identifiers', () => {
    const ids = LANGUAGES.map((l) => l.id.toLowerCase());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('offers Serbian Latin and Serbian Cyrillic as two separate targets', () => {
    const latin = resolveTargetLanguage('sr-Latn');
    const cyrillic = resolveTargetLanguage('sr-Cyrl');
    expect(latin).toMatchObject({ language: 'sr', script: 'Latn', name: 'Serbian (Latin)' });
    expect(cyrillic).toMatchObject({ language: 'sr', script: 'Cyrl', name: 'Serbian (Cyrillic)' });
    expect(latin.targetNote).toMatch(/LATIN/);
    expect(latin.targetNote).toMatch(/Never use Cyrillic/);
    expect(cyrillic.targetNote).toMatch(/CYRILLIC/);
  });

  it('refuses bare "sr": the script must always be explicit', () => {
    expect(() => resolveTargetLanguage('sr')).toThrow(/explicit script/);
    expect(findLanguage('sr')).toBeUndefined();
  });

  it('includes the required targets', () => {
    const ids = targetLanguages().map((l) => l.id);
    for (const id of ['sr-Latn', 'sr-Cyrl', 'hr', 'en', 'de', 'fr', 'es', 'it', 'ru']) {
      expect(ids).toContain(id);
    }
  });

  it('never offers Bosnian or Montenegrin as a target', () => {
    const targets = targetLanguages();
    expect(targets.some((l) => l.language === 'bs' || l.language === 'cnr')).toBe(false);
    expect(targets.some((l) => /bosnian|montenegrin/i.test(l.name))).toBe(false);
    expect(() => resolveTargetLanguage('bs')).toThrow(UnsupportedLanguageError);
    expect(() => resolveTargetLanguage('cnr')).toThrow(/not available as a target/);
  });

  it('still accepts Bosnian and Montenegrin as source languages', () => {
    expect(resolveSourceLanguage('bs')?.name).toBe('Bosnian');
    expect(resolveSourceLanguage('cnr')?.name).toBe('Montenegrin');
    expect(sourceLanguages().length).toBe(LANGUAGES.length);
  });

  it('resolves ids case-insensitively and rejects unknown ones', () => {
    expect(resolveTargetLanguage('SR-latn').id).toBe('sr-Latn');
    expect(resolveTargetLanguage(' pt-br ').id).toBe('pt-BR');
    expect(() => resolveTargetLanguage('xx')).toThrow(UnsupportedLanguageError);
    expect(() => resolveSourceLanguage('xx')).toThrow(UnsupportedLanguageError);
  });

  it('treats auto / empty / undefined source as "detect"', () => {
    expect(resolveSourceLanguage(undefined)).toBeUndefined();
    expect(resolveSourceLanguage('auto')).toBeUndefined();
    expect(resolveSourceLanguage('')).toBeUndefined();
    expect(resolveSourceLanguage('en')?.id).toBe('en');
  });

  it('knows the usual legacy code page per language', () => {
    expect(findLanguage('hr')?.legacyEncoding).toBe('windows-1250');
    expect(findLanguage('sr-Cyrl')?.legacyEncoding).toBe('windows-1251');
    for (const l of LANGUAGES) expect(() => new TextDecoder(l.legacyEncoding)).not.toThrow();
  });
});

describe('translation profiles', () => {
  it('provides natural, literal, cinematic, concise and custom', () => {
    expect(listProfiles().map((p) => p.id)).toEqual([
      'natural',
      'literal',
      'cinematic',
      'concise',
      'custom',
    ]);
    expect(getProfile('concise').instruction).toMatch(/shortest/i);
    expect(getProfile('custom').instruction).toBe('');
  });
});
