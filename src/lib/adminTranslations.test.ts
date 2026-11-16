import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { archiveRejectionReasons, restoreWarnings } from '../../server/backupCodes.js';
import { ADMINTRANSLATIONS, getAdminTranslations } from '../admin/i18n.js';
import { LOCALES } from '../translations.js';
import { tableProblems } from './translationChecks.js';

describe('admin translations (I18N-2, I18N-3, I18N-6)', () => {
  it('has every English key, non-empty and translated, in every locale', () => {
    assert.deepEqual(tableProblems(ADMINTRANSLATIONS, ADMINTRANSLATIONS.en), []);
  });

  it('translates every archive rejection reason and restore warning the server sends', () => {
    for (const { value } of LOCALES) {
      const a = ADMINTRANSLATIONS[value];
      for (const reason of archiveRejectionReasons) assert.ok(a.backup.reasons[reason], `${value}: backup.reasons.${reason}`);
      for (const code of Object.keys(restoreWarnings)) assert.ok(a.backup.warnings[code as keyof typeof a.backup.warnings], `${value}: backup.warnings.${code}`);
    }
  });

  it('falls back to English for an unknown locale', () => {
    assert.equal(getAdminTranslations('xx'), ADMINTRANSLATIONS.en);
  });
});
