import { fieldRange } from '../../core/svgmap/limits';
import { CircleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { BorderStyle } from '../../core/svgmap/layout/layout';
import { PRODUCT_PRESETS } from '../../core/svgmap/presets';
import { CheckField, Disclosure, SelectField } from '../components/Fields';
import { NumberField, StackedNumber } from '../components/NumberField';
import { Segmented } from '../components/Segmented';
import { formatNumber } from '../lib/format';
import { Section } from '../panels/Section';
import { applyPiecePreset, setBorder, setPieceSize, useApp } from '../state/store';
import { pieceHeight, pieceLayout } from './piece';

const GROUPS = ['Plaques & frames', 'Paper', 'Coasters & squares'] as const;

const mm = (value: number) => formatNumber(value, 1);

export function SizePanel() {
  const size = useApp((state) => state.svg.product);
  const preset = useApp((state) => state.svg.productPreset);
  const border = useApp((state) => state.svg.border);
  const shape = useApp((state) => state.area.shape);
  const { layout, error } = pieceLayout(size, shape, border);

  const m = size.margins;
  const uniformMargin = m.top === m.right && m.top === m.bottom && m.top === m.left;
  const [perSide, setPerSide] = useState(!uniformMargin);
  // A preset with uneven margins opens the per-side fields.
  useEffect(() => {
    if (!uniformMargin) setPerSide(true);
  }, [uniformMargin]);
  // Circles and hexagons shrink evenly, so they only have one margin.
  const even = shape === 'circle' || shape === 'hexagon';
  const height = pieceHeight(size, shape);
  const landscape = size.width >= size.height;
  const presetName = PRODUCT_PRESETS.find((item) => item.id === preset)?.name ?? 'Custom';
  const dimensions = shape === 'circle' ? `⌀ ${mm(size.width)} mm` : `${mm(size.width)} × ${mm(height)} mm`;

  return (
    <Section
      id="piece"
      title="Size"
      summary={`${presetName} · ${dimensions}`}
      badge={error ? <span className="badge-dot badge-dot-warning" title={error} /> : undefined}
    >
      <SelectField label="Preset" value={preset} onChange={applyPiecePreset} stacked help="Sets the size, shape, margins, border and title style. The area on the map takes the shape of the map inside the border.">
        {GROUPS.map((group) => (
          <optgroup key={group} label={group}>
            {PRODUCT_PRESETS.filter((item) => item.group === group).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </optgroup>
        ))}
        <option value="custom">Custom</option>
      </SelectField>

      {shape === 'circle' ? (
        <NumberField label="Diameter" value={size.width} onChange={(width) => setPieceSize({ width, height: width })} {...fieldRange('product.width')} step={1} decimals={1} unit="mm" />
      ) : shape === 'hexagon' ? (
        <NumberField
          label="Width"
          value={size.width}
          onChange={(width) => setPieceSize({ width })}
          {...fieldRange('product.width')}
          step={1}
          decimals={1}
          unit="mm"
          hint={`Corner to corner. ${mm(height)} mm between the flat sides.`}
        />
      ) : (
        <>
          <div className="size-grid">
            <StackedNumber label="Width" value={size.width} onChange={(width) => setPieceSize({ width })} {...fieldRange('product.width')} step={1} decimals={1} unit="mm" />
            <StackedNumber label="Height" value={size.height} onChange={(height) => setPieceSize({ height })} {...fieldRange('product.height')} step={1} decimals={1} unit="mm" />
          </div>
          <Segmented
            label="Orientation"
            size="sm"
            value={landscape ? 'landscape' : 'portrait'}
            onChange={(orientation) => {
              if ((orientation === 'landscape') === landscape || size.width === size.height) return;
              // The margins turn with the sheet: a quarter turn clockwise to
              // portrait and back the other way, so switching twice changes nothing.
              const margins = landscape
                ? { top: m.left, right: m.top, bottom: m.right, left: m.bottom }
                : { top: m.right, right: m.bottom, bottom: m.left, left: m.top };
              setPieceSize({ width: size.height, height: size.width, margins });
            }}
            options={[
              { value: 'landscape', label: 'Landscape' },
              { value: 'portrait', label: 'Portrait' },
            ]}
          />
        </>
      )}

      {shape === 'rounded' && (
        <NumberField label="Corner radius" value={size.cornerRadius} onChange={(cornerRadius) => setPieceSize({ cornerRadius })} {...fieldRange('product.cornerRadius')} step={0.5} decimals={2} unit="mm" />
      )}

      {!perSide || even ? (
        <NumberField
          label="Margin"
          value={m.top}
          onChange={(v) => setPieceSize({ margins: { top: v, right: v, bottom: v, left: v } })}
          {...fieldRange('product.margins.*')}
          step={0.05}
          decimals={2}
          unit="mm"
          help="Blank edge inside the cut, for example the part a frame hides."
        />
      ) : (
        <div className="size-grid">
          {(['top', 'bottom', 'left', 'right'] as const).map((side) => (
            <StackedNumber
              key={side}
              label={`${side[0].toUpperCase()}${side.slice(1)} margin`}
              value={m[side]}
              onChange={(v) => setPieceSize({ margins: { ...m, [side]: v } })}
              {...fieldRange('product.margins.*')}
              step={0.05}
              decimals={2}
              unit="mm"
            />
          ))}
        </div>
      )}
      {!even && (
        <CheckField
          label="Different margin per side"
          checked={perSide}
          onChange={(on) => {
            setPerSide(on);
            if (!on) setPieceSize({ margins: { top: m.top, right: m.top, bottom: m.top, left: m.top } });
          }}
        />
      )}

      <div className="field-group">
        <div className="group-label">Border</div>
        <Segmented<BorderStyle>
          label="Border"
          value={border.style}
          stretch
          onChange={(style) => setBorder({ style })}
          options={[
            { value: 'double', label: 'Double' },
            { value: 'single', label: 'Single' },
            { value: 'none', label: 'None' },
          ]}
        />
      </div>
      {border.style !== 'none' && (
        <Disclosure label="Border measurements">
          <NumberField label="Outer gap" value={border.outerGap} onChange={(outerGap) => setBorder({ outerGap })} {...fieldRange('border.outerGap')} step={0.05} decimals={2} unit="mm" help="From the edge of the artwork to the border." />
          {border.style === 'double' && (
            <>
              <NumberField label="Thick band" value={border.thick} onChange={(thick) => setBorder({ thick })} {...fieldRange('border.thick')} step={0.05} decimals={2} unit="mm" />
              <NumberField label="Band to line" value={border.gap} onChange={(gap) => setBorder({ gap })} {...fieldRange('border.gap')} step={0.05} decimals={2} unit="mm" />
            </>
          )}
          <NumberField label="Thin line" value={border.thin} onChange={(thin) => setBorder({ thin })} {...fieldRange('border.thin')} step={0.05} decimals={2} unit="mm" />
          <NumberField label="Line to map" value={border.innerGap} onChange={(innerGap) => setBorder({ innerGap })} {...fieldRange('border.innerGap')} step={0.05} decimals={2} unit="mm" />
        </Disclosure>
      )}

      {layout ? (
        <p className="field-hint">
          Map inside the border: {mm(layout.window.w)} × {mm(layout.window.h)} mm
        </p>
      ) : (
        <div className="notice notice-error" role="alert">
          <CircleAlert size={16} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
    </Section>
  );
}
