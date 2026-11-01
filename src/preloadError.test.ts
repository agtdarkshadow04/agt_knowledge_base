import { describe, expect, it, vi } from 'vitest';
import { handlePreloadError } from './preloadError';

describe('handlePreloadError', () => {
  it('suppresses the import error and reloads the current application', () => {
    const event = new Event('vite:preloadError', { cancelable: true });
    const reload = vi.fn();

    handlePreloadError(event, reload);

    expect(event.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });
});

