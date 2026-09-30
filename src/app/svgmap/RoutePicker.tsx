// Picking roads in the SVG preview, to draw them in a route of their own
// colour or leave them out.
import { EyeOff, Plus, Route, Trash2, Undo2, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { worldToLonLat } from '../../core/svgmap/geo/mercator';
import { PICK_LAYERS, pickToWorld, type LonLatLine, type PickLines, type SvgRoute } from '../../core/svgmap/routes';
import { LAYER_NAMES } from '../../core/svgmap/settings';
import { ConfirmButton } from '../components/ConfirmButton';
import { NumberInput } from '../components/NumberField';
import { useApp } from '../state/store';
import { useSvgRender } from './render';
import { addRoute, assignLines, clearPicks, deleteRoute, dropPicks, updateRoute } from './routes';
import { BackupNote } from '../components/BackupNote';

const CELL_MM = 3;
// Ends this close meet.
const JOIN_MM = 0.05;
// How far a road may turn and still be the same road.
const ALONG_DEGREES = 40;

/** Finds pick lines by position, and follows them along a road. */
export class PickIndex {
  private readonly grid = new Map<number, number[]>();
  private readonly ends = new Map<number, number[]>();

  constructor(readonly pick: PickLines) {
    const { starts, points } = pick;
    for (let line = 0; line < starts.length - 1; line++) {
      for (let p = starts[line]; p < starts[line + 1] - 1; p++) {
        const x0 = Math.floor(Math.min(points[p * 2], points[p * 2 + 2]) / CELL_MM);
        const x1 = Math.floor(Math.max(points[p * 2], points[p * 2 + 2]) / CELL_MM);
        const y0 = Math.floor(Math.min(points[p * 2 + 1], points[p * 2 + 3]) / CELL_MM);
        const y1 = Math.floor(Math.max(points[p * 2 + 1], points[p * 2 + 3]) / CELL_MM);
        for (let x = x0; x <= x1; x++) {
          for (let y = y0; y <= y1; y++) {
            const key = cell(x, y);
            const list = this.grid.get(key);
            if (list) {
              if (list[list.length - 1] !== line) list.push(line);
            } else this.grid.set(key, [line]);
          }
        }
      }
      for (const p of [starts[line], starts[line + 1] - 1]) {
        const key = cell(Math.round(points[p * 2] / JOIN_MM), Math.round(points[p * 2 + 1] / JOIN_MM));
        const list = this.ends.get(key);
        if (list) list.push(line);
        else this.ends.set(key, [line]);
      }
    }
  }

  get count(): number {
    return this.pick.starts.length - 1;
  }

  /** The line nearest a point within `reach` mm, or -1. */
  nearest(x: number, y: number, reach: number): number {
    const { starts, points } = this.pick;
    let best = -1;
    let bestDistance = reach;
    const r = Math.ceil(reach / CELL_MM);
    const cx = Math.floor(x / CELL_MM);
    const cy = Math.floor(y / CELL_MM);
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (const line of this.grid.get(cell(cx + dx, cy + dy)) ?? []) {
          for (let p = starts[line]; p < starts[line + 1] - 1; p++) {
            const d = segmentDistance(x, y, points[p * 2], points[p * 2 + 1], points[p * 2 + 2], points[p * 2 + 3]);
            if (d < bestDistance) {
              bestDistance = d;
              best = line;
            }
          }
        }
      }
    }
    return best;
  }

  /** The lines, and on from each end the road carrying straight on in the same class. */
  along(lines: number[]): number[] {
    const { starts, points, layers, classes } = this.pick;
    const found = new Set(lines);
    const stack = [...lines];
    const direction = (line: number, atStart: boolean): [number, number] => {
      // Heading out of the line at that end.
      const [p, q] = atStart ? [starts[line] + 1, starts[line]] : [starts[line + 1] - 2, starts[line + 1] - 1];
      const dx = points[q * 2] - points[p * 2];
      const dy = points[q * 2 + 1] - points[p * 2 + 1];
      const length = Math.hypot(dx, dy) || 1;
      return [dx / length, dy / length];
    };
    while (stack.length) {
      const line = stack.pop()!;
      for (const atStart of [true, false]) {
        const p = atStart ? starts[line] : starts[line + 1] - 1;
        const [hx, hy] = direction(line, atStart);
        const px = Math.round(points[p * 2] / JOIN_MM);
        const py = Math.round(points[p * 2 + 1] / JOIN_MM);
        let best = -1;
        let bestTurn = ALONG_DEGREES;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (const next of this.ends.get(cell(px + dx, py + dy)) ?? []) {
              if (next === line || layers[next] !== layers[line] || classes[next] !== classes[line]) continue;
              // Which end of the next line is here decides its heading away from the junction.
              const nearStart = Math.hypot(points[starts[next] * 2] - points[p * 2], points[starts[next] * 2 + 1] - points[p * 2 + 1]) < JOIN_MM * 2;
              const [nx, ny] = direction(next, !nearStart);
              const turn = (Math.acos(Math.max(-1, Math.min(1, hx * nx + hy * ny))) * 180) / Math.PI;
              if (turn < bestTurn) {
                bestTurn = turn;
                best = next;
              }
            }
          }
        }
        if (best >= 0 && !found.has(best)) {
          found.add(best);
          stack.push(best);
        }
      }
    }
    return [...found];
  }

  pathD(line: number): string {
    const { starts, points } = this.pick;
    let d = '';
    for (let p = starts[line]; p < starts[line + 1]; p++) d += `${p === starts[line] ? 'M' : 'L'}${points[p * 2].toFixed(3)} ${points[p * 2 + 1].toFixed(3)}`;
    return d;
  }

  lonLat(line: number): LonLatLine {
    const { starts, points, transform } = this.pick;
    const out: LonLatLine = [];
    for (let p = starts[line]; p < starts[line + 1]; p++) {
      const { lon, lat } = worldToLonLat(...pickToWorld(transform, points[p * 2], points[p * 2 + 1]), transform.zoom);
      out.push([Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6]);
    }
    return out;
  }
}

