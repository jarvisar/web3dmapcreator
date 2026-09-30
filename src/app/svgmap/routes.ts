// Picked roads in SVG maps: routes of their own colour, and roads left out.
// A road is in one place at a time, so assigning lines takes them out of
// wherever they were first.

import { MAX_PICKED_POINTS, MAX_ROUTES, pickedPoints, sameLine, type LonLatLine, type SvgRoute } from '../../core/svgmap/routes';
import { patchSvg, toast, useApp } from '../state/store';

const ROUTE_COLOURS = ['#E4002B', '#0057B8', '#FF8200', '#7A3E9D', '#009A44', '#E0A800', '#00A3AD', '#D62598'];

function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** A new route in a colour none of the others have. Returns its id, or null at the limit. */
export function addRoute(name?: string): string | null {
  const routes = useApp.getState().svg.routes;
  if (routes.length >= MAX_ROUTES) {
    toast(`An SVG map can have at most ${MAX_ROUTES} routes.`, 'error');
    return null;
  }
  const used = new Set(routes.map((r) => r.color));
  const color = ROUTE_COLOURS.find((c) => !used.has(c)) ?? ROUTE_COLOURS[routes.length % ROUTE_COLOURS.length];
  const route: SvgRoute = { id: newId(), name: name?.trim() || `Route ${routes.length + 1}`, color, width: 0.6, lines: [] };
  patchSvg((svg) => ({ routes: [...svg.routes, route] }));
  return route.id;
}

export function updateRoute(id: string, patch: Partial<Omit<SvgRoute, 'id' | 'lines'>>): void {
  patchSvg((svg) => ({ routes: svg.routes.map((r) => (r.id === id ? { ...r, ...patch, color: (patch.color ?? r.color).toUpperCase() } : r)) }));
}

export function deleteRoute(id: string): void {
  patchSvg((svg) => ({ routes: svg.routes.filter((r) => r.id !== id) }));
}

/** Puts lines in a route, leaves them out ('hidden'), or back to normal (null). */
export function assignLines(lines: LonLatLine[], target: string | 'hidden' | null): boolean {
  if (!lines.length) return true;
  const others = (stored: LonLatLine[]) => stored.filter((line) => !lines.some((picked) => sameLine(line, picked)));
  const svg = useApp.getState().svg;
  const routes = svg.routes.map((route) => ({ ...route, lines: [...others(route.lines), ...(route.id === target ? lines : [])] }));
  const hiddenLines = [...others(svg.hiddenLines), ...(target === 'hidden' ? lines : [])];
  if (pickedPoints(routes, hiddenLines) > MAX_PICKED_POINTS) {
    toast('That is more road than one map can keep picked. Put fewer roads in routes, or take some out of them first.', 'error');
    return false;
  }
  patchSvg({ routes, hiddenLines });
  return true;
}

/** Takes these picked lines out of every route and the roads left out. */
export function dropPicks(lines: LonLatLine[]): void {
  const gone = new Set(lines.map((line) => JSON.stringify(line)));
  const keep = (stored: LonLatLine[]) => stored.filter((line) => !gone.has(JSON.stringify(line)));
  patchSvg((svg) => ({ routes: svg.routes.map((route) => ({ ...route, lines: keep(route.lines) })), hiddenLines: keep(svg.hiddenLines) }));
}

/** Every road back to normal. */
export function clearPicks(): void {
  patchSvg((svg) => ({ routes: svg.routes.map((route) => ({ ...route, lines: [] })), hiddenLines: [] }));
}
