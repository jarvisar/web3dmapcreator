// Keeps localStorage and the URL hash in step with the store.

import { sameArea } from '../lib/area';
import { saveState } from './persist';
import { formatAreaHash, parseHash } from './shareLink';
import { setArea, setOutput, useApp } from './store';

let started = false;
let written = '';

export function writeHashNow(): void {
  const state = useApp.getState();
  const hash = formatAreaHash(state.area, state.output);
  if (location.hash !== hash) history.replaceState(history.state, '', hash);
  written = hash;
}

export function startSync(): void {
  if (started) return;
  started = true;

  let saveTimer = 0;
  let hashTimer = 0;

  useApp.subscribe((state, previous) => {
    if (
      state.output !== previous.output ||
      state.area !== previous.area ||
      state.settings !== previous.settings ||
      state.palette !== previous.palette ||
      state.exportSettings !== previous.exportSettings ||
      state.svg !== previous.svg ||
      state.placeName !== previous.placeName ||
      state.fileName !== previous.fileName ||
      state.ui.sections !== previous.ui.sections ||
      state.ui.basemap !== previous.ui.basemap ||
      state.ui.showBed !== previous.ui.showBed ||
      state.ui.sizeUnit !== previous.ui.sizeUnit ||
      state.ui.mapHintDismissed !== previous.ui.mapHintDismissed ||
      state.ui.previewLook !== previous.ui.previewLook
    ) {
      clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => saveState(useApp.getState(), written), 300);
    }
    if (state.area !== previous.area || state.output !== previous.output) {
      clearTimeout(hashTimer);
      hashTimer = window.setTimeout(() => {
        writeHashNow();
        // The saved copy has to know this hash, or a reload reads it as a share link.
        saveState(useApp.getState(), written);
      }, 400);
    }
  });

  // The URL keeps whatever hash was written last, even if a newer one was
  // still waiting, so save that one to recognise it after a reload.
  const flush = () => {
    clearTimeout(saveTimer);
    saveState(useApp.getState(), written);
  };
  window.addEventListener('pagehide', flush);
  // Phones can discard a background tab without a pagehide.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });

  // A link pasted into the address bar of an open tab.
  window.addEventListener('hashchange', () => {
    const shared = parseHash(location.hash);
    if (shared.svg) useApp.setState({ svg: shared.svg.svg });
    if (shared.output) setOutput(shared.output);
    const area = shared.area ?? useApp.getState().area;
    const next = { ...area, ...shared.svg?.area, ...(shared.svg?.shape ? { shape: shared.svg.shape } : {}) };
    // New SVG settings can mean a new piece, and so a new map window.
    if (shared.svg || !sameArea(next, useApp.getState().area)) setArea(next, { focus: 'always', placeName: '' });
    // Drop the settings from the address bar once they're in.
    if (shared.svg) writeHashNow();
  });

  writeHashNow();
}