function cell(x: number, y: number): number {
  return (x + 2 ** 20) * 2 ** 21 + (y + 2 ** 20);
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length2 = dx * dx + dy * dy;
  let t = length2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / length2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/**
 * Picked roads drawn over the preview. Routes show in their colours, since
 * the wood look burns every line alike, and left-out roads as a faint dashed
 * line so they can be found again.
 */
export function PickOverlay({ index, selected, hover, unit, routes }: { index: PickIndex; selected: number[]; hover: number; unit: number; routes: SvgRoute[] }) {
  const hidden: number[] = [];
  const routed = new Map<number, number[]>();
  for (let line = 0; line < index.count; line++) {
    const owner = index.pick.owners[line];
    if (owner === -1) hidden.push(line);
    else if (owner >= 0) routed.set(owner, [...(routed.get(owner) ?? []), line]);
  }
  return (
    <g fill="none" strokeLinecap="round" strokeLinejoin="round" pointerEvents="none">
      {hidden.length > 0 && (
        <path d={hidden.map((line) => index.pathD(line)).join('')} stroke="#6b7280" strokeWidth={unit * 1.5} strokeDasharray={`${unit * 4} ${unit * 3}`} opacity={0.7} />
      )}
      {[...routed].map(([owner, lines]) => (
        <path key={owner} d={lines.map((line) => index.pathD(line)).join('')} stroke={routes[owner]?.color ?? '#888888'} strokeWidth={unit * 3} opacity={0.85} />
      ))}
      {hover >= 0 && !selected.includes(hover) && <path d={index.pathD(hover)} stroke="#2f7cf6" strokeWidth={unit * 5} opacity={0.35} />}
      {selected.length > 0 && <path d={selected.map((line) => index.pathD(line)).join('')} stroke="#2f7cf6" strokeWidth={unit * 5} opacity={0.6} />}
    </g>
  );
}

const NEW = '__new';
const NONE: LonLatLine[] = [];

/** The card beside the preview while roads are being picked. */
export function RouteCard({ index, selected, onSelect, onClose }: { index: PickIndex | null; selected: number[]; onSelect: (lines: number[]) => void; onClose: () => void }) {
  const routes = useApp((state) => state.svg.routes);
  const hiddenCount = useApp((state) => state.svg.hiddenLines.length);
  const mode = useApp((state) => state.svg.mode);
  const missing = useSvgRender((state) => state.result?.missingPicks ?? NONE);
  const [target, setTarget] = useState('');
  const selectId = useId();
  useEffect(() => {
    if (!routes.some((r) => r.id === target)) setTarget(routes[0]?.id ?? '');
  }, [routes, target]);

  const owners = index ? selected.map((line) => index.pick.owners[line]) : [];
  const anyPicked = owners.some((owner) => owner !== -2);
  const allHidden = owners.length > 0 && owners.every((owner) => owner === -1);
  const lines = () => (index ? selected.map((line) => index.lonLat(line)) : []);
  const assign = (to: string | 'hidden' | null) => {
    if (assignLines(lines(), to)) onSelect([]);
  };
  const layers = index ? new Set(selected.map((line) => LAYER_NAMES[PICK_LAYERS[index.pick.layers[line]]])) : new Set<string>();

  return (
    <section className="viewer-card floating inspector route-card" aria-label="Pick roads">
      <header className="viewer-card-header">
        <h3>{selected.length ? `${selected.length} ${selected.length === 1 ? 'line' : 'lines'} picked` : 'Pick roads'}</h3>
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Stop picking roads" onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      <div className="inspector-body">
        {!selected.length ? (
          <p className="inspector-intro">
            Click the roads, paths or railways a route follows, and click one again to drop it. Put them in a route to give them a colour and layer of
            their own, or leave them out. Dragging still moves the map.
          </p>
        ) : (
          <>
            <div className="inspector-actions">
              <button type="button" className="btn btn-sm" onClick={() => index && onSelect(index.along(selected))} title="Follow the road on from both ends">
                <Route size={14} aria-hidden="true" />
                Along the road
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => onSelect([])}>
                Clear
              </button>
            </div>
            {layers.size > 0 && <p className="inspector-note">{[...layers].join(', ')}</p>}
            <div className="field">
              <div className="field-row">
                <label className="field-label" htmlFor={selectId}>
                  Route
                </label>
                <span className="layer-field">
                  <select
                    id={selectId}
                    className="select"
                    value={target || NEW}
                    onChange={(event) => {
                      if (event.target.value !== NEW) {
                        setTarget(event.target.value);
                        return;
                      }
                      const id = addRoute();
                      if (id) setTarget(id);
                    }}
                  >
                    {routes.map((route) => (
                      <option key={route.id} value={route.id}>
                        {route.name}
                      </option>
                    ))}
                    <option value={NEW}>New route…</option>
                  </select>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={() => {
                      const id = target || addRoute();
                      if (id) assign(id);
                    }}
                  >
                    Add
                  </button>
                </span>
              </div>
            </div>
            <div className="inspector-actions">
              {!allHidden && (
                <button type="button" className="btn btn-sm" onClick={() => assign('hidden')}>
                  <EyeOff size={14} aria-hidden="true" />
                  Leave out
                </button>
              )}
              {anyPicked && (
                <button type="button" className="btn btn-sm" onClick={() => assign(null)}>
                  <Undo2 size={14} aria-hidden="true" />
                  Back to normal
                </button>
              )}
            </div>
          </>
        )}
        <RouteList routes={routes} print={mode === 'print'} />
        {missing.length > 0 && (
          <p className="inspector-note">
            {missing.length === 1 ? "1 picked road isn't" : `${missing.length} picked roads aren't`} on this map. They may be outside it, on a layer that's
            off, or drawn differently at this scale.{' '}
            <button type="button" className="link-btn" onClick={() => dropPicks(missing)}>
              Drop {missing.length === 1 ? 'it' : 'them'}
            </button>
          </p>
        )}
        <BackupNote of="picks" />
        {(hiddenCount > 0 || routes.some((r) => r.lines.length)) && (
          <div className="inspector-changes">
            <span>{hiddenCount ? `${hiddenCount} left out` : 'Nothing left out'}</span>
            <ConfirmButton className="link-btn is-danger" confirm="Click again to undo every pick" onConfirm={clearPicks}>
              Undo all picks
            </ConfirmButton>
          </div>
        )}
      </div>
      <footer className="viewer-card-footer inspector-footer">
        <span>Routes are drawn on top of the roads, each as its own layer.</span>
      </footer>
    </section>
  );
}

