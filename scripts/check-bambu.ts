// Round-trips sample projects through the installed Bambu Studio: import,
// save, reopen and save again, comparing plate assignments, part names,
// geometry, filament colours, printer preset and bed placement each time.
// It does not slice, print or go online.
//
// Bambu Studio always gets a data directory inside the working folder, so the
// user's own settings, presets and recent files are never touched. Every
// slicer run is waited for, or stopped if it hangs, and any slicer process
// still running from this folder at the end is stopped and reported.
//
//   npx tsx scripts/check-bambu.ts [--bambu <exe>] [--orca <exe>] [--folder <dir>]
//
// --folder defaults to a new folder in the system temp directory. OrcaSlicer
// is tried as well when it is installed, for information only.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { exportPlates } from '../src/core/export/index';
import { plateOrigin, sectionGrid } from '../src/core/export/sections';
import { box, child, findAll, metadataValue, parseXml, part, plate, type Mesh, type XmlNode } from '../src/core/export/test-helpers';
import type { ExportRequest } from '../src/core/engine/protocol';
import { DEFAULT_PALETTE, PALETTE_PRESETS, type Palette } from '../src/core/settings';
import type { MaterialRole, MeshPart, Plate } from '../src/core/types';

const MODEL = '3D/3dmodel.model';
const SETTINGS = 'Metadata/model_settings.config';
const PROJECT = 'Metadata/project_settings.config';
const TIMEOUT_MS = 180_000;
// Bambu Studio sometimes saves and then never exits. This long after its
// result.json appears it is stopped and the check goes on.
const HANG_MS = 20_000;

function option(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// ------------------------------------------------------------------ fixtures

type Box = [number, number, number, number, number, number];

// A small city: terrain, water, parks, roads, paving, buildings in two parts, trees and a rim.
function city(west: number, south: number, east: number, north: number): MeshPart[] {
  const w = east - west;
  const d = north - south;
  const cx = (west + east) / 2;
  const cy = (south + north) / 2;
  const boxes = (list: Box[]): Mesh[] => list.map((b) => box(...b));
  const layer = (id: string, name: string, role: MaterialRole, list: Box[]) => part(id, name, role, ...boxes(list));
  const blocks: Box[] = [];
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 4; j++) {
      blocks.push([west + 8 + (i * (w - 20)) / 6, south + 8 + (j * (d - 20)) / 4, 1.85, 6, 5, 4 + ((i * 7 + j * 3) % 11) * 2]);
    }
  }
  return [
    layer('terrain', 'Terrain', 'terrain', [[west, south, 0, w, d, 2]]),
    layer('water', 'Water', 'water', [[west + 2, south + 2, 1.2, w * 0.2, d * 0.3, 0.6]]),
    layer('green', 'Parks', 'green', [[cx - 15, cy - 12, 1.85, 12, 9, 0.55]]),
    layer('roads', 'Roads', 'road', [[west, cy - 1, 1.85, w, 2, 0.6], [cx - 1, south, 1.85, 2, d, 0.6]]),
    layer('paved', 'Paved', 'paved', [[cx + 4, cy + 4, 1.85, 8, 6, 0.5]]),
    layer('buildings-a', 'Buildings', 'building', blocks.slice(0, 12)),
    layer('buildings-b', 'Buildings', 'building', blocks.slice(12)),
    layer('trees', 'Trees', 'tree', [[cx - 12, cy - 9, 2.3, 1.2, 1.2, 1.8], [cx - 8, cy - 6, 2.3, 1.2, 1.2, 1.8]]),
    layer('rim', 'Border Rim', 'rim', [[west, south, 0, 2, d, 3.5]]),
  ];
}

// The model cut along section edges, the way the geometry side hands plates over.
function clipBox([x, y, z, bw, bd, h]: Box, [w, s, e, n]: [number, number, number, number]): Box | null {
  const x0 = Math.max(x, w);
  const x1 = Math.min(x + bw, e);
  const y0 = Math.max(y, s);
  const y1 = Math.min(y + bd, n);
  return x1 - x0 > 1e-9 && y1 - y0 > 1e-9 ? [x0, y0, z, x1 - x0, y1 - y0, h] : null;
}

