import { Info } from 'lucide-react';
import { useState } from 'react';
import { COLOUR_GROUPS, PALETTE_PRESETS, filamentName } from '../../core/settings';
import type { Palette } from '../../core/settings';
import type { ColourGroup } from '../../core/types';
import { filamentCount, matchingPreset, usedGroups } from '../state/derived';
import { setPalette, useApp } from '../state/store';
import { ColourPopover } from './ColourPopover';
import { Section } from './Section';

const PREVIEW_GROUPS: ColourGroup[] = ['terrain', 'buildings', 'roads', 'green', 'water'];

function PresetSwatches({ palette }: { palette: Palette }) {
  return (
    <span className="preset-swatches" aria-hidden="true">
      {PREVIEW_GROUPS.map((group) => (
        <span key={group} style={{ background: palette[group].hex }} />
      ))}
    </span>
  );
}

function ColourRow({ group, onOpen, active }: { group: ColourGroup; onOpen: (group: ColourGroup, el: HTMLElement) => void; active: boolean }) {
  const entry = useApp((state) => state.palette[group]);
  const info = COLOUR_GROUPS.find((item) => item.key === group)!;
  const name = filamentName(entry);
  return (
    <li>
      <button
        type="button"
        className={`colour-row${active ? ' is-active' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={active}
        title={info.description}
        onClick={(event) => onOpen(group, event.currentTarget)}
      >
        <span className="swatch" style={{ background: entry.hex }} aria-hidden="true" />
        <span className="colour-row-label">{info.label}</span>
        <span className="colour-row-filament">{name ? name.replace(/^PLA /, '') : `Custom ${entry.hex}`}</span>
        <span className="colour-row-change" aria-hidden="true">
          Change
        </span>
      </button>
    </li>
  );
}

export function ColoursPanel() {
  const palette = useApp((state) => state.palette);
  const settings = useApp((state) => state.settings);
  const [editing, setEditing] = useState<{ group: ColourGroup; anchor: HTMLElement } | null>(null);
  const [showMore, setShowMore] = useState(false);
  const used = usedGroups(settings);
  const unused = COLOUR_GROUPS.map((group) => group.key).filter((key) => !used.includes(key));
  const count = filamentCount(palette, used);
  const preset = matchingPreset(palette);

  const open = (group: ColourGroup, anchor: HTMLElement) => {
    setEditing((current) => (current?.group === group ? null : { group, anchor }));
  };

  return (
    <Section
      id="colours"
      title="Colours"
      summary={`${preset ? preset.name : 'Custom'} · ${count} ${count === 1 ? 'filament' : 'filaments'}`}
    >
      <div className="preset-chips" role="group" aria-label="Colour presets">
        {PALETTE_PRESETS.map((item) => {
          const selected = preset?.key === item.key;
          return (
            <button
              key={item.key}
              type="button"
              className={`preset-chip${selected ? ' is-selected' : ''}`}
              aria-pressed={selected}
              title={item.description}
              onClick={() => setPalette(item.palette)}
            >
              <PresetSwatches palette={item.palette} />
              <span>{item.name}</span>
            </button>
          );
        })}
        {!preset && <span className="preset-chip is-selected is-static">Custom</span>}
      </div>

      <ul className="list-box" aria-label="Colours in use">
        {used.map((group) => (
          <ColourRow key={group} group={group} onOpen={open} active={editing?.group === group} />
        ))}
      </ul>

      {unused.length > 0 && (
        <div className="more-colours">
          <button type="button" className="disclosure" aria-expanded={showMore} onClick={() => setShowMore(!showMore)}>
            <span className="triangle" aria-hidden="true" />
            Colours for layers that are off ({unused.length})
          </button>
          {showMore && (
            <ul className="list-box">
              {unused.map((group) => (
                <ColourRow key={group} group={group} onOpen={open} active={editing?.group === group} />
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="filament-count">
        <strong>{count}</strong> {count === 1 ? 'filament' : 'filaments'} for the layers that are on.
      </p>
      {count > 16 ? (
        <div className="notice notice-warning">
          <Info size={16} aria-hidden="true" />
          <span>More than 16 filaments is more than four AMS units hold. Give some layers the same colour.</span>
        </div>
      ) : count > 4 ? (
        <div className="notice notice-info">
          <Info size={16} aria-hidden="true" />
          <span>More than 4 filaments needs more than one AMS unit or manual swaps.</span>
        </div>
      ) : null}
      <p className="muted small">Colours on screen look lighter than the printed filament.</p>

      <ColourPopover group={editing?.group ?? null} anchor={editing?.anchor ?? null} onClose={() => setEditing(null)} />
    </Section>
  );
}
