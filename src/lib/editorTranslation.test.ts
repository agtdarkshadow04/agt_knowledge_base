import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { editorTranslation } from './editorTranslation.js';

describe('editorTranslation (I18N-3)', () => {
  it('uses the English default and fills in interpolations', () => {
    const translate = editorTranslation();
    assert.equal(translate('toolbar.blockTypes.heading', 'Heading {{level}}', { level: 2 }), 'Heading 2');
    assert.equal(translate('toolbar.bold', 'Bold'), 'Bold');
    assert.equal(translate('x', 'Keep {{missing}}'), 'Keep {{missing}}');
  });

  it('prefers a translated message', () => {
    assert.equal(editorTranslation({ 'toolbar.bold': 'Fett' })('toolbar.bold', 'Bold'), 'Fett');
  });
});
