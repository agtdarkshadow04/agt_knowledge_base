import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError } from './client.js';
import { errorText, fieldErrorText, type ErrorTranslations } from './errors.js';

const translations: ErrorTranslations = {
  errors: { rate_limited: 'Wait {{retryAfterSeconds}} s.', maintenance: 'Maintenance.' },
  fieldErrors: { too_long: '{{field}}: at most {{max}}.', required: '{{field}} is needed.' },
  unexpectedError: 'Unexpected.',
};

describe('translated errors (I18N-6)', () => {
  it('translates an error code and fills its params', () => {
    assert.equal(errorText(new ApiError(429, 'Too many requests.', 'rate_limited', [], { retryAfterSeconds: 30 }), translations), 'Wait 30 s.');
  });

  it('falls back to the server\'s English message only for an unknown code', () => {
    assert.equal(errorText(new ApiError(418, 'I am a teapot.', 'teapot'), translations), 'I am a teapot.');
  });

  it('gives a generic text for anything that is not an API error', () => {
    assert.equal(errorText(new TypeError('x is undefined'), translations), 'Unexpected.');
    assert.equal(errorText('boom', translations), 'Unexpected.');
  });

  it('translates a field error with the translated field label', () => {
    assert.equal(fieldErrorText({ field: 'title', code: 'too_long', message: 'Too long.', params: { max: 180 } }, 'Titel', translations), 'Titel: at most 180.');
    assert.equal(fieldErrorText({ field: 'title', code: 'required', message: 'Required.' }, 'Titre', translations), 'Titre is needed.');
    assert.equal(fieldErrorText({ field: 'title', code: 'brand_new', message: 'English.' }, 'Titre', translations), 'English.');
  });
});
