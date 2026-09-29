// A title font the user loaded, kept in IndexedDB so it survives a reload.
import type { CustomFont } from '../../core/svgmap/text/loadFont';

const DB_NAME = 'svg-map-fonts';
const STORE = 'files';
const KEY = 'custom-font';

let current: CustomFont | null = null;
let db: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error: unknown) => {
    db = null;
    throw error;
  });
  return db;
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const connection = await open();
  return new Promise((resolve, reject) => {
    const request = run(connection.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function getCustomFont(): CustomFont | null {
  return current;
}

export async function loadStoredFont(): Promise<CustomFont | null> {
  try {
    current = (await withStore<CustomFont | undefined>('readonly', (s) => s.get(KEY))) ?? null;
  } catch {
    current = null;
  }
  return current;
}

export async function storeFont(font: CustomFont | null): Promise<void> {
  current = font;
  try {
    await withStore<unknown>('readwrite', (s) => (font ? s.put(font, KEY) : s.delete(KEY)) as IDBRequest<unknown>);
  } catch {
    // Private windows can refuse storage. The font still works until reload.
  }
}

// Reads the file the same way a render will, so a bad file is caught here
// instead of failing every render. Returns what's wrong, or null.
export async function checkFont(data: ArrayBuffer): Promise<string | null> {
  const signature = String.fromCharCode(...new Uint8Array(data, 0, Math.min(4, data.byteLength)));
  if (signature === 'wOF2') return "WOFF2 fonts can't be read. Use a TTF, OTF or WOFF file.";
  try {
    const { parseOutlineFont } = await import('../../core/svgmap/text/loadFont');
    parseOutlineFont(data);
    return null;
  } catch {
    return "This file couldn't be read as a font.";
  }
}
