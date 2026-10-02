import { Copy, Crosshair, Eraser, Plus, RotateCcw, Route, Search, Spline, Trash2, TriangleAlert, Undo2, X } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { parseRoadKey, roadEditOf, roadSegment } from '../../../core/edit/blocks';
import { editOf, isPartKey, kindOf, objectOf, partKey, shapeKey, twinOf } from '../../../core/edit/keys';
import { buildingHeightRange, EDIT_LIMITS, editCount, followsGround, MAX_TEXT_LENGTH, type AddedShape, type EditLayer, type ModelEdits } from '../../../core/edit/types';
import { Projection } from '../../../core/geo/projection';
import { COLOUR_GROUPS } from '../../../core/settings';
import { FONTS } from '../../../core/svgmap/text/fonts';
import type { ColourGroup } from '../../../core/types';
import { Checkbox } from '../../components/Checkbox';
import { ConfirmButton } from '../../components/ConfirmButton';
import { NumberInput } from '../../components/NumberField';
import { COARSE_QUERY, useMediaQuery } from '../../lib/browser';
import { formatNumber } from '../../lib/format';
import {
  addLayer,
  clearEdits,
  clearEditsFor,
  deleteLayer,
  deletePoint,
  duplicateShapes,
  patchObjects,
  removeObjects,
  resetObjects,
  restoreObjects,
  setSelection,
  settleEdits,
  takeCreatedShape,
  updateLayer,
  updateShape,
  updateShapes,
} from '../../state/editActions';
import { getEditData, type EditData } from '../../state/model';
import { useApp } from '../../state/store';
import { FilamentPopover } from '../../panels/ColourPopover';
import { describeCounts, describeKey, roadClassName } from './describe';
import { appliedRoadEdit } from '../blocks';
import { BackupNote } from '../../components/BackupNote';

const NEW_LAYER = '__new';
const MIXED = '__mixed';
const NOZZLE_MM = 0.4;
// A tower can be mapped in dozens of parts.
const PARTS_SHOWN = 6;

export interface InspectorProps {
  /** How tall a building or part is now, as shown. */
  heightOf: (key: string) => number | null;
  /** The whole street a road is part of. */
  streetOf: (key: string) => string[];
  /** Puts drawn roads in place of these roads, to reshape. */
  makeDrawn: (keys: string[]) => void;
  focus: () => void;
  /** Highlights something in the view while the pointer is over its row, or nothing. */
  preview: (key: string | null) => void;
  /** Selects things and turns the view to them. */
  focusOn: (keys: string[]) => void;
}

export function Inspector(props: InspectorProps) {
  const selection = useApp((state) => state.ui.selection);
  const edits = useApp((state) => state.edits);
  // Object facts change with the model.
  useApp((state) => state.generation.result?.version);
  const data = getEditData();
  return (
    <section className="viewer-card floating inspector" aria-label="Edit">
      {selection.length ? <SelectionPanel keys={selection} edits={edits} data={data} {...props} /> : <Overview edits={edits} data={data} focusOn={props.focusOn} />}
    </section>
  );
}

// ------------------------------------------------------------- selection

function SelectionPanel({ keys, edits, data, heightOf, streetOf, makeDrawn, focus, preview }: InspectorProps & { keys: string[]; edits: ModelEdits; data: EditData }) {
  const single = keys.length === 1 ? describeKey(keys[0], data, edits) : null;
  const kinds = new Set(keys.map((key) => kindOf(key)));
  const coarse = useMediaQuery(COARSE_QUERY);
  const shapes = keys.filter((key) => kindOf(key) === 'shape');
  const objects = keys.filter((key) => kindOf(key) !== 'shape');
  return (
    <>
      <header className="viewer-card-header inspector-header">
        <div className="inspector-title">
          <h3>{single ? single.title : describeCounts(keys)}</h3>
          {single?.detail && <div className="inspector-sub">{single.detail}</div>}
        </div>
        <span className="inspector-header-actions">
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Look at the selection (F)" title="Look at the selection (F)" onClick={focus}>
            <Crosshair size={14} aria-hidden="true" />
          </button>
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Clear the selection (Esc)" title="Clear the selection (Esc)" onClick={() => setSelection([])}>
            <X size={14} aria-hidden="true" />
          </button>
        </span>
      </header>
      <div className="inspector-body">
        {shapes.length > 0 && objects.length === 0 ? (
          <ShapeControls keys={shapes} edits={edits} data={data} />
        ) : (
          <ObjectControls keys={objects} kinds={kinds} edits={edits} data={data} heightOf={heightOf} streetOf={streetOf} makeDrawn={makeDrawn} preview={preview} />
        )}
      </div>
      {!coarse && (
        <footer className="viewer-card-footer inspector-footer">
          <span>Shift-click adds to the selection. Shift-drag selects in a box.</span>
        </footer>
      )}
    </>
  );
}

