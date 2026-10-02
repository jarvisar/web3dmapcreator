// Undo and redo for the area and settings: everything set up on the map and
// in the sidebar (Setup in store.ts). The model editor's edits keep their own
// history (editActions.ts), and Ctrl+Z goes there while the editor is open,
// unless the focus is in the sidebar or the top bar.
//
// Steps are recorded from the store, so actions don't have to record
// anything. Changes are grouped the way people think of them: everything one
// click or key did, one press of the pointer (a drag, a slider pulled),
// typing in one field, or the same key pressed on one thing in a row.

import { create } from 'zustand';
import type { ModelSettings } from '../../core/settings';
import type { LabelSettings } from '../../core/svgmap/text/label';
import { HISTORY_LIMIT, restoreSetup, SETUP_KEYS, setupOf, toast, useApp, type Setup } from './store';

export interface SetupStep {
  /** The setup undo goes back to, or redo forward to. */
  setup: Setup;
  /** Given by the action, like 'Reset settings'. Otherwise worked out from what changed. */
  label?: string;
}

export const useUndo = create<{ past: SetupStep[]; future: SetupStep[] }>()(() => ({ past: [], future: [] }));

// Presses of the same key on one thing this close together undo as one.
const IDLE_MS = 1000;

interface Open {
  step: SetupStep;
  /** What the last change touched, like 'area' or 'settings.roads'. */
  keys: string;
  at: number;
  /** Opened by typing, so typing on in the field adds to it. */
  typed: boolean;
  /** The redo steps it cleared, given back if it comes to nothing. */
  future: SetupStep[];
}

// The step changes go into, until a new gesture starts one of their own.
let open: Open | null = null;
let applying = false;
let quiet = 0;
let naming: string | null = null;
let sameTask = false;
let typing = false;
// The text field typed in since it was focused. Ctrl+Z there is the field's own.
let typedIn: EventTarget | null = null;
const pointers = new Set<number>();
let started = false;

export function startUndo(): void {
  if (started) return;
  started = true;
  useApp.subscribe(record);
  if (typeof window === 'undefined') return;
  window.addEventListener(
    'pointerdown',
    (event) => {
      pointers.add(event.pointerId);
      close();
    },
    true,
  );
  const release = (event: PointerEvent) => pointers.delete(event.pointerId);
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  // A mouse let go outside the window never sends its pointerup here.
  window.addEventListener(
    'pointermove',
    (event) => {
      if (!event.buttons) pointers.delete(event.pointerId);
    },
    { capture: true, passive: true },
  );
  window.addEventListener('blur', () => pointers.clear());
  window.addEventListener(
    'focusin',
    () => {
      typedIn = null;
      close();
    },
    true,
  );
  window.addEventListener(
    'input',
    (event) => {
      if (!isTextField(event.target)) return;
      typedIn = event.target;
      typing = true;
      // Not a microtask: those run between listeners, before React's onChange.
      setTimeout(() => (typing = false));
    },
    true,
  );
  window.addEventListener('keydown', onKey);
}

function close(): void {
  open = null;
}

function record(state: Setup, previous: Setup): void {
  if (applying || quiet) return;
  const keys = changedKeys(previous, state);
  if (!keys) return;
  const now = performance.now();
  if (!open || !joins(open, keys, now)) {
    const { past, future } = useUndo.getState();
    const step: SetupStep = { setup: setupOf(previous), ...(naming ? { label: naming } : {}) };
    open = { step, keys, at: now, typed: typing, future };
    useUndo.setState({ past: [...past, step].slice(-HISTORY_LIMIT), future: [] });
  }
  open.keys = keys;
  open.at = now;
  if (!sameTask) {
    sameTask = true;
    queueMicrotask(() => (sameTask = false));
  }
  // Taken back, like a drag called off with Esc: nothing to undo, and redo stays.
  if (sameSetup(open.step.setup, state)) {
    const step = open.step;
    useUndo.setState({ past: useUndo.getState().past.filter((item) => item !== step), future: open.future });
    close();
  }
}

function joins(step: Open, keys: string, now: number): boolean {
  if (sameTask || pointers.size) return true;
  if (keys !== step.keys) return false;
  return (typing && step.typed) || now - step.at < IDLE_MS;
}

