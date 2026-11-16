import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nProvider } from '../components/I18n';
import { NavigationProvider, useNavigation } from '../components/Navigation';

/** Renders `ui` with the preferences and navigation contexts, starting at `url` (FE-4 deep links on /). */
export function renderAt(url: string, ui: ReactElement) {
  window.history.replaceState(null, '', url);
  return render(<I18nProvider><NavigationProvider>{ui}</NavigationProvider></I18nProvider>);
}

/** The address the app is showing. */
export function currentUrl() {
  return `${window.location.pathname}${window.location.search}`;
}

/** Shows the current page's name, for tests that follow a navigation. */
export function RouteProbe() {
  const { route } = useNavigation();
  return <output data-testid="route">{route.page}</output>;
}
