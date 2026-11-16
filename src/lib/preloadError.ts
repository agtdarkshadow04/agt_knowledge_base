/** Reloads the app when a lazily loaded chunk is gone after a deploy (Vite's `vite:preloadError`). */
export function handlePreloadError(
  event: Event,
  reload = () => { (globalThis as unknown as { location: { reload(): void } }).location.reload(); },
) {
  event.preventDefault();
  reload();
}
