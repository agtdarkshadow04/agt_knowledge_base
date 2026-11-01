import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getApplicationSettings } from '../services/api';
import type { ApplicationSettings } from '../types';

const defaults: ApplicationSettings = {
  applicationName: 'AGT Knowledge Base',
  applicationSubtitle: 'Field-tested guides, community procedures, and traveller intelligence.',
  defaultVisibility: 'Internal',
  allowPublicBrowsing: true,
  version: 1,
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

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setSettings(await getApplicationSettings());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Application settings could not be loaded.');
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