function RouteList({ routes, print }: { routes: SvgRoute[]; print: boolean }) {
  return (
    <div className="inspector-layers">
      <div className="inspector-section-head">
        <span>Routes</span>
        <button type="button" className="link-btn" onClick={() => addRoute()}>
          <Plus size={12} aria-hidden="true" /> New route
        </button>
      </div>
      {routes.length ? (
        <ul className="layer-list">
          {routes.map((route) => (
            <RouteRow key={route.id} route={route} print={print} />
          ))}
        </ul>
      ) : (
        <p className="inspector-note">A route is a colour of its own for the roads you pick, like a race course or the way home.</p>
      )}
    </div>
  );
}

function RouteRow({ route, print }: { route: SvgRoute; print: boolean }) {
  const [name, setName] = useState(route.name);
  useEffect(() => setName(route.name), [route.name]);
  return (
    <li className="layer-row">
      <input
        type="color"
        className="colour-native route-colour"
        value={route.color.toLowerCase()}
        aria-label={`Colour of ${route.name}`}
        onChange={(event) => updateRoute(route.id, { color: event.target.value.toUpperCase() })}
      />
      <input
        className="text-input layer-name"
        value={name}
        aria-label="Route name"
        maxLength={60}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => name.trim() && name !== route.name && updateRoute(route.id, { name: name.trim() })}
        onKeyDown={(event) => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
      />
      {print && (
        <NumberInput value={route.width} min={0.02} max={5} step={0.05} unit="mm" width={74} ariaLabel={`Line width of ${route.name}`} onChange={(width) => updateRoute(route.id, { width })} />
      )}
      <span className="layer-count" title="Lines in it">
        {route.lines.length}
      </span>
      <button type="button" className="icon-btn icon-btn-sm" aria-label={`Delete ${route.name}`} title="Delete the route. Its roads go back to normal." onClick={() => deleteRoute(route.id)}>
        <Trash2 size={12} aria-hidden="true" />
      </button>
    </li>
  );
}
