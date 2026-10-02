import { useSyncExternalStore } from 'react';

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers and non-secure origins
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

/** Clipboard text, or null when the browser does not allow reading it. */
export async function readClipboardText(): Promise<string | null> {
  try {
    if (!navigator.clipboard?.readText) return null;
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Some browsers read the URL after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function slugify(text: string, fallback = 'city-model'): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || fallback;
}

/** Characters most file systems refuse, and leading or trailing dots and spaces. */
export function cleanFileName(text: string): string {
  return text
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 100);
}

function subscribeMedia(query: string) {
  return (onChange: () => void) => {
    const list = window.matchMedia(query);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  };
}

const subscriptions = new Map<string, (onChange: () => void) => () => void>();

export function useMediaQuery(query: string): boolean {
  let subscribe = subscriptions.get(query);
  if (!subscribe) {
    subscribe = subscribeMedia(query);
    subscriptions.set(query, subscribe);
  }
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}

// Keep these in step with the media queries in the stylesheets.
export const NARROW_QUERY = '(max-width: 1099.98px)';
/** Phones: the area tip moves from the map to the action bar (map.css). */
export const PHONE_QUERY = '(max-width: 900px)';
export const DARK_QUERY = '(prefers-color-scheme: dark)';
export const COARSE_QUERY = '(pointer: coarse)';

export function prefersDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

const apple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

/** Undo and redo as this platform writes them, for tooltips. Both work everywhere. */
export const UNDO_KEYS = apple ? 'Cmd+Z' : 'Ctrl+Z';
export const REDO_KEYS = apple ? 'Cmd+Shift+Z' : 'Ctrl+Y';
