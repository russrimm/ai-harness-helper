import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initAuthToken } from './api/client.js';
import { App } from './App.js';
import './styles.css';

// Must run before anything renders: it reads the one-time token out of the
// URL and strips it, so it never lingers in the visible address bar.
initAuthToken();

const container = document.getElementById('root');
if (!container) throw new Error('Root element not found');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