/** Undoes the last change, or only `only` when it's the last. Returns whether it did. */
export function undoChange(only?: SetupStep): boolean {
  close();
  const { past, future } = useUndo.getState();
  const now = setupOf(useApp.getState());
  const i = lastUndo(past, now);
  const step = past[i];
  if (!step || (only && step !== only)) return false;
  apply(step.setup);
  useUndo.setState({ past: past.slice(0, i), future: [{ setup: now, label: step.label }, ...future] });
  toast(`Undone: ${step.label ?? describeChange(step.setup, now)}`, 'info', undefined, 'undo');
  return true;
}

export function redoChange(): boolean {
  close();
  const { past, future } = useUndo.getState();
  const now = setupOf(useApp.getState());
  const i = firstRedo(future, now);
  const step = future[i];
  if (!step) return false;
  apply(step.setup);
  useUndo.setState({ past: [...past, { setup: now, label: step.label }].slice(-HISTORY_LIMIT), future: future.slice(i + 1) });
  toast(`Redone: ${step.label ?? describeChange(now, step.setup)}`, 'info', undefined, 'undo');
  return true;
}

// Steps that change nothing any more, like picks another tab replaced, are
// passed over by undo, redo and their buttons alike.
function lastUndo(past: SetupStep[], now: Setup): number {
  let i = past.length - 1;
  while (i >= 0 && sameSetup(past[i].setup, now)) i--;
  return i;
}

function firstRedo(future: SetupStep[], now: Setup): number {
  let i = 0;
  while (i < future.length && sameSetup(future[i].setup, now)) i++;
  return i;
}

function apply(setup: Setup): void {
  applying = true;
  try {
    restoreSetup(setup);
  } finally {
    applying = false;
  }
}

/** Runs an action as one step named `label`. Returns the step, or null when nothing changed. */
export function asChange(label: string, run: () => void): SetupStep | null {
  close();
  naming = label;
  try {
    run();
    return openStep();
  } finally {
    naming = null;
    close();
  }
}

function openStep(): SetupStep | null {
  return open?.step ?? null;
}

/**
 * A change the app makes by itself, kept out of the history. With `rebase`
 * it's made in every step too, so undoing something else doesn't take it
 * back.
 */
export function quietly(run: () => void, rebase?: (setup: Setup) => Setup): void {
  quiet++;
  try {
    run();
  } finally {
    quiet--;
  }
  if (!rebase) return;
  close();
  const { past, future } = useUndo.getState();
  const moved = (step: SetupStep): SetupStep => ({ ...step, setup: rebase(step.setup) });
  useUndo.setState({ past: past.map(moved), future: future.map(moved) });
}

/** What undo and redo would do now, for their buttons. Null for nothing. */
export function useUndoLabels(): { undo: string | null; redo: string | null } {
  const { past, future } = useUndo();
  const undo = useApp((state) => undoLabel(past, state));
  const redo = useApp((state) => redoLabel(future, state));
  return { undo, redo };
}

export function undoLabel(past: SetupStep[], now: Setup): string | null {
  const step = past[lastUndo(past, now)];
  return step ? (step.label ?? describeChange(step.setup, now)) : null;
}

export function redoLabel(future: SetupStep[], now: Setup): string | null {
  const step = future[firstRedo(future, now)];
  return step ? (step.label ?? describeChange(now, step.setup)) : null;
}

/** Whether Ctrl+Z is the model editor's: while it's open, unless the focus is in the sidebar or on these buttons. */
export function editorTakesUndo(): boolean {
  const { ui, output } = useApp.getState();
  if (!ui.editMode || ui.view !== 'result' || output !== 'model') return false;
  const focus = typeof document === 'undefined' ? null : document.activeElement;
  return !focus?.closest?.('#sidebar, .topbar-history');
}

function onKey(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.altKey || !(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  if (key !== 'z' && key !== 'y') return;
  if ((event.target === typedIn && isTextField(event.target)) || document.querySelector('dialog[open]') || editorTakesUndo()) return;
  event.preventDefault();
  // Mid-drag the drag would carry on from where it started.
  if (pointers.size) return;
  if (key === 'z' && !event.shiftKey) undoChange();
  else redoChange();
}

const TEXT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);

function isTextField(target: EventTarget | null): boolean {
  const element = target as HTMLInputElement | null;
  if (!element?.tagName) return false;
  return element.isContentEditable || element.tagName === 'TEXTAREA' || (element.tagName === 'INPUT' && TEXT_TYPES.has(element.type));
}