function sections(width: number, depth: number, maxW: number, maxH: number, bedW: number, bedD: number): Plate[] {
  const whole = city(-width / 2, -depth / 2, width / 2, depth / 2);
  return sectionGrid([-width / 2, -depth / 2, width / 2, depth / 2], maxW, maxH, bedW, bedD).map((cell) => {
    const parts = whole
      .map((p) => {
        // Rebuild each box of the part from its 8 corners, clipped to the cell.
        const list: Box[] = [];
        for (let v = 0; v < p.positions.length; v += 24) {
          const x = p.positions[v];
          const y = p.positions[v + 1];
          const z = p.positions[v + 2];
          const clipped = clipBox([x, y, z, p.positions[v + 3] - x, p.positions[v + 7] - y, p.positions[v + 14] - z], cell.bounds);
          if (clipped) list.push(clipped);
        }
        return list.length ? part(p.id, p.name, p.role, ...list.map((b) => box(...b))) : null;
      })
      .filter((p): p is MeshPart => p !== null);
    return plate(cell.name, parts, cell.bounds);
  });
}

interface Fixture {
  name: string;
  plates: Plate[];
  printer: string;
  palette: Palette;
}

function fixtures(): Fixture[] {
  const classic = PALETTE_PRESETS.find((p) => p.key === 'CLASSIC')!.palette;
  return [
    { name: 'single-p1s', plates: [plate('Map', city(-75, -55, 75, 55), [-75, -55, 75, 55])], printer: 'P1S', palette: DEFAULT_PALETTE },
    { name: 'grid-2x2-x1c', plates: sections(400, 380, 210, 210, 256, 256), printer: 'X1C', palette: classic },
    { name: 'sections-a1-mini', plates: sections(330, 160, 170, 170, 180, 180), printer: 'A1M', palette: DEFAULT_PALETTE },
    { name: 'single-h2d', plates: [plate('Map', city(-160, -145, 160, 145), [-160, -145, 160, 145])], printer: 'H2D', palette: classic },
    { name: 'mk4-bed-p1s-presets', plates: [plate('Map', city(-100, -80, 100, 80), [-100, -80, 100, 80])], printer: 'MK4', palette: DEFAULT_PALETTE },
  ];
}

function exportFixture(fixture: Fixture, format: ExportRequest['format']) {
  return exportPlates(fixture.plates, {
    format,
    printer: fixture.printer,
    palette: fixture.palette,
    multiPlate: fixture.plates.length > 1,
    sectionWidthMm: 210,
    sectionHeightMm: 210,
    fileBase: fixture.name,
  });
}

// ------------------------------------------------------------------ reading projects

type Point = [number, number, number];
interface Triangle {
  points: [Point, Point, Point];
  colour: string;
}
interface Project {
  plates: Map<string, Map<string, Triangle[]>>;
  palette: string[];
  printer: string;
  bed: [number, number];
  bottom: number;
}

function transform(point: Point, text: string | undefined): Point {
  if (!text) return point;
  const m = text.trim().split(/\s+/).map(Number);
  return [0, 1, 2].map((i) => m[i] * point[0] + m[i + 3] * point[1] + m[i + 6] * point[2] + m[9 + i]) as Point;
}

// Bambu's TriangleSelector paint state: two split bits, then the state.
function paintId(code: string | undefined, fallback: number): number {
  if (!code) return fallback;
  if (!code.endsWith('C')) return Math.floor(parseInt(code, 16) / 4);
  return 3 + 15 * (code.slice(1, -1).match(/F/g)?.length ?? 0) + parseInt(code[0], 16);
}

