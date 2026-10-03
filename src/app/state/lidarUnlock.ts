// The LiDAR options are hidden until the Konami code is entered or the logo
// in the top bar is clicked six times quickly. Remembered in this browser.

import type { MouseEvent } from 'react';
import { create } from 'zustand';
import { toast, useApp } from './store';

const KEY = 'jarvizar-city-model:lidar-unlocked';
const KONAMI = ['arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a'];
const CLICKS = 6;
const CLICK_GAP_MS = 400;

function wasUnlocked() {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

const useUnlocked = create<boolean>()(wasUnlocked);

function unlockLidar() {
  if (useUnlocked.getState()) return;
  try {
    localStorage.setItem(KEY, String(Date.now()));
  } catch {
    // Private mode. Unlocked for this visit only.
  }
  useUnlocked.setState(true, true);
  toast('LiDAR options unlocked under Layers', 'info');
}

/** Also shown while the settings use LiDAR (a saved state or a share link), so it can be turned off. */
export function useLidarShown(): boolean {
  const unlocked = useUnlocked();
  const inUse = useApp((state) => state.settings.modelSource === 'lidar' || state.settings.lidar.enabled);
  return unlocked || inUse;
}

let typed: string[] = [];
window.addEventListener(
  'keydown',
  (event) => {
    if (event.repeat) return;
    typed = [...typed, event.key.toLowerCase()].slice(-KONAMI.length);
    if (typed.join() === KONAMI.join()) unlockLidar();
  },
  { capture: true },
);

let clicks = 0;
let pending = 0;

// A plain click waits a moment before following the link, so a run of clicks
// doesn't reload the page. Modified and keyboard clicks follow it as usual.
export function countUnlockClick(event: MouseEvent<HTMLAnchorElement>): void {
  if (useUnlocked.getState() || event.button !== 0 || event.detail === 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  const href = event.currentTarget.href;
  clearTimeout(pending);
  if (++clicks >= CLICKS) {
    clicks = 0;
    unlockLidar();
    return;
  }
  pending = window.setTimeout(() => {
    clicks = 0;
    location.assign(href);
  }, CLICK_GAP_MS);
}