function ObjectControls({
  keys,
  kinds,
  edits,
  data,
  heightOf,
  streetOf,
  makeDrawn,
  preview,
}: {
  keys: string[];
  kinds: Set<string | null>;
  edits: ModelEdits;
  data: EditData;
  heightOf: InspectorProps['heightOf'];
  streetOf: InspectorProps['streetOf'];
  makeDrawn: InspectorProps['makeDrawn'];
  preview: InspectorProps['preview'];
}) {
  // A road on a divided road's merged line shows the other carriageway's edits it carries too.
  const applied = (key: string) => (kindOf(key) === 'road' ? appliedRoadEdit(edits, key, data.roads) : editOf(edits, key, data.objects[key]?.at));
  const allRemoved = keys.every((key) => applied(key)?.removed);
  const layers = new Set(keys.map((key) => applied(key)?.layer ?? ''));
  const layer = layers.size === 1 ? [...layers][0] : MIXED;
  // Once per change of the edits, not every render: each key against every
  // edit took 2.6 s a hover with thousands of both.
  const editedKeys = useMemo(() => new Set(Object.keys(edits.objects).flatMap((k) => [k, objectOf(k)])), [edits.objects]);
  // A block of a road is edited when an edit of its own road reaches it. What
  // it carries from the other carriageway isn't, since Reset can't clear that.
  const edited = keys.some((key) => editedKeys.has(key) || (kindOf(key) === 'road' && Object.keys(roadEditOf(edits.objects, key) ?? {}).length > 0));
  const only = (kind: string) => kinds.size === 1 && kinds.has(kind);
  const streets = [...kinds].every((kind) => kind === 'road' || kind === 'bridge');
  const tag = keys.join(',');
  const water = kinds.has('water');
  const building = only('building') && keys.length === 1 ? keys[0] : null;
  const recessed = keys.filter((key) => kindOf(key) === 'water' && data.objects[key]?.recessed);
  // A bridge on a selected road goes, widens and changes colour with it, when it's in the block.
  const bridges = keys.filter((key) => {
    const twin = twinOf(key);
    const at = twin ? data.objects[twin]?.at : undefined;
    const range = parseRoadKey(key);
    if (kindOf(key) !== 'road' || !twin || !data.objects[twin] || keys.includes(twin) || !range) return false;
    return at === undefined ? range.from <= 0 && range.to >= 1 : at >= range.from && at <= range.to;
  });
  const roads = only('road');
  const blocks = keys.some((key) => key.includes('@'));

  return (
    <>
      {only('building') && <BuildingHeight keys={keys} edits={edits} data={data} heightOf={heightOf} tag={tag} />}
      {streets && <RoadSize keys={keys} edits={edits} data={data} tag={tag} />}
      <LayerField
        label="Colour"
        value={layer}
        groups={false}
        onChange={(value) => patchObjects(keys, { layer: value || undefined })}
        help="Put it in a custom layer of its own colour. Everything in a layer exports as one part with its own filament."
      />
      {allRemoved && recessed.length > 0 && (
        <>
          <CheckRow
            label="Keep the hollow"
            checked={recessed.every((key) => edits.objects[key]?.hollow)}
            onChange={(hollow) => patchObjects(recessed, { hollow: hollow || undefined })}
          />
          <p className="inspector-hint">Off, the ground is built up to its banks where the water was. On, the recess stays, to fill with resin or paint after printing.</p>
        </>
      )}
      <div className="inspector-actions">
        {allRemoved ? (
          <button type="button" className="btn btn-sm" onClick={() => restoreObjects(keys)}>
            <Undo2 size={14} aria-hidden="true" />
            Put back
          </button>
        ) : (
          <button type="button" className="btn btn-sm" onClick={() => removeObjects(keys)} title="Delete">
            <Trash2 size={14} aria-hidden="true" />
            {water && only('water') ? 'Leave out' : 'Remove'}
          </button>
        )}
        {streets && (
          <button type="button" className="btn btn-sm" onClick={() => setSelection([...new Set(keys.flatMap(streetOf))])} title="Select every connected piece with the same name">
            <Route size={14} aria-hidden="true" />
            Whole street
          </button>
        )}
        {roads && !allRemoved && (
          <button type="button" className="btn btn-sm" onClick={() => makeDrawn(keys)} title="Put a drawn road in its place along the same line, to reshape point by point">
            <Spline size={14} aria-hidden="true" />
            Make it a drawn road
          </button>
        )}
        {edited && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => resetObjects(keys)} title="Undo every change to the selection">
            <RotateCcw size={14} aria-hidden="true" />
            Reset
          </button>
        )}
      </div>
      {bridges.length > 0 && <p className="inspector-hint">{keys.length === 1 ? 'Its bridge changes with it.' : 'Bridges on these roads change with them.'}</p>}
      {roads && blocks && (
        <p className="inspector-hint">
          A click picks one block, between junctions. Whole street takes all of it, and Split a road (X) ends a block somewhere else.
        </p>
      )}
      {building && <BuildingParts key={building} buildingKey={building} data={data} preview={preview} />}
    </>
  );
}

