import './app/styles/base.css';
import './app/styles/controls.css';
import './app/styles/shell.css';
import './app/styles/panels.css';
import './app/styles/map.css';
import './app/styles/viewer.css';
import './app/styles/help.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { startSync } from './app/state/sync';

startSync();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
