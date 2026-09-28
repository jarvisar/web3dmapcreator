import { Check, Search } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { COLOUR_GROUPS, FILAMENTS, filamentName } from '../../core/settings';
import type { FilamentLine, PaletteEntry } from '../../core/settings';
import type { ColourGroup } from '../../core/types';
import { Popover } from '../components/Popover';
import { Segmented } from '../components/Segmented';
import { setPaletteEntry, useApp } from '../state/store';

const LINES: FilamentLine[] = ['PLA Basic', 'PLA Matte'];

function normaliseHex(text: string): string | null {
  let value = text.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(value)) value = value.replace(/./g, (c) => c + c);
  return /^[0-9a-f]{6}$/i.test(value) ? `#${value.toUpperCase()}` : null;
}

interface ColourPopoverProps {
  group: ColourGroup | null;
  anchor: HTMLElement | null;
  onClose: () => void;
}

export function ColourPopover({ group, anchor, onClose }: ColourPopoverProps) {
  const entry = useApp((state) => (group ? state.palette[group] : null));
  const [filter, setFilter] = useState('');
  const [hexText, setHexText] = useState('');
  const hexId = useId();
  const info = COLOUR_GROUPS.find((item) => item.key === group);

  useEffect(() => {
    if (entry) setHexText(entry.hex);
  }, [entry?.hex]);

  useEffect(() => {
    if (group) setFilter('');
  }, [group]);

  if (!group || !entry || !info) return null;
  const current = entry;
  const query = filter.trim().toLowerCase();

  function choose(next: PaletteEntry) {
    setPaletteEntry(group!, next);
  }

  function applyHex(text: string) {
    const hex = normaliseHex(text);
    if (hex) choose({ hex, line: current.line });
  }

  const name = filamentName(current);

  return (
    <Popover anchor={anchor} open label={`${info.label} colour`} onClose={onClose} placement="right-start" className="colour-popover" initialFocus=".colour-filter input">
      <header className="colour-popover-header">
        <span className="swatch swatch-lg" style={{ background: current.hex }} aria-hidden="true" />
        <div>
          <div className="colour-popover-title">{info.label}</div>
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
          <input
            id={hexId}
            className="text-input hex-input"
            value={hexText}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setHexText(event.target.value);
              applyHex(event.target.value);
            }}
            onBlur={() => setHexText(current.hex)}
            onKeyDown={(event) => event.key === 'Enter' && applyHex(hexText)}
          />
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
