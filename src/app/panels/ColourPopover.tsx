import { Check, Search } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { COLOUR_GROUPS, FILAMENTS, filamentName } from '../../core/settings';
import type { FilamentLine, PaletteEntry } from '../../core/settings';
import type { ColourGroup } from '../../core/types';
import { HexInput } from '../components/Fields';
import type { Placement } from '../components/floating';
import { Popover } from '../components/Popover';
import { Segmented } from '../components/Segmented';
import { setPaletteEntry, useApp } from '../state/store';

const LINES: FilamentLine[] = ['PLA Basic', 'PLA Matte'];

interface ColourPopoverProps {
  group: ColourGroup | null;
  anchor: HTMLElement | null;
  onClose: () => void;
}

export function ColourPopover({ group, anchor, onClose }: ColourPopoverProps) {
  const entry = useApp((state) => (group ? state.palette[group] : null));
  const info = COLOUR_GROUPS.find((item) => item.key === group);
  if (!group || !entry || !info) return null;
  return <FilamentPopover title={info.label} entry={entry} anchor={anchor} onChange={(next) => setPaletteEntry(group, next)} onClose={onClose} />;
}

interface FilamentPopoverProps {
  title: string;
  entry: PaletteEntry;
  anchor: HTMLElement | null;
  onChange: (entry: PaletteEntry) => void;
  onClose: () => void;
  placement?: Placement;
}

/** Bambu filaments to pick from, or any colour by its hex code. */
export function FilamentPopover({ title, entry, anchor, onChange, onClose, placement = 'right-start' }: FilamentPopoverProps) {
  const [filter, setFilter] = useState('');
  const hexId = useId();

  useEffect(() => {
    setFilter('');
  }, [title]);

  const current = entry;
  const query = filter.trim().toLowerCase();
  const choose = (next: PaletteEntry) => onChange({ hex: next.hex.toUpperCase(), line: next.line });
  const name = filamentName(current);

  return (
    <Popover anchor={anchor} open label={`${title} colour`} onClose={onClose} placement={placement} className="colour-popover" initialFocus=".colour-filter input">
      <header className="colour-popover-header">
        <span className="swatch swatch-lg" style={{ background: current.hex }} aria-hidden="true" />
        <div>
          <div className="colour-popover-title">{title}</div>
          <div className="colour-popover-sub">{name || `Custom ${current.hex} · ${current.line}`}</div>
        </div>
      </header>
      <label className="colour-filter">
        <Search size={14} aria-hidden="true" />
        <input type="search" placeholder="Filter filaments" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter filaments" />
      </label>
      <div className="colour-lines">
        {LINES.map((line) => {
          const entries = Object.entries(FILAMENTS[line]).filter(([filament, hex]) => {
            if (!query) return true;
            return `${line} ${filament} ${hex}`.toLowerCase().includes(query);
          });
          if (!entries.length) return null;
          return (
            <div key={line} className="colour-line">
              <div className="colour-line-label">{line}</div>
              <div className="swatch-grid" role="listbox" aria-label={`${line} filaments`}>
                {entries.map(([filament, hex]) => {
                  const selected = current.line === line && current.hex.toUpperCase() === hex.toUpperCase();
                  const label = `${line} ${filament}`;
                  return (
                    <button
                      key={filament}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={`swatch-btn${selected ? ' is-selected' : ''}`}
                      style={{ background: hex }}
                      title={`${label} · ${hex}`}
                      aria-label={label}
                      onClick={() => choose({ hex, line })}
                    >
                      {selected && <Check size={14} aria-hidden="true" className={isLight(hex) ? 'on-light' : 'on-dark'} />}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        {query && LINES.every((line) => !Object.keys(FILAMENTS[line]).some((filament) => `${line} ${filament} ${FILAMENTS[line][filament]}`.toLowerCase().includes(query))) && (
          <p className="colour-empty">No filament matches “{filter}”.</p>
        )}
      </div>
      <div className="colour-custom">
        <div className="colour-custom-label">Custom colour</div>
        <div className="colour-custom-row">
          <input
            type="color"
            className="colour-native"
            value={current.hex.toLowerCase()}
            aria-label="Pick any colour"
            onChange={(event) => choose({ hex: event.target.value.toUpperCase(), line: current.line })}
          />
          <label htmlFor={hexId} className="sr-only">
            Hex colour
          </label>
          <HexInput id={hexId} value={current.hex} onChange={(hex) => choose({ hex, line: current.line })} />
          <Segmented
            label="PLA line"
            size="sm"
            value={current.line}
            onChange={(line) => choose({ hex: current.hex, line })}
            options={[
              { value: 'PLA Basic', label: 'Basic' },
              { value: 'PLA Matte', label: 'Matte' },
            ]}
          />
        </div>
        <p className="colour-custom-hint">The hex code is the colour written to the file. The line picks the Bambu filament preset.</p>
      </div>
    </Popover>
  );
}

export function isLight(hex: string): boolean {
  const value = parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 160;
}
