export function handlePreloadError(event: Event, reload = () => window.location.reload()) {
  event.preventDefault();
  reload();
}