function readProject(path: string): Project {
  const files = unzipSync(readFileSync(path));
  const text = (name: string) => {
    if (!files[name]) throw new Error(`${path} has no ${name}`);
    return strFromU8(files[name]);
  };
  const roots = new Map<string, XmlNode>();
  for (const name of Object.keys(files)) if (name.endsWith('.model')) roots.set(name, parseXml(text(name)));
  const config = child(parseXml(text(SETTINGS)), 'config')!;
  const project = JSON.parse(text(PROJECT));
  const palette: string[] = project.filament_colour;
  const [width, depth] = String(project.printable_area[2]).split('x').map(Number);
  const root = roots.get(MODEL)!;
  const resources = child(child(root, 'model')!, 'resources')!;
  const build = child(child(root, 'model')!, 'build')!;
  const objectIn = (model: XmlNode, id: string) => findAll(model, 'object').find((o) => o.attrs.id === id);
  const plates = config.children.filter((c) => c.tag === 'plate');
  const result = new Map<string, Map<string, Triangle[]>>();
  let bottom = Infinity;
  plates.forEach((p, index) => {
    if (metadataValue(p, 'plater_id') !== String(index + 1)) throw new Error(`Plate ${index + 1} has the wrong plater_id`);
    const instances = p.children.filter((c) => c.tag === 'model_instance');
    if (instances.length !== 1) throw new Error(`Plate ${index + 1} has ${instances.length} objects`);
    if (metadataValue(instances[0], 'instance_id') !== '0') throw new Error(`Plate ${index + 1} instance is not 0`);
    const objectId = metadataValue(instances[0], 'object_id')!;
    const assembly = resources.children.find((o) => o.tag === 'object' && o.attrs.id === objectId);
    const item = build.children.find((i) => i.tag === 'item' && i.attrs.objectid === objectId);
    const settings = config.children.find((o) => o.tag === 'object' && o.attrs.id === objectId);
    if (!assembly || !item || !settings) throw new Error(`Plate ${index + 1} object ${objectId} is incomplete`);
    const name = metadataValue(settings, 'name')!;
    if (name !== metadataValue(p, 'plater_name')) throw new Error(`Plate ${index + 1} is named ${metadataValue(p, 'plater_name')} but holds ${name}`);
    const [ox, oy] = plateOrigin(index, plates.length, width, depth);
    const parts = new Map<string, Triangle[]>();
    for (const component of findAll(assembly, 'component')) {
      const partId = component.attrs.objectid;
      const modelPath = (component.attrs['p:path'] ?? `/${MODEL}`).replace(/^\//, '');
      const mesh = child(objectIn(roots.get(modelPath)!, partId)!, 'mesh')!;
      const partSettings = settings.children.find((c) => c.tag === 'part' && c.attrs.id === partId)!;
      const partName = metadataValue(partSettings, 'name')!;
      const extruder = Number(metadataValue(partSettings, 'extruder') ?? metadataValue(settings, 'extruder'));
      const points = findAll(child(mesh, 'vertices')!, 'vertex').map((v) => {
        const [x, y, z] = transform(transform([Number(v.attrs.x), Number(v.attrs.y), Number(v.attrs.z)], component.attrs.transform), item.attrs.transform);
        return [x - ox, y - oy, z] as Point;
      });
      for (const [x, y, z] of points) {
        if (x < -1e-4 || x > width + 1e-4 || y < -1e-4 || y > depth + 1e-4 || z < -1e-4) {
          throw new Error(`${name} / ${partName}: point (${x}, ${y}, ${z}) is off its ${width} x ${depth} bed`);
        }
        bottom = Math.min(bottom, z);
      }
      const triangles = findAll(child(mesh, 'triangles')!, 'triangle').map((t) => ({
        points: [points[Number(t.attrs.v1)], points[Number(t.attrs.v2)], points[Number(t.attrs.v3)]] as [Point, Point, Point],
        colour: palette[paintId(t.attrs.paint_color, extruder) - 1],
      }));
      if (parts.has(partName)) throw new Error(`${name} has two parts named ${partName}`);
      parts.set(partName, triangles);
    }
    result.set(name, parts);
  });
  return { plates: result, palette, printer: project.printer_settings_id, bed: [width, depth], bottom };
}

function centre(points: Point[]): Point {
  return [0, 1, 2].map((i) => (points[0][i] + points[1][i] + points[2][i]) / 3) as Point;
}

// Bambu may reorder faces and re-round coordinates to float32, but must keep
// every triangle's position and colour.
function compare(before: Project, after: Project): void {
  const same = (a: unknown, b: unknown, what: string) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} changed: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  };
  same(before.palette, after.palette, 'Filament colours');
  same(before.printer, after.printer, 'Printer preset');
  same(before.bed, after.bed, 'Bed');
  same([...before.plates.keys()], [...after.plates.keys()], 'Plates');
  if (Math.abs(after.bottom) > 1e-4) throw new Error(`The lowest point is at z = ${after.bottom}, not on the bed`);
  for (const [plateName, parts] of before.plates) {
    const other = after.plates.get(plateName)!;
    same([...parts.keys()].sort(), [...other.keys()].sort(), `${plateName} parts`);
    for (const [partName, triangles] of parts) {
      const theirs = other.get(partName)!;
      if (triangles.length !== theirs.length) throw new Error(`${plateName} / ${partName}: ${triangles.length} -> ${theirs.length} triangles`);
      const remaining = theirs.map((t) => ({ c: centre(t.points), colour: t.colour }));
      for (const t of triangles) {
        const expected = centre(t.points);
        const i = remaining.findIndex((r) => r.colour === t.colour && r.c.every((v, k) => Math.abs(v - expected[k]) < 1e-3));
        if (i < 0) throw new Error(`${plateName} / ${partName}: no ${t.colour} triangle at ${expected.map((v) => v.toFixed(4)).join(', ')}`);
        remaining.splice(i, 1);
      }
      for (let axis = 0; axis < 3; axis++) {
        const a = triangles.flatMap((t) => t.points.map((p) => p[axis]));
        const b = theirs.flatMap((t) => t.points.map((p) => p[axis]));
        if (Math.abs(Math.min(...a) - Math.min(...b)) > 1e-4 || Math.abs(Math.max(...a) - Math.max(...b)) > 1e-4) {
          throw new Error(`${plateName} / ${partName}: bounds moved on axis ${'xyz'[axis]}`);
        }
      }
    }
  }
}

