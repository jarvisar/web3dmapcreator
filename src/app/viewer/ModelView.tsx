import {
  Camera,
  Grid2x2,
  Info,
  Layers,
  Pencil,
  RefreshCw,
  RotateCcw,
  SquareDashed,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Vector3 } from 'three';
import { blockAt, blockBounds, parseRoadKey, roadEdits, roadKey, roadSegment, roundAt } from '../../core/edit/blocks';
import { isPartKey, kindOf, objectOf, partKey, twinOf } from '../../core/edit/keys';
import { buildingHeightRange, EDIT_LIMITS, MAX_SHAPE_POINTS, type AddedShape } from '../../core/edit/types';
import { simplifyLine } from '../../core/tracks/track';
import { Projection } from '../../core/geo/projection';
import { printerByKey } from '../../core/settings';
import { ROLE_GROUP, type ColourGroup } from '../../core/types';
import { ToolButton } from '../components/ToolButton';
import { COARSE_QUERY, DARK_QUERY, downloadBlob, prefersDark, useMediaQuery } from '../lib/browser';
import { formatCount, formatMm, formatRatio, formatSeconds, capitalise } from '../lib/format';
import { generateModel } from '../state/actions';
import {
  addShape,
  deletePoint,
  duplicateShapes,
  editMark,
  joinRoad,
  patchObjects,
  redoEdit,
  removeObjects,
  replaceWithDrawnRoads,
  revertEdits,
  setActivePoint,
  setEditMode,
  setSelection,
  setTool,
  settleEdits,
  shapeDefaults,
  shiftShape,
  splitRoad,
  stopEditUpdates,
  toggleSelected,
  undoEdit,
  updateShape,
  type EditMark,
} from '../state/editActions';
import { fileBase, generationProblem, hiddenDownloadParts, modelSize } from '../state/derived';
import { currentEditState, getEditData, getModelParts, onEditUpdate } from '../state/model';
import { setHiddenParts, setShowBed, setShownBounds, toast, togglePartHidden, useApp, type EditTool } from '../state/store';
import { editorTakesUndo } from '../state/undo';
import { describeCounts, describeKey } from './edit/describe';
import { EditToolbar, TOOLS } from './edit/EditToolbar';
import { Inspector } from './edit/Inspector';
import { EditController, type EditHandlers } from './editController';
import { chainLines } from './blocks';
import { SHAPES_PART, ViewerEngine } from './ViewerEngine';

type Panel = 'parts' | 'info' | 'warnings' | null;

const TOOL_HINTS: Record<EditTool, string> = {
  select: 'Click to select · Shift-drag to select in a box · Delete removes · Ctrl+Z undoes',
  several: 'Click things to add or drop them · Drag a box to add everything in it · Right-drag to pan',
  split: 'Click a road where one block should end and the next begin · Click a split (orange) to join it again · Esc to stop',
  text: 'Click where the text goes. Esc to stop.',
  pin: 'Click the spot to mark. Esc to stop.',
  box: 'Click where the box goes. Esc to stop.',
  cylinder: 'Click where the cylinder goes. Esc to stop.',
  path: 'Click along the road. Double-click or Enter to finish, Backspace takes the last point off, Esc cancels.',
  area: 'Click around the outline. Double-click or Enter to finish, Backspace takes the last point off, Esc cancels.',
};

const TOUCH_HINTS: Record<EditTool, string> = {
  select: 'Tap to select · Drag to orbit · Pinch to zoom',
  several: 'Tap things to add or drop them',
  split: 'Tap a road to split it there · Tap a split to join it',
  text: 'Tap where the text goes.',
  pin: 'Tap the spot to mark.',
  box: 'Tap where the box goes.',
  cylinder: 'Tap where the cylinder goes.',
  path: 'Tap along the road, then Finish.',
  area: 'Tap around the outline, then Finish.',
};

// Its own component, so progress updates don't re-render the whole viewer.
function Banner() {
  const running = useApp((state) => state.generation.status === 'running');
  const label = useApp((state) => state.generation.progress?.label ?? 'Starting');
  const percent = useApp((state) => Math.round((state.generation.progress?.fraction ?? 0) * 100));
  const problem = useApp((state) => generationProblem(state.area, state.settings, state.ui.largeGrids));
  const exporting = useApp((state) => state.exporting.status === 'running');
  const exportable = useApp((state) => state.generation.result?.exportable ?? true);
  if (running) {
    return (
      <div className="banner floating">
        <span className="spinner" aria-hidden="true" />
        <span>{label}</span>
        <span className="banner-muted">{percent}%</span>
      </div>
    );
  }
  return (
    <div className="banner floating">
      <span>{exportable ? 'The area, settings or routes changed since this model was made.' : 'The generator was restarted. Generate the model again to download it or see new edits.'}</span>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={problem !== null || exporting}
        title={problem ?? (exporting ? 'Wait for the download to finish' : undefined)}
        onClick={() => void generateModel()}
      >
        <RefreshCw size={14} aria-hidden="true" />
        Regenerate
      </button>
    </div>
  );
}

