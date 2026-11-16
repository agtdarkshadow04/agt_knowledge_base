import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { handlePreloadError } from './preloadError.js';

describe('handlePreloadError', () => {
  it('suppresses the import error and reloads the current application', () => {
    const event = new Event('vite:preloadError', { cancelable: true });
    const reload = mock.fn();

    handlePreloadError(event, reload);

    assert.equal(event.defaultPrevented, true);
    assert.equal(reload.mock.callCount(), 1);
  });
});
