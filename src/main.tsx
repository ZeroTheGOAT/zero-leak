import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import { AppProvider } from './context/AppContext.tsx';
import { initializeAppearance } from './services/appearance.ts';
import { migrateLegacyPreferenceKeys } from './services/prefs-migration.ts';
import './index.css';

// Before anything reads a `zeroleak.*` preference: carry the pre-rebrand
// `servergen.*` values across (or drop the retired ones) exactly once.
migrateLegacyPreferenceKeys();
initializeAppearance();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Missing #root element — index.html was not served.');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </React.StrictMode>,
);