/** True once `flag` has been true for `ms`, so something quick never flashes up. A new `since` starts the wait again. */
function useDelayed(flag: boolean, ms: number, since = 0): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setShown(false);
    if (!flag) return;
    const timer = window.setTimeout(() => setShown(true), ms);
    return () => clearTimeout(timer);
  }, [flag, ms, since]);
  return shown;
}

// With no word from the worker for this long, an edit update is offered a Stop.
const STUCK_MS = 5000;

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element?.closest?.('input, textarea, select, [contenteditable="true"]'));
}

// The sidebar, top bar and action bar keep their keys. With a button there
// focused, arrows moved the selected shape instead of scrolling the sidebar,
// and Delete took the selection away.
function focusOutsideViewer(): boolean {
  return Boolean(document.activeElement?.closest?.('#sidebar, .topbar, .action-bar'));
}

function clearHiddenSelection(engine: ViewerEngine): void {
  const selection = useApp.getState().ui.selection;
  const gone = new Set(engine.hiddenByParts(selection));
  if (gone.size) setSelection(selection.filter((key) => !gone.has(key)));
}

export default function ModelView({ active }: { active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<ViewerEngine | null>(null);
  const controllerRef = useRef<EditController | null>(null);
  const [lost, setLost] = useState(false);
  // No WebGL2 at all, which a reload won't fix.
  const [failed, setFailed] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [hover, setHover] = useState<{ key: string; x: number; y: number } | null>(null);
  const [drawing, setDrawing] = useState(0);
  const result = useApp((state) => state.generation.result);
  const running = useApp((state) => state.generation.status === 'running');
  const stale = useApp((state) => state.generation.stale);
  const palette = useApp((state) => state.palette);
  const hidden = useApp((state) => state.ui.hiddenParts);
  const showBed = useApp((state) => state.ui.showBed);
  const printerKey = useApp((state) => state.exportSettings.printer);
  const editMode = useApp((state) => state.ui.editMode);
  const tool = useApp((state) => state.ui.tool);
  const selection = useApp((state) => state.ui.selection);
  const activePoint = useApp((state) => state.ui.activePoint);
  const pending = useApp((state) => state.ui.editsPending);
  const updating = useDelayed(pending, 300);
  const stuck = useDelayed(pending, STUCK_MS, useApp((state) => state.ui.editsSince));
  const edits = useApp((state) => state.edits);
  const dark = useMediaQuery(DARK_QUERY);
  const coarse = useMediaQuery(COARSE_QUERY);
  const version = result?.version;
  const editData = useMemo(() => getEditData(), [version]);
  const projection = useMemo(
    () => (editData.frame ? new Projection(editData.frame.center, editData.frame.rotationDeg, editData.frame.mmPerMetre) : null),
    [editData],
  );
  const projectionRef = useRef(projection);
  projectionRef.current = projection;
  const dragOrigins = useRef(new Map<string, AddedShape>());
  /** Where the edits stood when a drag started, to put back if it's called off. */
  const dragBefore = useRef<EditMark | null>(null);
  const shownBounds = useApp((state) => state.ui.shownBounds);
  // The size goes with the model it's for, so a new one never shows the last one's.
  const versionRef = useRef(version);
  versionRef.current = version;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let engine: ViewerEngine;
    try {
      engine = new ViewerEngine(host, {
        onContextLost: setLost,
        onBounds: (bounds) => versionRef.current !== undefined && setShownBounds(versionRef.current, bounds),
      });
    } catch {
      setFailed(true);
      return;
    }
    engineRef.current = engine;
    const state = useApp.getState();
    engine.setTheme(prefersDark());
    engine.setPalette(state.palette);
    engine.setEdits(state.edits);
    engine.setHidden(state.ui.hiddenParts);
    engine.setBed(printerByKey(state.exportSettings.printer), state.ui.showBed);
    // The model goes in from the effect on its version, which runs next.
    const controller = new EditController(engine, host, handlers());
    controllerRef.current = controller;
    const unsubscribe = onEditUpdate((update) => {
      engine.applyEditUpdate(update);
      clearHiddenSelection(engine);
    });
    return () => {
      unsubscribe();
      controller.dispose();
      controllerRef.current = null;
      engine.dispose();
      engineRef.current = null;
    };
    // The handlers read everything they need from the store when called.
  }, []);

  useEffect(() => {
    const engine = engineRef.current;
    const current = useApp.getState().generation.result;
    if (current && engine) engine.setModel(getModelParts(), current.bounds, getEditData(), currentEditState());
    // A card from the last model (its warnings, say) may not apply to this one.
    setPanel(null);
  }, [version]);

  useEffect(() => engineRef.current?.setPalette(palette), [palette]);
  useEffect(() => engineRef.current?.setEdits(edits), [edits]);
  useEffect(() => engineRef.current?.setHidden(hidden), [hidden]);
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    // What was hidden leaves the selection, or Delete would take away what can't be seen.
    clearHiddenSelection(engine);
  }, [hidden, edits, version]);
  useEffect(() => engineRef.current?.setSelection(editMode ? selection : []), [selection, editMode]);
  useEffect(() => engineRef.current?.setBed(printerByKey(printerKey), showBed), [printerKey, showBed]);
  useEffect(() => engineRef.current?.setTheme(dark), [dark]);
  useEffect(() => {
    if (active) engineRef.current?.resize();
  }, [active]);
  useEffect(() => {
    controllerRef.current?.setState({ enabled: editMode && active, tool, selection, edits, facts: editData.objects, projection, activePoint });
  }, [editMode, active, tool, selection, edits, editData, projection, activePoint]);
  useEffect(() => {
    if (!editMode) setHover(null);
    if (editMode) setPanel((open) => (open === 'info' ? null : open));
  }, [editMode]);

  // Keyboard shortcuts while editing.
  useEffect(() => {
    if (!editMode || !active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTyping(event.target) || document.querySelector('dialog[open], .popover')) return;
      const controller = controllerRef.current;
      const state = useApp.getState();
      const keys = state.ui.selection;
      const ctrl = event.ctrlKey || event.metaKey;
      const key = event.key;
      // From the sidebar they undo the settings (undo.ts).
      if (ctrl && /^[zy]$/i.test(key) && !editorTakesUndo()) return;
      if (ctrl && key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redoEdit();
        else undoEdit();
        return;
      }
      if (ctrl && key.toLowerCase() === 'y') {
        event.preventDefault();
        redoEdit();
        return;
      }
      if (focusOutsideViewer()) {
        // Escape still calls off a drag or a drawing, wherever the focus is.
        if (key === 'Escape' && (controller?.cancelDrag() || controller?.cancelDrawing())) event.preventDefault();
        return;
      }
      if (ctrl && key.toLowerCase() === 'd') {
        event.preventDefault();
        duplicateShapes(shapeIds(keys));
        return;
      }
      if (ctrl || event.altKey) return;
      switch (key) {
        case 'Escape':
          if (controller?.cancelDrag() || controller?.cancelDrawing()) break;
          if (state.ui.activePoint) setActivePoint(null);
          else if (state.ui.tool !== 'select') setTool('select');
          else if (keys.length) setSelection([]);
          else return;
          break;
        case 'Enter':
          if (!controller?.finishDrawing()) return;
          break;
        case 'Delete':
        case 'Backspace':
          if (controller?.undoPoint()) break;
          if (state.ui.activePoint) deletePoint(state.ui.activePoint.shape, state.ui.activePoint.index);
          else if (keys.length) removeObjects(keys);
          break;
        case '[':
        case ']':
          rotateShapes(shapeIds(keys), key === '[' ? -15 : 15);
          break;
        case 'f':
        case 'F':
          focusSelection();
          break;
        case 'ArrowUp':
        case 'ArrowDown':
        case 'ArrowLeft':
        case 'ArrowRight': {
          const ids = shapeIds(keys);
          if (!ids.length) return;
          const step = event.shiftKey ? 5 : 0.5;
          const [dx, dy] = key === 'ArrowUp' ? [0, step] : key === 'ArrowDown' ? [0, -step] : key === 'ArrowLeft' ? [-step, 0] : [step, 0];
          nudgeShapes(ids, dx, dy);
          break;
        }
        default: {
          const found = TOOLS.find((t) => t.key === key.toUpperCase());
          if (!found) return;
          setTool(found.tool);
        }
      }
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editMode, active]);

  function shapeIds(keys: string[]): string[] {
    return keys.filter((key) => kindOf(key) === 'shape').map((key) => key.slice(2));
  }

  function rotateShapes(ids: string[], degrees: number) {
    if (!ids.length) return;
    const shapes = useApp.getState().edits.shapes;
    for (const id of ids) {
      const shape = shapes.find((s) => s.id === id);
      if (shape) updateShape(id, { rotationDeg: (((shape.rotationDeg + degrees) % 360) + 360) % 360 }, `rotate-key:${ids.join(',')}`);
    }
  }

  function shifted(shape: AddedShape, dx: number, dy: number): Pick<AddedShape, 'at' | 'points'> {
    return shiftShape(shape, dx, dy, projectionRef.current!);
  }

  function nudgeShapes(ids: string[], dx: number, dy: number) {
    if (!projectionRef.current) return;
    const shapes = useApp.getState().edits.shapes;
    for (const id of ids) {
      const shape = shapes.find((s) => s.id === id);
      if (shape) updateShape(id, shifted(shape, dx, dy), `nudge:${ids.join(',')}`);
    }
  }

  function focusSelection() {
    const engine = engineRef.current;
    if (!engine) return;
    const keys = useApp.getState().ui.selection;
    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const key of keys) {
      const bounds = engine.boundsOf(key);
      if (!bounds) continue;
      min.min(bounds.min);
      max.max(bounds.max);
    }
    if (!Number.isFinite(min.x)) return;
    engine.focusOn(min.clone().add(max).multiplyScalar(0.5), max.clone().sub(min).length() / 2);
  }

  // Stable, since the parts list clears its highlight whenever this changes.
  const preview = useCallback((key: string | null) => engineRef.current?.setHover(key), []);
  const focusOn = useCallback((keys: string[]) => {
    setSelection(keys);
    // Once the selection is shown, so its bounds are known.
    requestAnimationFrame(focusSelection);
  }, []);

  /** The whole streets the roads are on, as whole segments, and the bridges along them. */
  function streetOf(key: string): string[] {
    const found = engineRef.current?.roads?.connected(key) ?? [key];
    return [...new Set(found.map(roadSegment))];
  }

  /**
   * Roads put in place of drawn ones along the same lines, in their width,
   * height and colour, to be reshaped point by point. A bridge on them stays
   * a bridge, and the drawn road runs up to it.
   */
  function makeDrawn(keys: string[]) {
    const engine = engineRef.current;
    const roads = engine?.roads;
    const p = projectionRef.current;
    if (!engine || !roads || !p) return;
    const edits = useApp.getState().edits;
    const data = getEditData();
    const shapes: Omit<AddedShape, 'id'>[] = [];
    const bridges = new Set<string>();
    const done: string[] = [];
    const clamp = (value: number, [low, high]: readonly [number, number]) => Math.min(high, Math.max(low, value));
    // Each piece once: a divided road's merged line is a piece of both
    // carriageways, and Whole street selects both. Drawn in groups by the
    // layer and height each piece has, so a raised block or one in a custom
    // layer stays that way.
    const groups = new Map<string, { layer: string; height: number; pieces: number[] }>();
    const seen = new Set<number>();
    for (const key of keys) {
      if (kindOf(key) !== 'road') continue;
      const pieces = roads.piecesOf(key).filter((piece) => engine.roadShown(piece));
      if (!pieces.length) continue;
      for (const piece of pieces) {
        if (seen.has(piece)) continue;
        seen.add(piece);
        const edit = engine.pieceEdit(piece);
        const layer = edit?.layer && edits.layers.some((l) => l.id === edit.layer) ? edit.layer : 'roads';
        const height = engine.roadHeight(piece);
        const group = `${layer}|${height}`;
        const entry = groups.get(group);
        if (entry) entry.pieces.push(piece);
        else groups.set(group, { layer, height, pieces: [piece] });
      }
      done.push(key);
      const twin = twinOf(key)!;
      const bridge = data.objects[twin];
      const range = parseRoadKey(key);
      if (bridge && range && (bridge.at === undefined ? range.from <= 0 && range.to >= 1 : bridge.at >= range.from && bridge.at <= range.to)) bridges.add(twin);
    }
    for (const { layer, height, pieces } of groups.values()) {
      const width = Math.max(...pieces.map((piece) => engine.roadWidth(piece)));
      for (const line of chainLines(pieces.map((piece) => roads.lineOf(piece)))) {
        // Within a hundredth of a mm of the road's line, coarser for a very long one.
        let tolerance = 0.01;
        let points = simplifyLine(line, tolerance);
        while (points.length > MAX_SHAPE_POINTS) points = simplifyLine(line, (tolerance *= 2));
        const lonLats = points.map(([x, y]) => p.modelToGeo(x, y));
        shapes.push({
          kind: 'path',
          layer,
          at: lonLats[0],
          points: lonLats,
          rotationDeg: 0,
          sizeMm: clamp(width, EDIT_LIMITS.pathWidthMm),
          depthMm: clamp(width, EDIT_LIMITS.depthMm),
          heightMm: clamp(height, EDIT_LIMITS.shapeHeightMm),
          liftMm: 0,
          followGround: true,
          text: '',
          font: 'montserrat',
        });
      }
    }
    if (!shapes.length) {
      toast('Nothing of that road shows, so there is nothing to draw.');
      return;
    }
    replaceWithDrawnRoads(done, shapes, [...bridges]);
  }

  function heightOf(key: string): number | null {
    const engine = engineRef.current;
    const ground = getEditData().objects[objectOf(key)]?.groundZ;
    const bounds = engine?.boundsOf(key);
    if (!bounds || ground === undefined) return null;
    return Math.round((bounds.max.z - ground) * 100) / 100;
  }

  function handlers(): EditHandlers {
    return {
      select(target, { additive, part }) {
        let key = target?.key ?? null;
        if (key && part && target?.sub && kindOf(key) === 'building') key = partKey(key, target.sub);
        if (!key) {
          if (!additive) setSelection([]);
          return;
        }
        if (additive) toggleSelected([key]);
        else setSelection([key]);
      },
      boxSelect(keys, additive) {
        if (additive) setSelection([...new Set([...useApp.getState().ui.selection, ...keys])]);
        else setSelection(keys);
        if (keys.length) toast(`Selected ${describeCounts(keys)}`);
      },
      hover(target, x, y) {
        const key = target?.key ?? null;
        const rect = hostRef.current?.getBoundingClientRect();
        setHover(key && rect ? { key, x: x - rect.left, y: y - rect.top } : null);
      },
      place(tool, target) {
        const p = projectionRef.current;
        if (!p || tool === 'select' || tool === 'several' || tool === 'split' || tool === 'path' || tool === 'area') return;
        const [lon, lat] = p.modelToGeo(target.point.x, target.point.y);
        const ground = target.ground ?? target.point.z;
        // Put on a roof or a bridge, it stands on it.
        const onTop = target.key !== null && ['building', 'bridge', 'shape'].includes(kindOf(target.key) ?? '');
        const lift = onTop ? Math.min(EDIT_LIMITS.liftMm[1], Math.max(0, Math.round((target.point.z - ground) * 10) / 10)) : 0;
        // Raised, it has a flat top that sits on the roof, whatever the tool's default.
        addShape({ ...shapeDefaults(tool), at: [lon, lat], points: [], rotationDeg: getEditData().frame?.rotationDeg ?? 0, liftMm: lift, ...(lift > 0 ? { followGround: false } : {}) });
        setTool('select');
      },
      split(target) {
        const engine = engineRef.current;
        const data = getEditData();
        if (!engine || !data.roads) return;
        if (target.kind === 'end') {
          toast('A block already ends there, at a junction or where an edit ends.');
          return;
        }
        const bounds = engine.blockBoundsOf(target.segment);
        if (target.kind === 'join') {
          joinRoad(target.segment, target.at, bounds);
          return;
        }
        // A selected block that's split stays selected, as its two halves.
        const before = blockAt(target.segment, bounds, target.at);
        const selection = useApp.getState().ui.selection;
        const junctions = data.roads.junctions?.[target.segment];
        const done = splitRoad(target.segment, target.at, (objects) => {
          if (!selection.includes(before)) return null;
          const after = blockBounds(roadEdits(objects).get(target.segment), junctions);
          const i = after.findIndex((v) => Math.abs(v - roundAt(target.at)) < 1e-6);
          if (i <= 0 || i >= after.length - 1) return null;
          return [...selection.filter((key) => key !== before), roadKey(target.segment, after[i - 1], after[i]), roadKey(target.segment, after[i], after[i + 1])];
        });
        if (!done) toast("This road can't be split any more there.");
      },
      draw(tool, points) {
        const p = projectionRef.current;
        if (!p) return;
        const lonLats = points.map((point) => p.modelToGeo(point.x, point.y));
        addShape({ ...shapeDefaults(tool), at: lonLats[0], points: lonLats, rotationDeg: 0 });
        setTool('select');
      },
      drawing: setDrawing,
      tooFewPoints(tool, needed) {
        toast(`A drawn ${tool} needs at least ${needed} points.`);
      },
      dragStart() {
        dragOrigins.current.clear();
        dragBefore.current = editMark();
        // Its changes are an undo step of their own, whatever was going on before.
        settleEdits();
      },
      dragEnd(cancelled) {
        dragOrigins.current.clear();
        if (cancelled && dragBefore.current) revertEdits(dragBefore.current);
        dragBefore.current = null;
        settleEdits();
      },
      dragHeight(key, heightMm) {
        // Held to the limits here, or the inspector showed heights the export clamps.
        const clamp = ([low, high]: readonly [number, number]) => Math.min(high, Math.max(low, heightMm));
        if (kindOf(key) === 'shape') {
          updateShape(key.slice(2), { heightMm: clamp(EDIT_LIMITS.shapeHeightMm) }, `drag-height:${key}`);
        } else {
          const scale = getEditData().frame?.buildingMmPerMetre;
          if (scale) patchObjects([key], { heightM: clamp(buildingHeightRange(scale)) / scale }, `drag-height:${key}`);
        }
      },
      moveShape(id, dx, dy) {
        const state = useApp.getState();
        const key = `s:${id}`;
        const ids = state.ui.selection.includes(key) ? state.ui.selection.filter((k) => kindOf(k) === 'shape').map((k) => k.slice(2)) : [id];
        for (const shapeId of ids) {
          let origin = dragOrigins.current.get(shapeId);
          if (!origin) {
            origin = state.edits.shapes.find((s) => s.id === shapeId);
            if (!origin) continue;
            dragOrigins.current.set(shapeId, origin);
          }
          updateShape(shapeId, shifted(origin, dx, dy), `move:${ids.join(',')}`);
        }
      },
      moveVertex(id, index, point, insert) {
        const p = projectionRef.current;
        const shape = useApp.getState().edits.shapes.find((s) => s.id === id);
        if (!p || !shape) return;
        const points = [...shape.points];
        const lonLat = p.modelToGeo(point.x, point.y);
        if (insert) points.splice(index + 1, 0, lonLat);
        else points[index] = lonLat;
        updateShape(id, { points, at: points[0] }, `vertex:${id}`);
      },
      deleteVertex(id, index) {
        deletePoint(id, index);
      },
      activatePoint(id, index) {
        setActivePoint({ shape: id, index });
      },
    };
  }

  async function screenshot() {
    const blob = await engineRef.current?.screenshot();
    if (!blob) {
      toast('Could not take a screenshot', 'error');
      return;
    }
    const state = useApp.getState();
    downloadBlob(blob, `${fileBase(state.placeName, state.fileName)}.png`);
  }

  // As shown, so a raised tower or a shape counts.
  const size = result ? modelSize(result, shownBounds) : null;
  const stats = result ? Object.entries(result.stats).filter(([, value]) => value !== '' && value !== null) : [];
  const totalTime = result ? Object.values(result.timings).reduce((sum, value) => sum + value, 0) : 0;
  const allHidden = result ? hiddenDownloadParts(result, edits, getEditData(), hidden).all : false;
  const groupShapes = edits.shapes.filter((shape) => !edits.layers.some((layer) => layer.id === shape.layer));
  const infoRows: [string, string][] = result
    ? [
        ['Scale', `${formatRatio(result.mmPerMetre)}, ${Number(result.mmPerMetre.toFixed(4))} mm per metre`],
        ['Triangles', formatCount(result.triangles)],
        ['Parts', String(result.parts.length)],
        ...stats.map(([key, value]): [string, string] => [
          capitalise(key.replace(/_/g, ' ')),
          typeof value === 'number' ? formatCount(value) : String(value),
        ]),
        ...(result.release ? [['Map data', `Overture ${result.release}`] as [string, string]] : []),
        ...(result.lidar
          ? ([
              ['LiDAR', `${formatCount(result.lidar.measured)} of ${formatCount(result.lidar.candidates)} buildings measured`],
              ...result.lidar.surveys.map((s): [string, string] => [`Survey`, `${s.name} (${s.attribution}), ${formatCount(s.buildings)} buildings`]),
            ] as [string, string][])
          : []),
        ...(result.surface
          ? result.surface.surveys.map((s): [string, string] => ['Survey', `${s.name}${s.year ? ` (${s.year})` : ''}, ${s.attribution}`])
          : []),
        ...(totalTime > 0 ? [['Generated in', formatSeconds(totalTime)] as [string, string]] : []),
      ]
    : [];
  const hovered = hover && editMode ? describeKey(hover.key, editData, edits) : null;
  const editing = editMode && result !== null;
  const drawingLine = editing && drawing > 0 && (tool === 'path' || tool === 'area');
  const hint = editing ? (coarse ? TOUCH_HINTS : TOOL_HINTS)[tool] : null;
  // Said by screen readers, since the selection is made on the canvas.
  const announced = !editing || !selection.length ? '' : selection.length === 1 ? `Selected ${describeKey(selection[0], editData, edits).title}` : `Selected ${describeCounts(selection)}`;

  return (
    <div className={`viewer${lost ? ' is-lost' : ''}${editing ? ' is-editing' : ''}`} aria-hidden={!active} inert={!active}>
      <div ref={hostRef} className="viewer-host" role="img" aria-label="3D preview of the generated model" />
      <div className="sr-only" aria-live="polite">
        {announced}
      </div>

      {result && size && (
        <div className="viewer-overlay viewer-top-left">
          <div className="chip floating" title="Printed width × depth × height">
            <span className="chip-strong">
              {formatMm(size.w)} × {formatMm(size.d)} × {formatMm(size.h)} mm
            </span>
            <span className="chip-muted">{formatRatio(result.mmPerMetre)}</span>
          </div>
          {result.warnings.length > 0 && (
            <button type="button" className="chip chip-warning floating" aria-expanded={panel === 'warnings'} onClick={() => setPanel(panel === 'warnings' ? null : 'warnings')}>
              <TriangleAlert size={14} aria-hidden="true" />
              {result.warnings.length === 1 ? '1 warning' : `${result.warnings.length} warnings`}
            </button>
          )}
          {panel === 'warnings' && (
            <div className="viewer-card floating">
              <ul className="warning-list">
                {result.warnings.map((warning, i) => (
                  <li key={i}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
          {editing && updating && (
            <div className="chip floating edit-busy" role="status">
              <span className="spinner" aria-hidden="true" />
              {stuck ? 'Still updating the model' : 'Updating the model'}
              {stuck && (
                <button type="button" className="link-btn" onClick={stopEditUpdates} title="The model has to be generated again after">
                  Stop
                </button>
              )}
            </div>
          )}
          {editing && <EditToolbar />}
          {drawingLine && (
            <div className="toolbar floating draw-bar" role="toolbar" aria-label="Drawing">
              <span className="draw-bar-count">
                {drawing} {drawing === 1 ? 'point' : 'points'}
              </span>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => controllerRef.current?.undoPoint()} title="Backspace">
                Undo point
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => controllerRef.current?.cancelDrawing()} title="Esc">
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={drawing < (tool === 'path' ? 2 : 3)}
                onClick={() => controllerRef.current?.finishDrawing()}
                title="Enter or double-click"
              >
                Finish
              </button>
            </div>
          )}
        </div>
      )}

      {result && (
        <div className="viewer-overlay viewer-top-right">
          <div className="toolbar floating" role="toolbar" aria-label="View">
            <ToolButton label={editMode ? 'Stop editing' : 'Edit the model (beta)'} pressed={editMode} onClick={() => setEditMode(!editMode)}>
              <Pencil size={15} aria-hidden="true" />
            </ToolButton>
            <ToolButton label="Reset view" onClick={() => engineRef.current?.resetView()}>
              <RotateCcw size={15} aria-hidden="true" />
            </ToolButton>
            <ToolButton label="View from above" onClick={() => engineRef.current?.topView()}>
              <SquareDashed size={15} aria-hidden="true" />
            </ToolButton>
            <ToolButton label={showBed ? 'Hide print bed' : 'Show print bed'} pressed={showBed} onClick={() => setShowBed(!showBed)}>
              <Grid2x2 size={15} aria-hidden="true" />
            </ToolButton>
            <ToolButton label="Parts" pressed={panel === 'parts'} onClick={() => setPanel(panel === 'parts' ? null : 'parts')}>
              <Layers size={15} aria-hidden="true" />
            </ToolButton>
            <ToolButton label="Model details" pressed={panel === 'info'} onClick={() => setPanel(panel === 'info' ? null : 'info')}>
              <Info size={15} aria-hidden="true" />
            </ToolButton>
            <ToolButton label="Save screenshot" onClick={screenshot}>
              <Camera size={15} aria-hidden="true" />
            </ToolButton>
          </div>

          {panel === 'parts' && (
            <section className="viewer-card floating parts-card" aria-label="Parts">
              <header className="viewer-card-header">
                <h3>Parts</h3>
                <button type="button" className="icon-btn icon-btn-sm" aria-label="Close parts" onClick={() => setPanel(null)}>
                  <X size={14} aria-hidden="true" />
                </button>
              </header>
              <ul className="parts-list">
                {result.parts.map((part) => {
                  const visible = !hidden.includes(part.id);
                  return (
                    <li key={part.id}>
                      <label className="part-row">
                        <input type="checkbox" className="checkbox" checked={visible} onChange={() => togglePartHidden(part.id)} />
                        <span className="dot" style={{ background: palette[ROLE_GROUP[part.role]].hex }} aria-hidden="true" />
                        <span className="part-name">{part.name}</span>
                        <span className="part-count">{formatCount(part.triangles)}</span>
                      </label>
                    </li>
                  );
                })}
                {edits.layers.map((layer) => {
                  const id = `layer:${layer.id}`;
                  return (
                    <li key={id}>
                      <label className="part-row">
                        <input type="checkbox" className="checkbox" checked={!hidden.includes(id)} onChange={() => togglePartHidden(id)} />
                        <span className="dot" style={{ background: layer.hex }} aria-hidden="true" />
                        <span className="part-name">{layer.name}</span>
                        <span className="part-count">Custom</span>
                      </label>
                    </li>
                  );
                })}
                {groupShapes.length > 0 && (
                  <li>
                    <label className="part-row">
                      <input type="checkbox" className="checkbox" checked={!hidden.includes(SHAPES_PART)} onChange={() => togglePartHidden(SHAPES_PART)} />
                      <span className="dot" style={{ background: (palette[groupShapes[0].layer as ColourGroup] ?? palette.buildings).hex }} aria-hidden="true" />
                      <span className="part-name">Added shapes</span>
                      <span className="part-count">{groupShapes.length}</span>
                    </label>
                  </li>
                )}
              </ul>
              <footer className="viewer-card-footer">
                <span>Hidden parts are left out of the download.</span>
                {hidden.length > 0 && (
                  <button type="button" className="link-btn" onClick={() => setHiddenParts([])}>
                    Show all
                  </button>
                )}
              </footer>
            </section>
          )}

          {panel === 'info' && (
            <section className="viewer-card floating info-card" aria-label="Model details">
              <header className="viewer-card-header">
                <h3>Model details</h3>
                <button type="button" className="icon-btn icon-btn-sm" aria-label="Close details" onClick={() => setPanel(null)}>
                  <X size={14} aria-hidden="true" />
                </button>
              </header>
              <dl className="info-list">
                {infoRows.map(([key, value]) => (
                  <div className="info-pair" key={key}>
                    <dt>{key}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {editing && panel === null && (
            <Inspector
              heightOf={heightOf}
              streetOf={streetOf}
              makeDrawn={makeDrawn}
              focus={focusSelection}
              preview={preview}
              focusOn={focusOn}
            />
          )}
        </div>
      )}

      {result && (stale || running || !result.exportable) && (
        <div className="viewer-overlay viewer-banner">
          <Banner />
        </div>
      )}

      {hovered && hover && !coarse && (
        <div className="viewer-hover-tip" style={{ left: hover.x, top: hover.y }}>
          <strong>{hovered.title}</strong>
          {hovered.detail && <span>{hovered.detail}</span>}
          {edits.objects[hover.key]?.removed && <span>Removed</span>}
          {isPartKey(hover.key) && <span>Part</span>}
        </div>
      )}

      {result && allHidden && (
        <div className="viewer-empty">
          <p>Every part is hidden.</p>
          <button type="button" className="btn btn-sm" onClick={() => setHiddenParts([])}>
            Show all parts
          </button>
        </div>
      )}

      {result && hint && <div className="viewer-hint viewer-edit-hint">{hint}</div>}
      {result && !hint && !coarse && <div className="viewer-hint">Drag to orbit · Right-drag to pan · Scroll to zoom</div>}
      {result && !hint && coarse && <div className="viewer-hint">Drag to orbit · Pinch to zoom · Two fingers to pan</div>}

      {!result && (
        <div className="viewer-empty">
          <span className="spinner spinner-lg" aria-hidden="true" />
          <p>Building your model</p>
        </div>
      )}

      {failed && (
        <div className="viewer-lost">
          <div className="viewer-card floating">
            <h3>This browser can't show the 3D view</h3>
            <p>
              WebGL2 is off or not supported here. The model was still made and can be downloaded. To see it, turn on graphics
              or hardware acceleration in the browser's settings and reload, or try another browser.
            </p>
          </div>
        </div>
      )}
      {lost && !failed && (
        <div className="viewer-lost">
          <div className="viewer-card floating">
            <h3>The 3D view stopped</h3>
            <p>
              The browser reset the graphics, often because memory ran low. It usually comes back by itself. Reloading
              keeps your settings, but the model has to be generated again.
            </p>
            <button type="button" className="btn btn-sm" onClick={() => location.reload()}>
              Reload the page
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
