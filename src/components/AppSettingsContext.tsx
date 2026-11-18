import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getApplicationSettings } from '../lib/memberApi';
import type { ApplicationSettings } from '../lib/api';
import { COMMON_TRANSLATIONS } from '../translations';
import { useI18n } from './I18n';

const defaults: ApplicationSettings = {
  site: {
    // The site's own text comes from the server (site.title, site.subtitle); until it arrives, the product name.
    title: COMMON_TRANSLATIONS.product,
    subtitle: '',
    supportUrl: 'https://www.nms-agt.com/support',
  },
  articles: { defaultVisibility: 'Internal' },
  access: { allowPublicBrowsing: true },
  iam: { signIn: false },
};

interface AppSettingsContextValue {
  settings: ApplicationSettings;
  loading: boolean;
  error: string;
  refresh(): Promise<void>;
  setSettings(settings: ApplicationSettings): void;
}

const AppSettingsContext = createContext<AppSettingsContextValue>({
  settings: defaults,
  loading: false,
  error: '',
  refresh: async () => undefined,
  setSettings: () => undefined,
});

export function AppSettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState(defaults);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { error: describe } = useI18n();
  const errorRef = useRef(describe);
  errorRef.current = describe;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setSettings(await getApplicationSettings());
    } catch (cause) {
      setError(errorRef.current(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const value = useMemo(() => ({ settings, loading, error, refresh, setSettings }), [error, loading, refresh, settings]);
  return <AppSettingsContext.Provider value={value}>{children}</AppSettingsContext.Provider>;
}

export function useAppSettings() {
  return useContext(AppSettingsContext);
}
