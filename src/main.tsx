import './app/styles/base.css';
import './app/styles/controls.css';
import './app/styles/shell.css';
import './app/styles/panels.css';
import './app/styles/map.css';
import './app/styles/viewer.css';
import './app/styles/editor.css';
import './app/styles/svgmap.css';
import './app/styles/help.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { ErrorBoundary } from './app/components/ErrorBoundary';
import { InstallPrompt } from './app/components/InstallPrompt';
import { UpdateNotice } from './app/components/UpdateNotice';
import { startEditSync } from './app/state/editActions';
import { startSync } from './app/state/sync';
import { loadStoredFont } from './app/svgmap/customFont';
import { setCustomFont, setLabel, useApp } from './app/state/store';
import { CUSTOM_FONT_ID, fontFingerprint } from './core/svgmap/text/fonts';
import { DEFAULT_LABEL } from './core/svgmap/text/label';

startSync();
startEditSync();

void loadStoredFont().then((font) => {
  setCustomFont(font?.name ?? null, font ? fontFingerprint(font.data) : null);
  if (font) return;
  // No stored font (cleared storage or someone else's share link), so fall back.
  const label = useApp.getState().svg.label;
  if (label.font === CUSTOM_FONT_ID) setLabel({ font: DEFAULT_LABEL.font });
  if (label.subtitleFont === CUSTOM_FONT_ID) setLabel({ subtitleFont: '' });
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
    {/* Outside the boundary so a fixed version can still be loaded after a crash. */}
    <div className="notice-toasts">
      <UpdateNotice />
      <InstallPrompt />
    </div>
  </StrictMode>,
);
