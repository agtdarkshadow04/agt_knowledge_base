import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppSettingsProvider } from './components/AppSettingsContext';
import { AuthProvider } from './components/AuthContext';
import { NavigationProvider } from './components/Navigation';
import { handlePreloadError } from './lib/preloadError';
import './styles.css';

window.addEventListener('vite:preloadError', handlePreloadError);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <NavigationProvider>
      <AppSettingsProvider><AuthProvider><App /></AuthProvider></AppSettingsProvider>
    </NavigationProvider>
  </StrictMode>,
);