/** A building's parts to pick one of, or, for a part, the way back to its building. */
function BuildingParts({ buildingKey, data, preview }: { buildingKey: string; data: EditData; preview: InspectorProps['preview'] }) {
  const object = objectOf(buildingKey);
  const parts = data.objects[object]?.parts;
  const [all, setAll] = useState(false);
  // The highlight follows the pointer, so it goes with the list.
  useEffect(() => () => preview(null), [preview]);
  if (isPartKey(buildingKey)) {
    return (
      <p className="inspector-hint">
        One part of a building.{' '}
        <button type="button" className="link-btn" onClick={() => setSelection([object])}>
          Select the whole building
        </button>
      </p>
    );
  }
  if (!parts?.length) return null;
  const shown = all || parts.length <= PARTS_SHOWN + 2 ? parts : parts.slice(0, PARTS_SHOWN);
  return (
    <div className="inspector-parts">
      <div className="inspector-section-head">
        <span>Parts</span>
        {shown.length < parts.length && (
          <button type="button" className="link-btn" onClick={() => setAll(true)}>
            Show all {parts.length}
          </button>
        )}
      </div>
      <ul className="parts-pick-list">
        {shown.map((part, i) => {
          const key = partKey(object, part.sub);
          return (
            <li key={part.sub}>
              <button
                type="button"
                className="parts-pick"
                onClick={() => setSelection([key])}
                onPointerEnter={() => preview(key)}
                onPointerLeave={() => preview(null)}
                onFocus={() => preview(key)}
                onBlur={() => preview(null)}
              >
                <span>{i === 0 ? 'Tallest part' : `Part ${i + 1}`}</span>
                <span className="parts-pick-height">{formatNumber(part.heightMm, 1)} mm</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function BuildingHeight({ keys, edits, data, heightOf, tag }: { keys: string[]; edits: ModelEdits; data: EditData; heightOf: InspectorProps['heightOf']; tag: string }) {
  // Edits are kept in real metres, shown as printed.
  const scale = data.frame?.buildingMmPerMetre ?? 0.077;
  const heights = keys.map((key) => {
    const metres = edits.objects[key]?.heightM;
    return metres !== undefined ? metres * scale : (heightOf(key) ?? data.objects[objectOf(key)]?.heightMm ?? null);
  });
  const known = heights.filter((h): h is number => h !== null);
  if (!known.length) return null;
  const same = known.every((h) => Math.abs(h - known[0]) < 0.005);
  const value = same ? known[0] : Math.max(...known);
  const edited = keys.some((key) => edits.objects[key]?.heightM !== undefined);
  const metres = value / scale;
  return (
    <NumberRow
      label={same ? 'Height' : 'Height (all)'}
      value={value}
      min={buildingHeightRange(scale)[0]}
      max={buildingHeightRange(scale)[1]}
      step={0.5}
      unit="mm"
      hint={`About ${formatNumber(metres, metres < 20 ? 1 : 0)} m in real life${edited ? '' : ', as mapped'}. Drag the arrow on top to change it.`}
      onChange={(mm) => patchObjects(keys, { heightM: mm / scale }, `height:${tag}`)}
      reset={edited ? () => patchObjects(keys, { heightM: undefined }) : undefined}
    />
  );
}

/** Width for roads and bridge decks, height for roads. */
function RoadSize({ keys, edits, data, tag }: { keys: string[]; edits: ModelEdits; data: EditData; tag: string }) {
  const lines = data.roads;
  const roads = keys.filter((key) => kindOf(key) === 'road');
  // As it applies, the other carriageway's included on a merged divided road, and as it was set, for Reset.
  const applied = (key: string) => (kindOf(key) === 'road' ? appliedRoadEdit(edits, key, lines) : editOf(edits, key, data.objects[key]?.at));
  const own = (key: string) => (kindOf(key) === 'road' ? roadEditOf(edits.objects, key) : editOf(edits, key, data.objects[key]?.at));
  const widthOf = (key: string) => {
    const edited = applied(key)?.widthMm;
    if (edited !== undefined) return edited;
    if (kindOf(key) === 'bridge') return data.objects[key]?.widthMm ?? 0.5;
    const piece = lines ? lines.keys.indexOf(roadSegment(key)) : -1;
    return piece >= 0 ? lines!.widths[piece] : 0.5;
  };
  const widths = keys.map(widthOf);
  const heights = roads.map((key) => applied(key)?.heightMm ?? lines?.thicknessMm ?? 0);
  const sameWidth = widths.every((w) => Math.abs(w - widths[0]) < 0.005);
  const sameHeight = heights.every((h) => Math.abs(h - heights[0]) < 0.005);
  const widthEdited = keys.some((key) => own(key)?.widthMm !== undefined);
  const heightEdited = roads.some((key) => own(key)?.heightMm !== undefined);
  const width = sameWidth ? widths[0] : Math.max(...widths);
  if (!widths.length) return null;
  return (
    <>
      <NumberRow
        label={sameWidth ? 'Width' : 'Width (all)'}
        value={width}
        min={EDIT_LIMITS.widthMm[0]}
        max={EDIT_LIMITS.widthMm[1]}
        step={0.1}
        unit="mm"
        hint={Math.min(...widths) < NOZZLE_MM ? `Narrower than a ${NOZZLE_MM} mm nozzle prints well.` : undefined}
        onChange={(widthMm) => patchObjects(keys, { widthMm }, `width:${tag}`)}
        reset={widthEdited ? () => patchObjects(keys, { widthMm: undefined }) : undefined}
      />
      {roads.length > 0 && lines && (
        <NumberRow
          label={sameHeight ? 'Height' : 'Height (all)'}
          value={sameHeight ? heights[0] : Math.max(...heights)}
          min={EDIT_LIMITS.roadHeightMm[0]}
          max={EDIT_LIMITS.roadHeightMm[1]}
          step={0.1}
          unit="mm"
          hint="Above the ground. Raise a route to make it stand out."
          onChange={(heightMm) => patchObjects(roads, { heightMm }, `road-height:${tag}`)}
          reset={heightEdited ? () => patchObjects(roads, { heightMm: undefined }) : undefined}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- shapes

const SIZE_LABELS: Record<AddedShape['kind'], string> = {
  text: 'Letter height',
  box: 'Width',
  cylinder: 'Diameter',
  pin: 'Size',
  path: 'Width',
  area: 'Size',
};

function ShapeControls({ keys, edits, data }: { keys: string[]; edits: ModelEdits; data: EditData }) {
  const coarse = useMediaQuery(COARSE_QUERY);
  const notes = useApp((state) => state.ui.editNotes);
  const activePoint = useApp((state) => state.ui.activePoint);
  const supports = useApp((state) => state.settings.supports);
  const shapes = keys.map((key) => edits.shapes.find((s) => shapeKey(s.id) === key)).filter((s): s is AddedShape => Boolean(s));
  if (!shapes.length) return null;
  const ids = shapes.map((s) => s.id);
  const tag = ids.join(',');
  const layers = new Set(shapes.map((s) => s.layer));
  const heights = new Set(shapes.map((s) => s.heightMm));
  const frameRotation = data.frame?.rotationDeg ?? 0;
  const shape = shapes.length === 1 ? shapes[0] : null;
  const note = shape ? notes[shapeKey(shape.id)] : undefined;
  const drawn = shape?.kind === 'path' || shape?.kind === 'area';
  const point = shape && drawn && activePoint?.shape === shape.id && activePoint.index < shape.points.length ? activePoint.index : null;
  return (
    <>
      {note && (
        <p className="inspector-warning" role="note">
          <TriangleAlert size={13} aria-hidden="true" />
          <span>{note}</span>
        </p>
      )}
      {/* Keyed, so a new text shape selected in place of another still gets its text focused. */}
      {shape?.kind === 'text' && <TextControls key={shape.id} shape={shape} />}
      {shape && shape.kind !== 'area' && (
        <NumberRow
          label={SIZE_LABELS[shape.kind]}
          value={shape.sizeMm}
          min={shape.kind === 'path' ? EDIT_LIMITS.pathWidthMm[0] : EDIT_LIMITS.sizeMm[0]}
          max={shape.kind === 'path' ? EDIT_LIMITS.pathWidthMm[1] : EDIT_LIMITS.sizeMm[1]}
          step={shape.kind === 'path' ? 0.1 : 0.5}
          unit="mm"
          onChange={(sizeMm) => updateShape(shape.id, { sizeMm }, `size:${shape.id}`)}
        />
      )}
      {shape?.kind === 'box' && (
        <NumberRow
          label="Depth"
          value={shape.depthMm}
          min={EDIT_LIMITS.depthMm[0]}
          max={EDIT_LIMITS.depthMm[1]}
          step={0.5}
          unit="mm"
          onChange={(depthMm) => updateShape(shape.id, { depthMm }, `depth:${shape.id}`)}
        />
      )}
      <NumberRow
        label={heights.size === 1 ? 'Height' : 'Height (all)'}
        value={Math.max(...shapes.map((s) => s.heightMm))}
        min={EDIT_LIMITS.shapeHeightMm[0]}
        max={EDIT_LIMITS.shapeHeightMm[1]}
        step={0.1}
        unit="mm"
        hint={shape && followsGround(shape) ? 'Above the ground or water under it.' : 'Above the highest ground or water under it.'}
        onChange={(heightMm) => updateShapes(ids, { heightMm }, `shape-height:${tag}`)}
      />
      {shape && (
        <NumberRow
          label="Raised by"
          value={shape.liftMm}
          min={EDIT_LIMITS.liftMm[0]}
          max={EDIT_LIMITS.liftMm[1]}
          step={0.5}
          unit="mm"
          hint="Stands it on a roof or a bridge, and it moves with them. It's built down to whatever is under it, so it never floats."
          onChange={(liftMm) => updateShape(shape.id, { liftMm }, `lift:${shape.id}`)}
        />
      )}
      {shape && !drawn && (
        <NumberRow
          label="Rotation"
          value={normaliseAngle(shape.rotationDeg - frameRotation)}
          min={-180}
          max={180}
          step={5}
          unit="°"
          decimals={1}
          hint={coarse ? "From the model's up." : "From the model's up. [ and ] turn it by 15°."}
          onChange={(turn) => updateShape(shape.id, { rotationDeg: (((turn + frameRotation) % 360) + 360) % 360 }, `rotate:${shape.id}`)}
        />
      )}
      {shape && (
        <CheckRow
          label="Follow the ground"
          checked={followsGround(shape)}
          disabled={shape.liftMm > 0}
          onChange={(followGround) => updateShape(shape.id, { followGround })}
          help={shape.liftMm > 0 ? 'A raised shape has a flat top, so it stands on what it was raised onto.' : 'The top follows the terrain under it. Off, the top is flat.'}
        />
      )}
      <LayerField label="Colour" value={layers.size === 1 ? [...layers][0] : MIXED} groups onChange={(layer) => updateShapes(ids, { layer })} />
      {shape && point !== null && (
        <div className="inspector-point">
          <span>
            Point {point + 1} of {shape.points.length}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => deletePoint(shape.id, point)} disabled={shape.points.length <= (shape.kind === 'area' ? 3 : 2)}>
            <Trash2 size={14} aria-hidden="true" />
            Delete point
          </button>
        </div>
      )}
      <div className="inspector-actions">
        <button type="button" className="btn btn-sm" onClick={() => duplicateShapes(ids)} title="Duplicate (Ctrl+D)">
          <Copy size={14} aria-hidden="true" />
          Duplicate
        </button>
        <button type="button" className="btn btn-sm" onClick={() => removeObjects(keys)} title="Delete">
          <Trash2 size={14} aria-hidden="true" />
          Delete
        </button>
      </div>
      {shape?.kind === 'area' && (
        <p className="inspector-hint">
          A building in the Buildings colour, or keep it low in a colour like Parks or Paved for a park or a square.
          {supports ? " In water it stands on a strip of ground, like the model's own buildings." : " In water it's built down through it, like the model's own buildings."}
        </p>
      )}
      {shape?.kind === 'path' && (
        <p className="inspector-hint">
          A road in the Roads colour, or put it in a custom layer for a route of its own.
          {supports ? " In water it stands on a strip of ground, like the model's own roads." : " In water it's built down through it, like the model's own roads."}
        </p>
      )}
      {shape && drawn && (
        <p className="inspector-hint">
          {coarse
            ? 'Drag a point to move it, or a white dot to add one. Tap a point to delete it.'
            : 'Drag a point to move it, or a white dot to add one. Click a point, then Delete, to take it out.'}
        </p>
      )}
      {shape && !drawn && <p className="inspector-hint">Drag it to move it, or its arrow to change its height. Looking straight down, there's no arrow.</p>}
    </>
  );
}

function normaliseAngle(degrees: number): number {
  const a = ((((degrees + 180) % 360) + 360) % 360) - 180;
  return Math.round(a * 10) / 10;
}

function TextControls({ shape }: { shape: AddedShape }) {
  const id = useId();
  const fontId = useId();
  const [fresh] = useState(() => takeCreatedShape(shape.id));
  const outline = FONTS.filter((font) => font.kind === 'outline');
  const stroke = FONTS.filter((font) => font.kind === 'stroke');
  return (
    <>
      <div className="field field-stacked">
        <label className="field-label" htmlFor={id}>
          Text
        </label>
        <input
          id={id}
          className="text-input"
          value={shape.text}
          maxLength={MAX_TEXT_LENGTH}
          spellCheck={false}
          autoFocus={fresh}
          onFocus={(event) => fresh && event.currentTarget.select()}
          onChange={(event) => updateShape(shape.id, { text: event.target.value }, `text:${shape.id}`)}
          onBlur={settleEdits}
          // Back to the model, where the shortcuts work again.
          onKeyDown={(event) => (event.key === 'Escape' || event.key === 'Enter') && event.currentTarget.blur()}
        />
      </div>
      <div className="field">
        <div className="field-row">
          <label className="field-label" htmlFor={fontId}>
            Font
          </label>
          <select id={fontId} className="select" value={shape.font} onChange={(event) => updateShape(shape.id, { font: event.target.value })}>
            <optgroup label="Solid letters">
              {outline.map((font) => (
                <option key={font.id} value={font.id}>
                  {font.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Single-line">
              {stroke.map((font) => (
                <option key={font.id} value={font.id}>
                  {font.name}
                </option>
              ))}
            </optgroup>
          </select>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- fields

function NumberRow({
  label,
  value,
  min,
  max,
  step,
  unit,
  hint,
  decimals = 2,
  onChange,
  reset,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  hint?: string;
  decimals?: number;
  onChange: (value: number) => void;
  reset?: () => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <div className="field-row">
        <label className="field-label" htmlFor={id}>
          {label}
        </label>
        <span className="inspector-number" onBlur={settleEdits}>
          {reset && (
            <button type="button" className="icon-btn icon-btn-sm" aria-label={`Put the ${label.toLowerCase()} back`} title="As generated" onClick={reset}>
              <RotateCcw size={12} aria-hidden="true" />
            </button>
          )}
          <NumberInput id={id} value={value} min={min} max={max} step={step} unit={unit} decimals={decimals} width={96} onChange={onChange} />
        </span>
      </div>
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

function CheckRow({
  label,
  checked,
  onChange,
  help,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  help?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="field check-field">
      <label className="check-label" htmlFor={id} title={help}>
        <Checkbox id={id} checked={checked} onChange={onChange} disabled={disabled} />
        {label}
      </label>
    </div>
  );
}

/** A custom layer (or, for shapes, a colour of the model) to put things in. */
function LayerField({ label, value, groups, onChange, help }: { label: string; value: string; groups: boolean; onChange: (value: string) => void; help?: string }) {
  const layers = useApp((state) => state.edits.layers);
  const palette = useApp((state) => state.palette);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const id = useId();
  const layer = layers.find((l) => l.id === value);
  const groupHex = groups && value !== MIXED ? palette[value as ColourGroup]?.hex : undefined;
  const swatch = layer?.hex ?? groupHex;
  return (
    <div className="field">
      <div className="field-row">
        <label className="field-label" htmlFor={id} title={help}>
          {label}
        </label>
        <span className="layer-field">
          {layer ? (
            <button
              ref={setAnchor}
              type="button"
              className="swatch swatch-btn-inline"
              style={{ background: layer.hex }}
              aria-label={`Change the colour of ${layer.name}`}
              title="Change the layer's colour"
              onClick={() => setOpen(true)}
            />
          ) : (
            swatch && <span className="swatch" style={{ background: swatch }} aria-hidden="true" />
          )}
          <select
            id={id}
            className="select"
            value={value}
            onChange={(event) => {
              const next = event.target.value;
              if (next === MIXED) return;
              if (next === NEW_LAYER) {
                const created = addLayer();
                if (created) onChange(created);
                return;
              }
              onChange(next);
            }}
          >
            {value === MIXED && <option value={MIXED}>Mixed</option>}
            {!groups && <option value="">Its own colour</option>}
            {layers.length > 0 && (
              <optgroup label="Custom layers">
                {layers.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </optgroup>
            )}
            {groups && (
              <optgroup label="Model colours">
                {COLOUR_GROUPS.filter((g) => g.key !== 'rim').map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.label}
                  </option>
                ))}
              </optgroup>
            )}
            <option value={NEW_LAYER}>New layer…</option>
          </select>
        </span>
      </div>
      {open && layer && (
        <FilamentPopover
          title={layer.name}
          entry={layer}
          anchor={anchor}
          placement="left-start"
          onChange={(entry) => updateLayer(layer.id, entry, `colour:${layer.id}`)}
          onClose={() => {
            setOpen(false);
            settleEdits();
          }}
        />
      )}
    </div>
  );
}

// -------------------------------------------------------------- overview

/** Whether an edit's key is in the model shown, so edits made on another area can be told apart. */
function inModel(key: string, data: EditData): boolean {
  // A carriageway merged onto the other's line has none of its own, but its edits still carry.
  if (kindOf(key) === 'road') return (data.roads?.keys.includes(roadSegment(key)) || data.roads?.partners?.includes(roadSegment(key))) ?? false;
  if (kindOf(key) === 'tree') return true;
  return objectOf(key) in data.objects;
}

/** Added shapes with nothing of them on this model, like ones placed on another area. */
function shapesOutside(edits: ModelEdits, data: EditData, bounds: readonly number[] | undefined): string[] {
  if (!data.frame || !bounds) return [];
  const projection = new Projection(data.frame.center, data.frame.rotationDeg, data.frame.mmPerMetre);
  const inside = ([lon, lat]: [number, number]) => {
    const [x, y] = projection.toModel(lon, lat);
    return x >= bounds[0] && x <= bounds[3] && y >= bounds[1] && y <= bounds[4];
  };
  return edits.shapes.filter((shape) => !inside(shape.at) && !shape.points.some(inside)).map((shape) => shapeKey(shape.id));
}

function Overview({ edits, data, focusOn }: { edits: ModelEdits; data: EditData; focusOn: InspectorProps['focusOn'] }) {
  const coarse = useMediaQuery(COARSE_QUERY);
  const bounds = useApp((state) => state.generation.result?.bounds);
  const changes = editCount(edits);
  const removed = Object.entries(edits.objects)
    .filter(([key, edit]) => edit.removed && inModel(key, data))
    .map(([key]) => key);
  const elsewhere = [...Object.keys(edits.objects).filter((key) => !inModel(key, data)), ...shapesOutside(edits, data, bounds)];
  return (
    <>
      <header className="viewer-card-header">
        <h3>
          Edit the model <span className="beta-badge">Beta</span>
        </h3>
      </header>
      <div className="inspector-body">
        {data.editable ? (
          <>
            <FindBox data={data} focusOn={focusOn} />
            <p className="inspector-intro">
              {coarse ? 'Tap a building, road, water or tree to change it.' : 'Click a building, road, water or tree to change it.'} The tool buttons add text, pins
              and shapes, or draw your own roads and buildings.
            </p>
          </>
        ) : (
          <p className="inspector-intro">This model is one surface, so nothing in it can be picked out. You can still add text, pins and shapes with the tool buttons.</p>
        )}
        <Layers edits={edits} />
        {elsewhere.length > 0 && (
          <p className="inspector-note">
            {elsewhere.length} {elsewhere.length === 1 ? 'change is' : 'changes are'} for things this model doesn't have: another area, other settings, or map data
            that has changed since.{' '}
            <button type="button" className="link-btn" onClick={() => clearEditsFor(elsewhere)}>
              Clear {elsewhere.length === 1 ? 'it' : 'them'}
            </button>
          </p>
        )}
        <BackupNote of="edits" />
        <div className="inspector-changes">
          <span>
            {changes ? `${changes} ${changes === 1 ? 'change' : 'changes'}` : 'No changes yet'}
            {removed.length > 0 && (
              <>
                {', '}
                <button type="button" className="link-btn" onClick={() => setSelection(removed)} title="Select what was removed, to put it back">
                  {removed.length} removed
                </button>
              </>
            )}
          </span>
          {(changes > 0 || edits.layers.length > 0) && (
            // Edits are one document for every area, so this reaches past this model.
            <ConfirmButton
              className="link-btn is-danger"
              confirm={`Click again to undo ${changes ? `all ${changes} ${changes === 1 ? 'change' : 'changes'}` : 'your layers'}${elsewhere.length ? `, ${elsewhere.length} of them not on this model` : ''}`}
              onConfirm={clearEdits}
            >
              <Eraser size={12} aria-hidden="true" /> Undo all
            </ConfirmButton>
          )}
        </div>
      </div>
      <footer className="viewer-card-footer inspector-footer">
        <span>Edits stay with this area when you change settings and generate again.</span>
      </footer>
    </>
  );
}

interface Found {
  label: string;
  detail: string;
  keys: string[];
}

const KIND_LABELS: Record<string, [string, string]> = {
  building: ['Building', 'buildings'],
  water: ['Water', 'bodies of water'],
  bridge: ['Bridge', 'bridges'],
  route: ['Route', 'routes'],
};

/** Everything in the model with a name, one entry per name and kind. */
function namedThings(data: EditData): Found[] {
  const groups = new Map<string, Found & { seen: Set<string> }>();
  const add = (label: string, kind: string, detail: (count: number) => string, key: string) => {
    const id = `${kind}\u0001${label}`;
    let found = groups.get(id);
    if (!found) groups.set(id, (found = { label, detail: '', keys: [], seen: new Set() }));
    // Pieces of one road share its key.
    if (found.seen.has(key)) return;
    found.seen.add(key);
    found.keys.push(key);
    found.detail = detail(found.keys.length);
  };
  for (const [key, facts] of Object.entries(data.objects)) {
    const names = KIND_LABELS[facts.kind];
    if (!facts.name || !names) continue;
    add(facts.name, facts.kind, (n) => (n === 1 ? names[0] : `${n} ${names[1]}`), key);
  }
  const lines = data.roads;
  if (lines) {
    lines.names.forEach((name, i) => {
      if (name) add(name, 'road', () => roadClassName(lines.classes[i]), lines.keys[i]);
    });
  }
  return [...groups.values()].map(({ label, detail, keys }) => ({ label, detail, keys }));
}

/** Finds named streets, buildings and water, to select them without hunting in the view. */
function FindBox({ data, focusOn }: { data: EditData; focusOn: InspectorProps['focusOn'] }) {
  const [query, setQuery] = useState('');
  const id = useId();
  const things = useMemo(() => namedThings(data), [data]);
  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (q.length < 2) return [];
    const scored: [number, Found][] = [];
    for (const thing of things) {
      const label = thing.label.toLowerCase();
      const at = label.indexOf(q);
      if (at < 0) continue;
      // Names starting with it first, then ones with a word starting with it.
      const rank = at === 0 ? 0 : label[at - 1] === ' ' ? 1 : 2;
      scored.push([rank * 1000 + label.length, thing]);
    }
    return scored
      .sort((a, b) => a[0] - b[0])
      .slice(0, 8)
      .map(([, thing]) => thing);
  }, [q, things]);
  if (!things.length) return null;
  const pick = (thing: Found) => {
    focusOn(thing.keys);
    setQuery('');
  };
  return (
    <div className="find-box">
      <label className="sr-only" htmlFor={id}>
        Find a street, building, water or route by name
      </label>
      <div className="find-input">
        <Search size={13} aria-hidden="true" />
        <input
          id={id}
          className="text-input"
          type="search"
          value={query}
          placeholder="Find a street, building, water or route"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && results[0]) pick(results[0]);
            // Back to the model, where the shortcuts work again.
            if (event.key === 'Escape') {
              setQuery('');
              event.currentTarget.blur();
            }
          }}
        />
      </div>
      {q.length >= 2 && (
        <ul className="find-results" aria-label="Matches">
          {results.length ? (
            results.map((thing) => (
              <li key={`${thing.detail}${thing.label}`}>
                <button type="button" className="find-result" onClick={() => pick(thing)}>
                  <span className="find-name">{thing.label}</span>
                  <span className="find-detail">{thing.detail}</span>
                </button>
              </li>
            ))
          ) : (
            <li className="find-none">Nothing with that name in this model</li>
          )}
        </ul>
      )}
    </div>
  );
}

function Layers({ edits }: { edits: ModelEdits }) {
  const counts = new Map<string, number>();
  for (const edit of Object.values(edits.objects)) if (edit.layer) counts.set(edit.layer, (counts.get(edit.layer) ?? 0) + 1);
  for (const shape of edits.shapes) counts.set(shape.layer, (counts.get(shape.layer) ?? 0) + 1);
  return (
    <div className="inspector-layers">
      <div className="inspector-section-head">
        <span>Custom layers</span>
        <button type="button" className="link-btn" onClick={() => addLayer()}>
          <Plus size={12} aria-hidden="true" /> New layer
        </button>
      </div>
      {edits.layers.length ? (
        <ul className="layer-list">
          {edits.layers.map((layer) => (
            <LayerRow key={layer.id} layer={layer} count={counts.get(layer.id) ?? 0} edits={edits} />
          ))}
        </ul>
      ) : (
        <p className="inspector-note">A layer is a colour of your own, like a race track or your street in red. Each exports as its own part.</p>
      )}
    </div>
  );
}

function LayerRow({ layer, count, edits }: { layer: EditLayer; count: number; edits: ModelEdits }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(layer.name);
  // Undo can rename it too.
  useEffect(() => setName(layer.name), [layer.name]);
  const hidden = useApp((state) => state.ui.hiddenParts.includes(`layer:${layer.id}`));
  const select = () => {
    const keys = [
      ...Object.entries(edits.objects)
        .filter(([, edit]) => edit.layer === layer.id)
        .map(([key]) => key),
      ...edits.shapes.filter((shape) => shape.layer === layer.id).map((shape) => shapeKey(shape.id)),
    ];
    setSelection(keys);
  };
  return (
    <li className={`layer-row${hidden ? ' is-hidden' : ''}`}>
      <button ref={setAnchor} type="button" className="swatch swatch-btn-inline" style={{ background: layer.hex }} aria-label={`Colour of ${layer.name}`} onClick={() => setOpen(true)} />
      <input
        className="text-input layer-name"
        value={name}
        aria-label="Layer name"
        maxLength={60}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => {
          if (!name.trim()) setName(layer.name);
          else if (name.trim() !== layer.name) updateLayer(layer.id, { name: name.trim() });
        }}
        onKeyDown={(event) => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
      />
      <button type="button" className="link-btn layer-count" onClick={select} disabled={!count} title="Select what's in it" aria-label={`Select the ${count} things in ${layer.name}`}>
        {count}
      </button>
      <button type="button" className="icon-btn icon-btn-sm" aria-label={`Delete ${layer.name}`} title="Delete the layer. What's in it goes back to its own colour." onClick={() => deleteLayer(layer.id)}>
        <Trash2 size={12} aria-hidden="true" />
      </button>
      {open && (
        <FilamentPopover
          title={layer.name}
          entry={layer}
          anchor={anchor}
          placement="left-start"
          onChange={(entry) => updateLayer(layer.id, entry, `colour:${layer.id}`)}
          onClose={() => {
            setOpen(false);
            settleEdits();
          }}
        />
      )}
    </li>
  );
}
