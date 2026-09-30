import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyEdits } from '../../core/edit/types';
import { BACKUP_KEY, EDITS_KEY, PICKS_KEY, clearSavedState, readBackup, writeBackup } from './persist';

afterEach(() => vi.unstubAllGlobals());

function storage() {
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
  return stored;
}

const route = { id: 'r', name: 'Home', color: '#E4002B', width: 0.6, lines: [[[-87.63, 41.88], [-87.62, 41.88]]] };

describe('the backup', () => {
  it('reads back only what it can use', () => {
    const stored = storage();
    expect(readBackup()).toBeNull();
    stored.set(BACKUP_KEY, 'nonsense');
    expect(readBackup()).toBeNull();
    stored.set(BACKUP_KEY, JSON.stringify({ savedAt: 1, reason: 'link', edits: { objects: { 'b:1': { heightM: 20, junk: 1 } } } }));
    expect(readBackup()).toEqual({ savedAt: 1, reason: 'link', edits: { ...emptyEdits(), objects: { 'b:1': { heightM: 20 } } } });
    stored.set(BACKUP_KEY, JSON.stringify({ savedAt: 1, reason: 'bogus', edits: { objects: { 'b:1': { heightM: 20 } } } }));
    expect(readBackup()).toBeNull();
    // Nothing in it is no backup.
    stored.set(BACKUP_KEY, JSON.stringify({ savedAt: 1, reason: 'clear', edits: emptyEdits(), picks: { routes: [{ ...route, lines: [] }], hiddenLines: [] } }));
    expect(readBackup()).toBeNull();
  });

  it('is written, and dropped given nothing', () => {
    const stored = storage();
    expect(writeBackup({ savedAt: 2, reason: 'clear-picks', picks: { routes: [route as never], hiddenLines: [] } })).toBe(true);
    expect(readBackup()?.picks?.routes[0].name).toBe('Home');
    expect(writeBackup(null)).toBe(true);
    expect(stored.has(BACKUP_KEY)).toBe(false);
  });

  it('takes the edits and picks the crash screen reset clears', () => {
    const stored = storage();
    stored.set(EDITS_KEY, JSON.stringify({ ...emptyEdits(), objects: { 'b:1': { removed: true } } }));
    stored.set(PICKS_KEY, JSON.stringify({ routes: [route], hiddenLines: [] }));
    clearSavedState();
    expect(stored.has(EDITS_KEY)).toBe(false);
    expect(stored.has(PICKS_KEY)).toBe(false);
    const backup = readBackup()!;
    expect(backup.reason).toBe('reset');
    expect(backup.edits?.objects['b:1']).toEqual({ removed: true });
    expect(backup.picks?.routes[0].name).toBe('Home');
  });

  it("keeps the one it has when a reset has nothing to keep, or can't read it", () => {
    const stored = storage();
    stored.set(BACKUP_KEY, JSON.stringify({ savedAt: 3, reason: 'link', edits: { objects: { 'b:9': { heightM: 9 } } } }));
    stored.set(EDITS_KEY, JSON.stringify(emptyEdits()));
    clearSavedState();
    expect(readBackup()?.reason).toBe('link');
    stored.set(EDITS_KEY, '{broken');
    clearSavedState();
    expect(readBackup()?.edits?.objects['b:9']).toEqual({ heightM: 9 });
    expect(stored.has(EDITS_KEY)).toBe(false);
  });
});