// Plain 3MF (generic or PrusaSlicer): every object's world-space bounds and triangle count.
function readPlain(path: string): { objects: number; triangles: number; bounds: number[] } {
  const files = unzipSync(readFileSync(path));
  const roots = new Map<string, XmlNode>();
  for (const name of Object.keys(files)) if (name.endsWith('.model')) roots.set(name, parseXml(strFromU8(files[name])));
  const model = child(roots.get(MODEL)!, 'model')!;
  const lookup = (pathName: string, id: string) => findAll(roots.get(pathName)!, 'object').find((o) => o.attrs.id === id)!;
  let triangles = 0;
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const visit = (object: XmlNode, pathName: string, apply: (p: Point) => Point) => {
    const mesh = child(object, 'mesh');
    if (mesh) {
      for (const v of findAll(child(mesh, 'vertices')!, 'vertex')) {
        const p = apply([Number(v.attrs.x), Number(v.attrs.y), Number(v.attrs.z)]);
        for (let k = 0; k < 3; k++) {
          bounds[k] = Math.min(bounds[k], p[k]);
          bounds[k + 3] = Math.max(bounds[k + 3], p[k]);
        }
      }
      triangles += findAll(child(mesh, 'triangles')!, 'triangle').length;
    }
    for (const c of findAll(object, 'component')) {
      const next = (c.attrs['p:path'] ?? `/${pathName}`).replace(/^\//, '');
      visit(lookup(next, c.attrs.objectid), next, (p) => apply(transform(p, c.attrs.transform)));
    }
  };
  const items = findAll(child(model, 'build')!, 'item');
  for (const item of items) visit(lookup(MODEL, item.attrs.objectid), MODEL, (p) => transform(p, item.attrs.transform));
  return { objects: items.length, triangles, bounds };
}

// ------------------------------------------------------------------ running slicers

// One Windows command-line argument, quoted the way CommandLineToArgvW reads it.
function quoteArg(arg: string): string {
  if (arg && !/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/(\*)"/g, '$1$1\\"').replace(/(\+)$/, '$1$1')}"`;
}

const sleep = (ms: number) => new Promise((wake) => setTimeout(wake, ms));

function alive(pid: number): boolean {
  try {
    return execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }).includes(`"${pid}"`);
  } catch {
    return false;
  }
}

