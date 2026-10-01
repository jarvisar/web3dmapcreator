// Keeps localStorage and the URL hash in step with the store, and this tab
// in step with others saving the same edits and picks.

import { sameArea } from '../lib/area';
import {
  BACKUP_KEY,
  EDITS_KEY,
  isSaved,
  markSaved,
  PICKS_KEY,
  readBackup,
  readStoredEdits,
  readStoredPicks,
  saveState,
} from './persist';
import { formatAreaHash, parseHash } from './shareLink';
import { adoptEdits, broughtToast, takeInLink } from './editActions';
import { bringIn, patchSvg, setArea, setOutput, takeOpenedLink, toast, useApp } from './store';

let started = false;
let written = '';
let warned = false;

function save(): void {
  if (saveState(useApp.getState(), written)) {
    warned = false;
  } else if (!warned) {
    warned = true;
    toast("This browser didn't save your latest changes. Its storage may be full or turned off. Export options to keep them.", 'error');
  }
}

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
      state.edits !== previous.edits ||
      state.svg !== previous.svg ||
      state.placeName !== previous.placeName ||
      state.fileName !== previous.fileName ||
      state.ui.sections !== previous.ui.sections ||
      state.ui.basemap !== previous.ui.basemap ||
      state.ui.showBed !== previous.ui.showBed ||
      state.ui.sizeUnit !== previous.ui.sizeUnit ||
      state.ui.mapHintDismissed !== previous.ui.mapHintDismissed ||
      state.ui.previewLook !== previous.ui.previewLook ||
      state.ui.largeGrids !== previous.ui.largeGrids
    ) {
      clearTimeout(saveTimer);
      saveTimer = window.setTimeout(save, 300);
    }
    if (state.area !== previous.area || state.output !== previous.output) {
      clearTimeout(hashTimer);
      hashTimer = window.setTimeout(() => {
        writeHashNow();
        // The saved copy has to know this hash, or a reload reads it as a share link.
        save();
      }, 400);
    }
  });

  // The URL keeps whatever hash was written last, even if a newer one was
  // still waiting, so save that one to recognise it after a reload.
  const flush = () => {
    clearTimeout(saveTimer);
    save();
  };
  window.addEventListener('pagehide', flush);
  // Phones can discard a background tab without a pagehide.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });

  // A link pasted into the address bar of an open tab. Its SVG settings
  // carry no picks, so the ones here stay, and its edits and picks are
  // added to these.
  window.addEventListener('hashchange', () => {
    const shared = parseHash(location.hash);
    const state = useApp.getState();
    if (shared.svg) useApp.setState({ svg: { ...shared.svg.svg, routes: state.svg.routes, hiddenLines: state.svg.hiddenLines } });
    const brought = bringIn(state.edits, { routes: state.svg.routes, hiddenLines: state.svg.hiddenLines }, { edits: shared.edits, picks: shared.picks });
    if (brought) takeInLink(brought);
    if (shared.output) setOutput(shared.output);
    const area = shared.area ?? useApp.getState().area;
    const next = { ...area, ...shared.svg?.area, ...(shared.svg?.shape ? { shape: shared.svg.shape } : {}) };
    // New SVG settings can mean a new piece, and so a new map window.
    if (shared.svg || !sameArea(next, useApp.getState().area)) setArea(next, { focus: 'always', placeName: '' });
    // Drop the settings from the address bar once they're in.
    if (shared.svg || shared.edits || shared.picks) writeHashNow();
  });

  // Another tab saved its edits or picks. They're taken on here unless this
  // tab has a change of its own still to save, which then wins.
  window.addEventListener('storage', (event) => {
    if (event.storageArea !== localStorage) return;
    if (event.key === BACKUP_KEY) {
      useApp.setState({ backup: readBackup() });
      return;
    }
    if (event.newValue === null) return;
    const state = useApp.getState();
    if (event.key === EDITS_KEY) {
      if (!isSaved(EDITS_KEY, [state.edits])) return;
      const edits = readStoredEdits(event.newValue);
      if (!edits) return;
      markSaved(EDITS_KEY, [edits]);
      adoptEdits(edits);
    } else if (event.key === PICKS_KEY) {
      if (!isSaved(PICKS_KEY, [state.svg.routes, state.svg.hiddenLines])) return;
      const picks = readStoredPicks(event.newValue);
      if (!picks) return;
      markSaved(PICKS_KEY, [picks.routes, picks.hiddenLines]);
      patchSvg({ routes: picks.routes, hiddenLines: picks.hiddenLines });
    }
  });

  writeHashNow();
  const opened = takeOpenedLink();
  if (opened) {
    broughtToast(opened);
    // Saved now, not with the next change, so it's there after a reload.
    save();
  }
}
