import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AuthProvider } from './auth/AuthContext';
import './config';
import { handlePreloadError } from './preloadError';
import './styles.css';

window.addEventListener('vite:preloadError', handlePreloadError);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider><App /></AuthProvider>
  </StrictMode>,
);