// taskkill cannot stop a process stuck on its way out ("no running instance"),
// which Bambu Studio sometimes is. WMI's Terminate can.
function stop(pid: number): void {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch {
    // Already gone, or needs WMI below.
  }
  if (!alive(pid)) return;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Invoke-CimMethod -MethodName Terminate | Out-Null`],
    { windowsHide: true, stdio: 'ignore' });
  } catch {
    // Reported by the final process check.
  }
}

interface RunResult {
  code: number;
  /** The slicer saved its result but did not exit, and was stopped. */
  hung: boolean;
}

// Runs a slicer with Windows error dialogs off (SetErrorMode is inherited by
// the child), so a crash is reported rather than left on screen. PowerShell's
// call operator does not wait for GUI programs, so the slicer is started with
// Start-Process and its PID written to a file, so it can be stopped by itself
// if it hangs. Output goes to files: a GUI program only writes to standard
// handles it is given.
async function run(exe: string, args: string[], cwd: string, log: string, result: string): Promise<RunResult> {
  const pidFile = `${log}.pid`;
  rmSync(pidFile, { force: true });
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -Namespace Jcm -Name Native -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetErrorMode(uint mode);'",
    '[void][Jcm.Native]::SetErrorMode(0x8003)',
    '$slicer = Start-Process -FilePath $env:JCM_EXE -ArgumentList $env:JCM_ARGS -NoNewWindow -PassThru ' +
      '-RedirectStandardOutput $env:JCM_LOG -RedirectStandardError "$($env:JCM_LOG).err"',
    // Keeps the exit code readable after the process ends.
    '$null = $slicer.Handle',
    'Set-Content -Path $env:JCM_PIDFILE -Value $slicer.Id',
    '$slicer.WaitForExit()',
    'exit $slicer.ExitCode',
  ].join('; ');
  const wrapper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, JCM_EXE: exe, JCM_ARGS: args.map(quoteArg).join(' '), JCM_LOG: log, JCM_PIDFILE: pidFile },
  });
  let exitCode: number | null = null;
  let failure: Error | null = null;
  wrapper.on('exit', (code) => (exitCode = code ?? -1));
  wrapper.on('error', (error) => (failure = error));
  const started = Date.now();
  let savedAt = 0;
  let pid = 0;
  for (;;) {
    await sleep(250);
    if (failure) throw failure;
    if (exitCode !== null) return { code: exitCode, hung: false };
    try {
      pid ||= Number(readFileSync(pidFile, 'utf8').trim()) || 0;
    } catch {
      // Not written yet, or still being written.
    }
    if (!savedAt && existsSync(result)) savedAt = Date.now();
    const hung = savedAt > 0 && Date.now() - savedAt > HANG_MS;
    if (hung || Date.now() - started > TIMEOUT_MS) {
      if (pid) stop(pid);
      stop(wrapper.pid!);
      if (hung) return { code: 0, hung: true };
      throw new Error(`did not finish in ${TIMEOUT_MS / 1000} s and was stopped`);
    }
  }
}

// --arrange 0 and --orient 0 keep every placement as written.
async function resave(exe: string, dataDir: string, folder: string, source: string, name: string, notes: string[]): Promise<string> {
  const output = join(folder, `${name}.3mf`);
  const result = join(folder, 'result.json');
  const log = join(folder, `${name}.log`);
  rmSync(output, { force: true });
  rmSync(result, { force: true });
  const args = ['--datadir', dataDir, '--arrange', '0', '--orient', '0', '--export-3mf', `${name}.3mf`, '--outputdir', folder, source];
  const { code, hung } = await run(exe, args, folder, log, result);
  const status = existsSync(result) ? JSON.parse(readFileSync(result, 'utf8')) : null;
  if (code !== 0 || !existsSync(output) || (status && status.return_code !== 0)) {
    const crashed = code === 3221225477 || code === -1073741819;
    const reason = status?.error_string ?? (crashed ? 'crashed (access violation)' : `exit code ${code}`);
    const logged = lastError(log);
    throw new Error(`${reason}${logged ? `, log: ${logged}` : ''}`);
  }
  if (hung) notes.push(`${name}: saved, then did not exit for ${HANG_MS / 1000} s and was stopped`);
  return output;
}

function lastError(log: string): string {
  const all = [log, `${log}.err`].filter(existsSync).flatMap((file) => readFileSync(file, 'utf8').split(/\r?\n/));
  const tagged = all.filter((line) => line.includes('[error]'));
  const lines = tagged.length ? tagged : all.filter((line) => /error/i.test(line));
  return (lines.at(-1) ?? '').replace(/^\[[^\]]*\]\s*\[[^\]]*\]\s*\[error\]\s*/, '').trim();
}

// Slicer processes started for this check, found by the folder in their command line.
function leftovers(folder: string): number[] {
  const images = ['bambu-studio.exe', 'orca-slicer.exe'].map((name) => `Name = '${name}'`).join(' OR ');
  const needle = folder.replace(/'/g, "''");
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "${images}" | Where-Object { $_.CommandLine -like '*${needle}*' } | ForEach-Object { $_.ProcessId }`],
    { encoding: 'utf8', windowsHide: true });
    return out.split(/\r?\n/).map(Number).filter((pid) => pid > 0);
  } catch {
    return [];
  }
}

