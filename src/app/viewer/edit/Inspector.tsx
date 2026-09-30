import { Copy, Crosshair, Eraser, Plus, RotateCcw, Route, Trash2, Undo2, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { isPartKey, kindOf, objectOf, shapeKey } from '../../../core/edit/keys';
import { EDIT_LIMITS, editCount, type AddedShape, type EditLayer, type ModelEdits } from '../../../core/edit/types';
import { COLOUR_GROUPS } from '../../../core/settings';
import { FONTS } from '../../../core/svgmap/text/fonts';
import type { ColourGroup } from '../../../core/types';
import { Checkbox } from '../../components/Checkbox';
import { NumberInput } from '../../components/NumberField';
import { COARSE_QUERY, useMediaQuery } from '../../lib/browser';
import { formatNumber } from '../../lib/format';
import {
  addLayer,
  clearEdits,
  deleteLayer,
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
import { toast, useApp } from '../../state/store';
import { FilamentPopover } from '../../panels/ColourPopover';
import { describeCounts, describeKey } from './describe';

const NEW_LAYER = '__new';
const MIXED = '__mixed';

export interface InspectorProps {
  /** How tall a building or part is now, as shown. */
  heightOf: (key: string) => number | null;
  /** The whole street a road is part of. */
  streetOf: (key: string) => string[];
  focus: () => void;
}

export function Inspector(props: InspectorProps) {
  const selection = useApp((state) => state.ui.selection);
  const edits = useApp((state) => state.edits);
  // Object facts change with the model.
  useApp((state) => state.generation.result?.version);
  const data = getEditData();
  return (
    <section className="viewer-card floating inspector" aria-label="Edit">
      {selection.length ? <SelectionPanel keys={selection} edits={edits} data={data} {...props} /> : <Overview edits={edits} data={data} />}
    </section>
  );
}

// ------------------------------------------------------------- selection

function SelectionPanel({ keys, edits, data, heightOf, streetOf, focus }: InspectorProps & { keys: string[]; edits: ModelEdits; data: EditData }) {
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
          <ObjectControls keys={objects} kinds={kinds} edits={edits} data={data} heightOf={heightOf} streetOf={streetOf} />
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
}: {
  keys: string[];
  kinds: Set<string | null>;
  edits: ModelEdits;
  data: EditData;
  heightOf: InspectorProps['heightOf'];
  streetOf: InspectorProps['streetOf'];
}) {
  const settings = useApp((state) => state.settings);
  const coarse = useMediaQuery(COARSE_QUERY);
  const allRemoved = keys.every((key) => edits.objects[key]?.removed);
  const layers = new Set(keys.map((key) => edits.objects[key]?.layer ?? ''));
  const layer = layers.size === 1 ? [...layers][0] : MIXED;
  const edited = keys.some((key) => Object.keys(edits.objects).some((k) => k === key || objectOf(k) === key));
  const only = (kind: string) => kinds.size === 1 && kinds.has(kind);
  const tag = keys.join(',');
  const water = kinds.has('water');
  const mmPerMetre = data.frame?.mmPerMetre ?? 0.07;

  return (
    <>
      {only('building') && <BuildingHeight keys={keys} edits={edits} data={data} heightOf={heightOf} tag={tag} mmPerMetre={mmPerMetre} heightScale={settings.buildings.heightScale} />}
      {only('road') && <RoadSize keys={keys} edits={edits} data={data} tag={tag} />}
      <LayerField
        label="Colour"
        value={layer}
        groups={false}
        onChange={(value) => patchObjects(keys, { layer: value || undefined })}
        help="Put it in a custom layer of its own colour. Everything in a layer exports as one part with its own filament."
      />
      {water && !allRemoved && (
        <p className="inspector-note">
          {settings.water.mode === 'through'
            ? 'Leaving water out leaves a hole through the model where it was.'
            : 'Leaving water out keeps the recess, so it can be filled with resin later.'}
        </p>
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
        {only('road') && (
          <button type="button" className="btn btn-sm" onClick={() => setSelection([...new Set(keys.flatMap(streetOf))])} title="Select every connected piece with the same name">
            <Route size={14} aria-hidden="true" />
            Whole street
          </button>
        )}
        {edited && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => resetObjects(keys)} title="Undo every change to the selection">
            <RotateCcw size={14} aria-hidden="true" />
            Reset
          </button>
        )}
      </div>
      {!coarse && only('building') && keys.length === 1 && !isPartKey(keys[0]) && (
        <p className="inspector-hint">Alt-click a building to pick one of its parts.</p>
      )}
    </>
  );
}

function BuildingHeight({
  keys,
  edits,
  data,
  heightOf,
  tag,
  mmPerMetre,
  heightScale,
}: {
  keys: string[];
  edits: ModelEdits;
  data: EditData;
  heightOf: InspectorProps['heightOf'];
  tag: string;
  mmPerMetre: number;
  heightScale: number;
}) {
  const heights = keys.map((key) => edits.objects[key]?.heightMm ?? heightOf(key) ?? data.objects[objectOf(key)]?.heightMm ?? null);
  const known = heights.filter((h): h is number => h !== null);
  if (!known.length) return null;
  const same = known.every((h) => Math.abs(h - known[0]) < 0.005);
  const value = same ? known[0] : Math.max(...known);
  const edited = keys.some((key) => edits.objects[key]?.heightMm !== undefined);
  const metres = value / (mmPerMetre * heightScale);
  return (
    <NumberRow
      label={same ? 'Height' : 'Height (all)'}
      value={value}
      min={EDIT_LIMITS.heightMm[0]}
      max={EDIT_LIMITS.heightMm[1]}
      step={0.5}
      unit="mm"
      hint={`About ${formatNumber(metres, metres < 20 ? 1 : 0)} m in real life${edited ? '' : ', as mapped'}`}
      onChange={(heightMm) => patchObjects(keys, { heightMm }, `height:${tag}`)}
      reset={edited ? () => patchObjects(keys, { heightMm: undefined }) : undefined}
    />
  );
}

function RoadSize({ keys, edits, data, tag }: { keys: string[]; edits: ModelEdits; data: EditData; tag: string }) {
  const lines = data.roads;
  if (!lines) return null;
  const widthOf = (key: string) => {
    const piece = lines.keys.indexOf(key);
    return edits.objects[key]?.widthMm ?? (piece >= 0 ? lines.widths[piece] : 0.5);
  };
  const widths = keys.map(widthOf);
  const heights = keys.map((key) => edits.objects[key]?.heightMm ?? lines.thicknessMm);
  const sameWidth = widths.every((w) => Math.abs(w - widths[0]) < 0.005);
  const sameHeight = heights.every((h) => Math.abs(h - heights[0]) < 0.005);
  const widthEdited = keys.some((key) => edits.objects[key]?.widthMm !== undefined);
  const heightEdited = keys.some((key) => edits.objects[key]?.heightMm !== undefined);
  return (
    <>
      <NumberRow
        label={sameWidth ? 'Width' : 'Width (all)'}
        value={sameWidth ? widths[0] : Math.max(...widths)}
        min={EDIT_LIMITS.widthMm[0]}
        max={EDIT_LIMITS.widthMm[1]}
        step={0.1}
        unit="mm"
        onChange={(widthMm) => patchObjects(keys, { widthMm }, `width:${tag}`)}
        reset={widthEdited ? () => patchObjects(keys, { widthMm: undefined }) : undefined}
      />
      <NumberRow
        label={sameHeight ? 'Height' : 'Height (all)'}
        value={sameHeight ? heights[0] : Math.max(...heights)}
        min={EDIT_LIMITS.roadHeightMm[0]}
        max={EDIT_LIMITS.roadHeightMm[1]}
        step={0.1}
        unit="mm"
        hint="Above the ground. Raise a route to make it stand out."
        onChange={(heightMm) => patchObjects(keys, { heightMm }, `road-height:${tag}`)}
        reset={heightEdited ? () => patchObjects(keys, { heightMm: undefined }) : undefined}
      />
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
  const shapes = keys.map((key) => edits.shapes.find((s) => shapeKey(s.id) === key)).filter((s): s is AddedShape => Boolean(s));
  if (!shapes.length) return null;
  const ids = shapes.map((s) => s.id);
  const tag = ids.join(',');
  const layers = new Set(shapes.map((s) => s.layer));
  const heights = new Set(shapes.map((s) => s.heightMm));
  const frameRotation = data.frame?.rotationDeg ?? 0;
  const shape = shapes.length === 1 ? shapes[0] : null;
  return (
    <>
      {shape?.kind === 'text' && <TextControls shape={shape} />}
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
        hint={shape?.followGround ? 'Above the ground under it.' : 'Above the highest ground under it.'}
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
          hint="Stands it on a roof or a plinth. It's still solid down to the base."
          onChange={(liftMm) => updateShape(shape.id, { liftMm }, `lift:${shape.id}`)}
        />
      )}
      {shape && shape.kind !== 'path' && shape.kind !== 'area' && (
        <NumberRow
          label="Rotation"
          value={normaliseAngle(shape.rotationDeg - frameRotation)}
          min={-180}
          max={180}
          step={5}
          unit="°"
          decimals={1}
          hint="From the model's up. [ and ] turn it by 15°."
          onChange={(turn) => updateShape(shape.id, { rotationDeg: (((turn + frameRotation) % 360) + 360) % 360 }, `rotate:${shape.id}`)}
        />
      )}
      {shape && (
        <CheckRow
          label="Follow the ground"
          checked={shape.followGround}
          onChange={(followGround) => updateShape(shape.id, { followGround })}
          help="The top follows the terrain under it. Off, the top is flat."
        />
      )}
      <LayerField label="Colour" value={layers.size === 1 ? [...layers][0] : MIXED} groups onChange={(layer) => updateShapes(ids, { layer })} />
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
      {shape && (shape.kind === 'path' || shape.kind === 'area') && (
        <p className="inspector-hint">
          {coarse ? 'Drag its points to reshape it, or a white dot to add a point.' : 'Drag its points to reshape it. Drag a white dot to add a point, and Alt-click a point to take it out.'}
        </p>
      )}
      {shape && shape.kind !== 'path' && shape.kind !== 'area' && <p className="inspector-hint">Drag it to move it, or its arrow to change its height.</p>}
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
          maxLength={80}
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

function CheckRow({ label, checked, onChange, help }: { label: string; checked: boolean; onChange: (checked: boolean) => void; help?: string }) {
  const id = useId();
  return (
    <div className="field check-field">
      <label className="check-label" htmlFor={id} title={help}>
        <Checkbox id={id} checked={checked} onChange={onChange} />
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
  if (kindOf(key) === 'road') return data.roads?.keys.includes(key) ?? false;
  if (kindOf(key) === 'tree') return true;
  return objectOf(key) in data.objects;
}

function Overview({ edits, data }: { edits: ModelEdits; data: EditData }) {
  const coarse = useMediaQuery(COARSE_QUERY);
  const changes = editCount(edits);
  const removed = Object.values(edits.objects).filter((edit) => edit.removed).length;
  const elsewhere = Object.keys(edits.objects).filter((key) => !inModel(key, data)).length;
  return (
    <>
      <header className="viewer-card-header">
        <h3>Edit the model</h3>
      </header>
      <div className="inspector-body">
        {data.editable ? (
          <p className="inspector-intro">
            {coarse ? 'Tap a building, road, water or tree to change it.' : 'Click a building, road, water or tree to change it. Shift-click or Shift-drag to select more.'} The
            tool buttons add text, pins and shapes, or draw your own paths and areas.
          </p>
        ) : (
          <p className="inspector-intro">This model is one surface, so nothing in it can be picked out. You can still add text, pins and shapes with the tool buttons.</p>
        )}
        <Layers edits={edits} />
        {elsewhere > 0 && (
          <p className="inspector-note">
            {elsewhere} {elsewhere === 1 ? 'change is' : 'changes are'} for things this model doesn't have, from another area or other settings.
          </p>
        )}
        <div className="inspector-changes">
          <span>{changes ? `${changes} ${changes === 1 ? 'change' : 'changes'}${removed ? `, ${removed} removed` : ''}` : 'No changes yet'}</span>
          {(changes > 0 || edits.layers.length > 0) && (
            <button
              type="button"
              className="link-btn is-danger"
              onClick={() => {
                clearEdits();
                toast('Every edit was undone. Ctrl+Z brings them back.');
              }}
            >
              <Eraser size={12} aria-hidden="true" /> Undo all
            </button>
          )}
        </div>
      </div>
      <footer className="viewer-card-footer inspector-footer">
        <span>Edits stay with this area when you change settings and generate again.</span>
      </footer>
    </>
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
        onBlur={() => name.trim() && name !== layer.name && updateLayer(layer.id, { name: name.trim() })}
        onKeyDown={(event) => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
      />
      <button type="button" className="link-btn layer-count" onClick={select} disabled={!count} title="Select what's in it">
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
