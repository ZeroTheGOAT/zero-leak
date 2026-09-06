import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import { AppProvider } from './context/AppContext.tsx';
import { initializeAppearance } from './services/appearance.ts';
import './index.css';

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
