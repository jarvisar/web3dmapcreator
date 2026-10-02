import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SvgRoute } from '../../core/svgmap/routes';
import { patchSettings, patchSvg, resetAllSettings, setArea, setLabel, setOutput, useApp } from './store';
import { asChange, describeChange, quietly, redoChange, startUndo, undoChange, useUndo } from './undo';

// Tests run without a DOM, so the listeners go on a bare EventTarget.
const target = new EventTarget();
const doc = { activeElement: null as unknown, querySelector: () => null };
let clock = 0;

function fire(type: string, props: Record<string, unknown> = {}, from?: unknown): Event {
  const event = Object.assign(new Event(type, { cancelable: true }), props);
  if (from) Object.defineProperty(event, 'target', { value: from });
  target.dispatchEvent(event);
  return event;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const press = () => fire('pointerdown', { pointerId: 1 });
const release = () => fire('pointerup', { pointerId: 1 });
const key = (k: string, more: Record<string, unknown> = {}, from?: unknown) =>
  fire('keydown', { key: k, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...more }, from);
const nudge = (dx: number) => setArea((area) => ({ ...area, center: [area.center[0] + dx, area.center[1]] }));
const steps = () => useUndo.getState().past.length;
const route = (id: string): SvgRoute => ({ id, name: id, color: '#E4002B', width: 0.6, lines: [[[0, 0], [1, 1]]] });

let initial: ReturnType<typeof useApp.getState>;

beforeAll(() => {
  vi.stubGlobal('window', target);
  vi.stubGlobal('document', doc);
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  initial = useApp.getState();
  startUndo();
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  quietly(() => useApp.setState(initial, true));
  useUndo.setState({ past: [], future: [] });
  doc.activeElement = null;
  fire('focusin');
  clock += 10_000;
  await tick();
});

describe('undo for the area and settings', () => {
  it('takes a drag back as one step, and redo puts it back', async () => {
    const start = useApp.getState().area;
    press();
    for (let i = 0; i < 4; i++) {
      nudge(0.001);
      clock += 2000;
      await tick();
    }
    release();
    const end = useApp.getState().area;
    expect(steps()).toBe(1);
    expect(undoChange()).toBe(true);
    expect(useApp.getState().area).toEqual(start);
    expect(redoChange()).toBe(true);
    expect(useApp.getState().area).toEqual(end);
  });

  it('keeps separate clicks apart, and one handler together', async () => {
    press();
    release();
    patchSettings('roads', { includeRail: false });
    await tick();
    press();
    release();
    patchSettings('roads', { includePaths: false });
    await tick();
    expect(steps()).toBe(2);
    // Like setPrintedSide: the area and the scale in one go.
    nudge(0.002);
    patchSettings('scale', { fitMm: 150 });
    await tick();
    expect(steps()).toBe(3);
    undoChange();
    expect(useApp.getState().settings.scale).toEqual(initial.settings.scale);
    expect(useApp.getState().area).toEqual(initial.area);
  });

  it('joins presses of one key in a row until a pause or another key', async () => {
    nudge(0.001);
    await tick();
    clock += 500;
    nudge(0.001);
    await tick();
    expect(steps()).toBe(1);
    clock += 1500;
    nudge(0.001);
    await tick();
    expect(steps()).toBe(2);
    clock += 100;
    patchSettings('trees', { spacingM: 9 });
    await tick();
    expect(steps()).toBe(3);
  });

  it('keeps typing in one field together until the focus moves', async () => {
    const field = { tagName: 'INPUT', type: 'text' };
    fire('input', {}, field);
    setLabel({ text: 'A' });
    await tick();
    clock += 5000;
    fire('input', {}, field);
    setLabel({ text: 'AB' });
    await tick();
    expect(steps()).toBe(1);
    fire('focusin');
    fire('input', {}, field);
    setLabel({ text: 'ABC' });
    await tick();
    expect(steps()).toBe(2);
    undoChange();
    expect(useApp.getState().svg.label.text).toBe('AB');
  });

  it('leaves nothing for a change taken back, and keeps what redo had', async () => {
    patchSettings('trees', { spacingM: 9 });
    await tick();
    undoChange();
    expect(useUndo.getState().future).toHaveLength(1);
    press();
    nudge(0.01);
    await tick();
    nudge(-0.01);
    release();
    // Esc on a drag puts back the exact start.
    setArea(initial.area);
    await tick();
    expect(steps()).toBe(0);
    expect(redoChange()).toBe(true);
    expect(useApp.getState().settings.trees.spacingM).toBe(9);
  });

  it('names a step for an action and only undoes it while it is the last', async () => {
    patchSettings('trees', { spacingM: 9 });
    await tick();
    const step = asChange('Reset settings', resetAllSettings);
    expect(step?.label).toBe('Reset settings');
    expect(useApp.getState().settings.trees.spacingM).toBe(initial.settings.trees.spacingM);
    nudge(0.001);
    await tick();
    expect(undoChange(step!)).toBe(false);
    undoChange();
    expect(undoChange(step!)).toBe(true);
    expect(useApp.getState().settings.trees.spacingM).toBe(9);
  });

  it("doesn't take back picks another tab made when undoing something else", async () => {
    press();
    release();
    patchSvg({ routes: [route('mine')] });
    await tick();
    press();
    release();
    nudge(0.001);
    await tick();
    const theirs = [route('theirs')];
    quietly(
      () => patchSvg({ routes: theirs }),
      (setup) => ({ ...setup, svg: { ...setup.svg, routes: theirs } }),
    );
    expect(undoChange()).toBe(true);
    expect(useApp.getState().area).toEqual(initial.area);
    expect(useApp.getState().svg.routes).toBe(theirs);
    // The pick step changes nothing now, so there's nothing left to undo.
    expect(undoChange()).toBe(false);
  });

  it('switches the output back', async () => {
    setOutput('svg');
    await tick();
    expect(describeChange(useUndo.getState().past[0].setup, useApp.getState())).toBe('Switch to SVG map');
    undoChange();
    expect(useApp.getState().output).toBe('model');
    expect(useApp.getState().area).toEqual(initial.area);
  });

  it('names what changed', () => {
    const before = useApp.getState();
    const label = before.svg.label;
    const svg = (patch: Partial<typeof label>) => ({ ...before, svg: { ...before.svg, label: { ...label, ...patch } } });
    expect(describeChange(before, svg({ offsetX: 3 }))).toBe('Move title');
    expect(describeChange(before, svg({ size: 80, offsetX: 3 }))).toBe('Resize title');
    expect(describeChange(before, { ...before, placeName: 'Paris', area: { ...before.area, center: [2.35, 48.85] } })).toBe('Go to Paris');
    expect(describeChange(before, { ...before, area: { ...before.area, rotationDeg: 10 } })).toBe('Rotate area');
    expect(describeChange(before, { ...before, settings: { ...before.settings, water: { ...before.settings.water, thicknessMm: 1 } } })).toBe('Change water settings');
  });
});

describe('undo keys', () => {
  it('undo with Ctrl+Z, redo with Ctrl+Y or Ctrl+Shift+Z', async () => {
    patchSettings('trees', { spacingM: 9 });
    await tick();
    expect(key('z').defaultPrevented).toBe(true);
    expect(useApp.getState().settings.trees.spacingM).toBe(initial.settings.trees.spacingM);
    key('y');
    expect(useApp.getState().settings.trees.spacingM).toBe(9);
    key('z');
    key('Z', { shiftKey: true });
    expect(useApp.getState().settings.trees.spacingM).toBe(9);
  });

  it("leaves a field's own typing to the field", async () => {
    const field = { tagName: 'INPUT', type: 'text' };
    patchSettings('trees', { spacingM: 9 });
    await tick();
    fire('focusin');
    fire('input', {}, field);
    expect(key('z', {}, field).defaultPrevented).toBe(false);
    // Focused again but not typed in, it has nothing of its own to undo.
    fire('focusin');
    expect(key('z', {}, field).defaultPrevented).toBe(true);
  });

  it('leaves Ctrl+Z to the model editor unless the focus is in the sidebar', async () => {
    patchSettings('trees', { spacingM: 9 });
    await tick();
    quietly(() => useApp.setState((state) => ({ ui: { ...state.ui, view: 'result', editMode: true } })));
    expect(key('z').defaultPrevented).toBe(false);
    doc.activeElement = { closest: () => ({}) };
    expect(key('z').defaultPrevented).toBe(true);
    expect(useApp.getState().settings.trees.spacingM).toBe(initial.settings.trees.spacingM);
  });

  it('does nothing mid-drag', async () => {
    patchSettings('trees', { spacingM: 9 });
    await tick();
    press();
    key('z');
    release();
    expect(useApp.getState().settings.trees.spacingM).toBe(9);
  });
});
