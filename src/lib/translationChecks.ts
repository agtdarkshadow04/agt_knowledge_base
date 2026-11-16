import { LOCALES } from '../translations.js';

/**
 * The completeness checks the translation tests run on a family of string
 * tables (I18N-2, I18N-3): every English key in every locale, non-empty, with
 * the same placeholders, and translated rather than copied.
 */

/** Every leaf string of a string table, keyed by its dotted path. */
export function leaves(table: object, prefix = ''): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(table)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') result.set(path, value);
    else for (const [inner, text] of leaves(value as object, path)) result.set(inner, text);
  }
  return result;
}

const placeholders = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]).sort();

/**
 * Strings that may read the same in another language: single words (cognates
 * such as "Article", "Image" or "Version" are shared by many languages), and
 * names, codes and formats. A longer string identical to English is an
 * untranslated copy, which I18N-3 forbids.
 */
const sameEverywhere = /^(?:[^A-Za-z]*|JSON Lines|SLT Restricted|SCC Restricted|Version \{\{version\}\}|Article · version \{\{version\}\})$/;

function words(text: string) {
  return text.replace(/\{\{\s*\w+\s*\}\}/g, ' ').split(/[^\p{L}]+/u).filter(Boolean).length;
}

/** Checks one family of string tables: complete, non-empty, translated, same placeholders (I18N-2, I18N-3). */
export function tableProblems(tables: Record<string, object>, english: object, allowedSame: RegExp = sameEverywhere): string[] {
  const problems: string[] = [];
  const reference = leaves(english);
  for (const { value: locale } of LOCALES) {
    const table = leaves(tables[locale]);
    for (const [path, text] of reference) {
      const translated = table.get(path);
      if (translated === undefined) { problems.push(`${locale}: ${path} is missing`); continue; }
      if (!translated.trim()) problems.push(`${locale}: ${path} is empty`);
      if (placeholders(translated).join() !== placeholders(text).join()) problems.push(`${locale}: ${path} has other placeholders than English`);
      if (locale !== 'en' && translated === text && words(text) > 1 && !allowedSame.test(text)) problems.push(`${locale}: ${path} is an untranslated English copy ("${text}")`);
    }
    for (const path of table.keys()) if (!reference.has(path)) problems.push(`${locale}: ${path} is not an English key`);
  }
  return problems;
}

