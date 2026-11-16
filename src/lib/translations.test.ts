import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { errorCodes } from '../../server/schemas.js';
import { FIELD_CODES } from './errors.js';
import { formatTranslation, getTranslations, LOCALES, TRANSLATIONS, type Translations } from '../translations.js';
import { tableProblems } from './translationChecks.js';

describe('public translations (I18N-1..I18N-3, I18N-6)', () => {
  it('lists the AGT locales in the spec\'s order, with pt-BR for Portuguese', () => {
    assert.deepEqual(LOCALES.map((locale) => locale.value), ['en', 'fr', 'de', 'es', 'pt', 'it', 'th', 'zh', 'hi', 'ja']);
    assert.equal(LOCALES.find((locale) => locale.value === 'pt')!.tag, 'pt-BR');
  });

  it('has every English key, non-empty and translated, in every locale', () => {
    assert.deepEqual(tableProblems(TRANSLATIONS, TRANSLATIONS.en), []);
  });

  it('has a string for every error code the server sends and every field code (I18N-6)', () => {
    for (const { value } of LOCALES) {
      const t: Translations = TRANSLATIONS[value];
      for (const code of [...errorCodes, 'network_error']) assert.ok(t.errors[code as keyof Translations['errors']], `${value}: errors.${code}`);
      for (const code of FIELD_CODES) assert.ok(t.fieldErrors[code], `${value}: fieldErrors.${code}`);
    }
  });

  it('falls back to English for an unknown locale, and fills placeholders', () => {
    assert.equal(getTranslations('xx'), TRANSLATIONS.en);
    assert.equal(getTranslations(undefined), TRANSLATIONS.en);
    assert.equal(formatTranslation('{{a}} and {{ b }}, not {{c}}', { a: 1, b: 'two' }), '1 and two, not {{c}}');
  });
});

describe('no hard-coded text in components (I18N-3)', () => {
  const files = ['src/App.tsx', ...['src/components', 'src/admin', 'src/admin/api-docs'].flatMap((directory) => (
    readdirSync(directory).filter((name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx')).map((name) => join(directory, name))
  ))];

  it('finds the component files', () => {
    assert.ok(files.length > 30);
  });

  for (const file of files) {
    it(`${file} reads its text from the string tables`, () => {
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      // Text between tags, e.g. `>Save<` or `/> Download backup</`.
      const text = [...source.matchAll(/>\s*([A-Za-z][A-Za-z ,.'’!?:()-]{2,})\s*</g)].map((match) => match[1]);
      // Literal text in attributes people read or hear.
      const attributes = [...source.matchAll(/\b(aria-label|title|placeholder|alt|label|description|confirmLabel|cancelLabel|closeLabel|message|help)="([^"]*[A-Za-z]{2,}[^"]*)"/g)]
        .map((match) => `${match[1]}="${match[2]}"`);
      assert.deepEqual([...text, ...attributes], [], `${file} has hard-coded text`);
    });
  }
});
