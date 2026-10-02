import { Group, Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyEdits } from '../../core/edit/types';
import { Projection } from '../../core/geo/projection';
import { EditController, type EditHandlers, type EditState } from './editController';
import type { ViewerEngine } from './ViewerEngine';

class Element extends EventTarget {
  className = '';
  hidden = false;
  style = {};
  classList = { toggle: vi.fn() };
  appendChild = vi.fn();
  remove = vi.fn();
  setPointerCapture = vi.fn();
  hasPointerCapture = () => false;
  getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 300 });
}

function pointer(target: EventTarget, type: string, x = 10, y = 10) {
  target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), {
    clientX: x, clientY: y, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0,
    buttons: type === 'pointerup' ? 0 : 1, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
  }));
}

function setup(tool: EditState['tool'] = 'path') {
  const host = new Element();
  const handlers: EditHandlers = {
    select: vi.fn(), deleteVertex: vi.fn(), activatePoint: vi.fn(), boxSelect: vi.fn(), hover: vi.fn(),
    place: vi.fn(), draw: vi.fn(), split: vi.fn(), drawing: vi.fn(), tooFewPoints: vi.fn(),
    dragStart: vi.fn(), dragEnd: vi.fn(), dragHeight: vi.fn(), moveShape: vi.fn(), moveVertex: vi.fn(),
  };
  const engine = {
    canvas: host,
    controls: { enabled: true, object: { position: new Vector3(0, -100, 100) }, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    overlay: new Group(), geometryListeners: new Set(), roads: null, requestRender: vi.fn(), setHover: vi.fn(),
    pickAt: (x: number, y: number) => ({ key: 'b:one', sub: '', part: 'buildings', point: new Vector3(x, y, 1), ground: 1 }),
    hoverAt: () => ({ key: 'b:one', sub: '', part: 'buildings', point: null, ground: null }),
    boundsOf: () => null,
    pointOnPlane: (x: number, y: number) => new Vector3(x, y, 1),
  };
  const state: EditState = {
    enabled: true, tool, selection: [], edits: emptyEdits(), facts: {},
    projection: new Projection([0, 45], 0, 0.07), activePoint: null,
  };
  const controller = new EditController(engine as unknown as ViewerEngine, host as unknown as HTMLElement, handlers);
  controller.setState(state);
  const click = (x: number, y: number) => {
    pointer(host, 'pointerdown', x, y);
    pointer(window, 'pointerup', x, y);
  };
  return { host, handlers, engine, state, controller, click };
}

beforeEach(() => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) }));
  vi.stubGlobal('document', { createElement: () => new Element() });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('editor interaction lifetime', () => {
  it('drops an unfinished drawing when a new model replaces its frame', () => {
    const { controller, state, click, handlers } = setup();
    click(10, 10);
    click(20, 20);
    expect(handlers.drawing).toHaveBeenLastCalledWith(2);
    controller.setState({ ...state, projection: new Projection([1, 46], 30, 0.07) });
    expect(controller.finishDrawing()).toBe(false);
    expect(handlers.draw).not.toHaveBeenCalled();
    expect(handlers.drawing).toHaveBeenLastCalledWith(0);
    click(30, 30);
    click(40, 40);
    expect(controller.finishDrawing()).toBe(true);
    expect(handlers.draw).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it('does not turn a press from an earlier edit mode into a new click', () => {
    const { controller, state, host, handlers } = setup('select');
    pointer(host, 'pointerdown');
    controller.setState({ ...state, enabled: false });
    controller.setState(state);
    pointer(window, 'pointerup');
    expect(handlers.select).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('does not turn a press from an earlier tool into placement with the new tool', () => {
    const { controller, state, host, handlers } = setup('select');
    pointer(host, 'pointerdown');
    controller.setState({ ...state, tool: 'box' });
    pointer(window, 'pointerup');
    expect(handlers.place).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('clears a queued hover when editing stops', () => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockReturnValue(1);
    const { controller, state, host, handlers, engine } = setup('select');
    host.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 10, clientY: 10, pointerId: 1, buttons: 0 }));
    controller.setState({ ...state, enabled: false });
    vi.runAllTimers();
    expect(engine.setHover).toHaveBeenLastCalledWith(null);
    expect(handlers.hover).toHaveBeenLastCalledWith(null, 0, 0);
    controller.dispose();
  });

  it('cancels a shape drag when the window loses focus', () => {
    const { controller, state, host, handlers, engine } = setup('select');
    engine.pickAt = (x, y) => ({ key: 's:one', sub: '', part: 'shapes', point: new Vector3(x, y, 1), ground: 1 });
    controller.setState({ ...state, selection: ['s:one'] });
    pointer(host, 'pointerdown');
    pointer(host, 'pointermove', 30, 30);
    expect(handlers.moveShape).toHaveBeenLastCalledWith('one', 20, 20);
    window.dispatchEvent(new Event('blur'));
    expect(handlers.dragEnd).toHaveBeenLastCalledWith(true);
    expect(engine.controls.enabled).toBe(true);
    controller.dispose();
  });

  it('ends a drag if its release went missing, before a hover can move the shape again', () => {
    const { controller, state, host, handlers, engine } = setup('select');
    engine.pickAt = (x, y) => ({ key: 's:one', sub: '', part: 'shapes', point: new Vector3(x, y, 1), ground: 1 });
    controller.setState({ ...state, selection: ['s:one'] });
    pointer(host, 'pointerdown');
    pointer(host, 'pointermove', 30, 30);
    host.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 50, clientY: 50, pointerId: 1, buttons: 0 }));
    expect(handlers.moveShape).toHaveBeenCalledOnce();
    expect(handlers.dragEnd).toHaveBeenLastCalledWith(false);
    expect(engine.controls.enabled).toBe(true);
    controller.dispose();
  });
});
