import { ChevronDown } from 'lucide-react';
import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Popover } from '../components/Popover';
import { PRESET_GROUPS } from '../data/presets';
import type { AreaPreset } from '../data/presets';
import { areaForBounds } from '../lib/area';
import { NARROW_QUERY } from '../lib/browser';
import { setArea, setDrawerOpen, useApp } from '../state/store';

export function PresetsMenu() {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  function choose(preset: AreaPreset) {
    const svg = useApp.getState().output === 'svg';
    setArea((area) => areaForBounds(preset.bounds, area, svg), { focus: 'always', placeName: preset.name, title: preset.title, fit: 'cover' });
    setOpen(false);
    anchor?.focus();
    if (window.matchMedia(NARROW_QUERY).matches) setDrawerOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const items = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = 0;
    if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'ArrowDown') next = (index + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className="btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Presets
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label="Area presets" role="menu" placement="bottom-end" className="menu">
        <div ref={listRef} onKeyDown={onKeyDown}>
          {PRESET_GROUPS.map((group) => (
            <div key={group.label} className="menu-group" role="group" aria-label={group.label}>
              <div className="menu-heading">
                {group.label}
                {group.note && <span className="menu-note">{group.note}</span>}
              </div>
              {group.presets.map((preset) => (
                <button key={preset.name} type="button" role="menuitem" className="menu-item" onClick={() => choose(preset)}>
                  {preset.name}
                </button>
              ))}
            </div>
          ))}
        </div>
      </Popover>
    </>
  );
}