// ------------------------------------------------------------ comparing

function changedKeys(before: Setup, after: Setup): string {
  const keys: string[] = [];
  for (const key of SETUP_KEYS) {
    const a = before[key];
    const b = after[key];
    if (a === b) continue;
    if (key === 'settings' || key === 'svg') {
      const x = a as Record<string, unknown>;
      const y = b as Record<string, unknown>;
      for (const inner of Object.keys(y)) if (x[inner] !== y[inner]) keys.push(`${key}.${inner}`);
    } else keys.push(key);
  }
  return keys.join(' ');
}

function sameSetup(a: Setup, b: Setup): boolean {
  return SETUP_KEYS.every((key) => same(a[key], b[key]));
}

// Setups share everything a change didn't touch, so this only walks what did.
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

// ------------------------------------------------------------ naming

const SETTINGS: Partial<Record<keyof ModelSettings, string>> = {
  modelSource: 'Change model source',
  terrain: 'Change terrain settings',
  water: 'Change water settings',
  land: 'Change land settings',
  roads: 'Change road settings',
  bridges: 'Change bridge settings',
  buildings: 'Change building settings',
  trees: 'Change tree settings',
  lidar: 'Change LiDAR settings',
  lidarModel: 'Change LiDAR only settings',
  supports: 'Change supports',
  rim: 'Change rim settings',
  tracks: 'Change route settings',
};

const TITLE_SIZE: (keyof LabelSettings)[] = ['size', 'boxWidth', 'boxHeight', 'bandHeight'];
const TITLE_PLACE: (keyof LabelSettings)[] = ['offsetX', 'offsetY', 'bandOffsetX', 'bandOffsetY', 'position', 'bandPosition'];

/** A step's name, from what it changed: 'Move area', 'Resize title'. */
export function describeChange(from: Setup, to: Setup): string {
  if (from.output !== to.output) return to.output === 'svg' ? 'Switch to SVG map' : 'Switch to 3D model';
  if (from.placeName !== to.placeName && to.placeName) return `Go to ${to.placeName}`;
  const a = from.svg;
  const b = to.svg;
  // A piece reshapes the area, so it goes first.
  if (a.product !== b.product || a.productPreset !== b.productPreset || a.border !== b.border) return 'Change piece';
  if (from.area !== to.area) {
    const x = from.area;
    const y = to.area;
    if (x.shape !== y.shape) return 'Change area shape';
    if (x.widthM !== y.widthM || x.heightM !== y.heightM) return 'Resize area';
    if (x.rotationDeg !== y.rotationDeg) return 'Rotate area';
    if (x.center[0] !== y.center[0] || x.center[1] !== y.center[1]) return 'Move area';
    if (x.cornerRadius !== y.cornerRadius) return 'Change corner radius';
  }
  if (a.label !== b.label) {
    const changed = (fields: (keyof LabelSettings)[]) => fields.some((field) => a.label[field] !== b.label[field]);
    if (changed(['text', 'subtitle'])) return 'Edit title';
    if (changed(TITLE_SIZE)) return 'Resize title';
    if (changed(TITLE_PLACE)) return 'Move title';
    return 'Change title';
  }
  if (a.routes !== b.routes || a.hiddenLines !== b.hiddenLines) return 'Change picked roads';
  if (from.tracks !== to.tracks) {
    if (to.tracks.length > from.tracks.length) return to.tracks.length - from.tracks.length === 1 ? 'Add route' : 'Add routes';
    if (to.tracks.length < from.tracks.length) return 'Remove route';
    return 'Change routes';
  }
  if (a.scaleLocked !== b.scaleLocked || from.settings.scale.mode !== to.settings.scale.mode) return 'Change scale lock';
  if (a.scale !== b.scale || from.settings.scale !== to.settings.scale) return 'Change scale';
  for (const key of Object.keys(to.settings) as (keyof ModelSettings)[]) {
    if (from.settings[key] !== to.settings[key]) return SETTINGS[key] ?? 'Change model settings';
  }
  if (a !== b) return 'Change SVG map settings';
  if (from.palette !== to.palette) return 'Change colours';
  if (from.exportSettings !== to.exportSettings) return 'Change export settings';
  if (from.fileName !== to.fileName) return 'Change file name';
  return 'Change settings';
}