async function main() {
  const bambu = resolve(option('--bambu') ?? 'C:/Program Files/Bambu Studio/bambu-studio.exe');
  const orcaDefault = 'C:/Program Files/OrcaSlicer/orca-slicer.exe';
  const orca = option('--orca') ?? (existsSync(orcaDefault) ? orcaDefault : undefined);
  const folder = resolve(option('--folder') ?? mkdtempSync(join(tmpdir(), 'jcm-check-bambu-')));
  mkdirSync(folder, { recursive: true });
  if (!existsSync(bambu)) throw new Error(`Bambu Studio not found at ${bambu}. Pass --bambu <exe>.`);
  console.log(`Folder ${folder}`);
  let failures = 0;
  const notes: string[] = [];
  const report = (ok: boolean, line: string) => {
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${line}`);
  };

  const bambuData = join(folder, 'bambu-data');
  for (const fixture of fixtures()) {
    const exported = exportFixture(fixture, 'bambu');
    const source = join(folder, `${fixture.name}.3mf`);
    writeFileSync(source, exported.data);
    try {
      const expected = readProject(source);
      const saved = await resave(bambu, bambuData, folder, source, `${fixture.name}-saved`, notes);
      compare(expected, readProject(saved));
      const reopened = await resave(bambu, bambuData, folder, saved, `${fixture.name}-reopened`, notes);
      compare(expected, readProject(reopened));
      const triangles = [...expected.plates.values()].flatMap((p) => [...p.values()]).reduce((s, t) => s + t.length, 0);
      report(true, `bambu ${fixture.name}: ${expected.plates.size} plate(s), ${expected.palette.length} filaments, ${triangles} triangles, ${expected.printer}, ${expected.bed.join(' x ')} mm bed`);
    } catch (error) {
      report(false, `bambu ${fixture.name}: ${(error as Error).message}`);
    }
    for (const warning of exported.warnings) console.log(`     note: ${warning}`);
  }

  // The other 3MF flavours only need to load: same objects, triangles and placement.
  for (const [format, fixture] of [['3mf', fixtures()[1]], ['prusa', fixtures()[1]], ['3mf', fixtures()[0]], ['prusa', fixtures()[0]]] as const) {
    const name = `${fixture.name}-${format === '3mf' ? 'generic' : 'prusa'}`;
    const source = join(folder, `${name}.3mf`);
    writeFileSync(source, exportFixture(fixture, format).data);
    try {
      const before = readPlain(source);
      const after = readPlain(await resave(bambu, bambuData, folder, source, `${name}-bambu`, notes));
      const moved = before.bounds.some((v, i) => Math.abs(v - after.bounds[i]) > 1e-3);
      const ok = before.objects === after.objects && before.triangles === after.triangles && !moved;
      report(ok, `bambu loads ${name}: ${after.objects}/${before.objects} objects, ${after.triangles}/${before.triangles} triangles${moved ? ', placement moved' : ''}`);
    } catch (error) {
      report(false, `bambu loads ${name}: ${(error as Error).message}`);
    }
  }

  if (orca) {
    const orcaData = join(folder, 'orca-data');
    for (const [label, file] of [['bambu project', 'single-p1s.3mf'], ['generic 3MF', 'single-p1s-generic.3mf'], ['PrusaSlicer 3MF', 'single-p1s-prusa.3mf']]) {
      try {
        const out = await resave(orca, orcaData, folder, join(folder, file), `${file.replace('.3mf', '')}-orca`, notes);
        const loaded = readPlain(out);
        console.log(`INFO orca ${label}: loaded, ${loaded.objects} object(s), ${loaded.triangles} triangles`);
      } catch (error) {
        console.log(`INFO orca ${label}: ${(error as Error).message}`);
      }
    }
  }

  for (const note of notes) console.log(`NOTE ${note}`);
  const left = leftovers(folder);
  for (const pid of left) stop(pid);
  if (left.length) report(false, `${left.length} slicer process(es) were still running and have been stopped`);
  console.log(failures ? `BAMBU_CHECK_FAILED ${failures}` : 'BAMBU_CHECK_OK');
  process.exitCode = failures ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
