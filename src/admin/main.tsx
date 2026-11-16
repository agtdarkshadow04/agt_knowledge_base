import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import './admin.css';
import { I18nProvider } from '../components/I18n';
import { AdminApp } from './AdminApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider><AdminApp /></I18nProvider>
  </StrictMode>,
);
