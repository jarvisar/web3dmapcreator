// Keeps localStorage and the URL hash in step with the store.

import { sameArea } from '../lib/area';
import { saveState } from './persist';
import { formatAreaHash, parseAreaHash } from './shareLink';
import { setArea, useApp } from './store';

let started = false;
let written = '';

export function writeHashNow(): void {
  const hash = formatAreaHash(useApp.getState().area);
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
      state.area !== previous.area ||
      state.settings !== previous.settings ||
      state.palette !== previous.palette ||
      state.exportSettings !== previous.exportSettings ||
      state.placeName !== previous.placeName ||
      state.fileName !== previous.fileName ||
      state.ui.sections !== previous.ui.sections ||
      state.ui.basemap !== previous.ui.basemap ||
      state.ui.showBed !== previous.ui.showBed ||
      state.ui.sizeUnit !== previous.ui.sizeUnit ||
      state.ui.mapHintDismissed !== previous.ui.mapHintDismissed
    ) {
      clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => saveState(useApp.getState(), written), 300);
    }
    if (state.area !== previous.area) {
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
    const area = parseAreaHash(location.hash);
    if (area && !sameArea(area, useApp.getState().area)) setArea(area, { focus: 'always', placeName: '' });
  });

  writeHashNow();
}
