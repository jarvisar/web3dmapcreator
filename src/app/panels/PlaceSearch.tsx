import { Crosshair, LoaderCircle, MapPin, Search, SquareDashed, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { parseBoundsText, parseLatLon } from '../../core/geo/area';
import type { GeoBounds, LonLat } from '../../core/types';
import { areaForBounds } from '../lib/area';
import { NARROW_QUERY } from '../lib/browser';
import { formatNumber } from '../lib/format';
import { setArea, setDrawerOpen } from '../state/store';

type Suggestion =
  | { kind: 'place'; key: string; name: string; detail: string; center: LonLat }
  | { kind: 'point'; key: string; center: LonLat }
  | { kind: 'bounds'; key: string; bounds: GeoBounds }
  | { kind: 'invalid'; key: string; message: string };

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: Record<string, unknown>;
}

const PHOTON_LANGUAGES = ['en', 'de', 'fr', 'it'];

function photonUrl(query: string): string {
  const url = new URL('https://photon.komoot.io/api/');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '6');
  const lang = navigator.language?.slice(0, 2).toLowerCase();
  if (PHOTON_LANGUAGES.includes(lang)) url.searchParams.set('lang', lang);
  return url.toString();
}

function describeFeature(feature: PhotonFeature, index: number): Suggestion | null {
  const coords = feature.geometry?.coordinates;
  const p = feature.properties ?? {};
  if (!coords || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) return null;
  const text = (key: string) => (typeof p[key] === 'string' ? (p[key] as string) : '');
  const street = [text('street'), text('housenumber')].filter(Boolean).join(' ');
  const name = text('name') || street || text('city') || 'Unnamed place';
  const parts = [text('name') ? street : '', text('district') || text('locality'), text('city'), text('state'), text('country')];
  const seen = new Set([name]);
  const detail = parts.filter((part) => {
    if (!part || seen.has(part)) return false;
    seen.add(part);
    return true;
  });
  return { kind: 'place', key: `place-${index}`, name, detail: detail.slice(0, 3).join(', '), center: [coords[0], coords[1]] };
}

function localSuggestion(query: string): Suggestion | null {
  const point = parseLatLon(query);
  if (point) return { kind: 'point', key: 'point', center: point };
  // Only all-number input counts as bounds, so an address with numbers in it is still searched.
  const body = query.includes('=') ? query.slice(query.lastIndexOf('=') + 1) : query;
  const tokens = body.replace(/[−–﹣－]/g, '-').split(/[,;\s]+/).filter(Boolean);
  const numeric = tokens.filter((token) => /^[-+([{]*\.?\d[\d.]*[)\]}]*$/.test(token)).length;
  if (tokens.length >= 3 && numeric === tokens.length) {
    try {
      return { kind: 'bounds', key: 'bounds', bounds: parseBoundsText(query) };
    } catch (error) {
      return { kind: 'invalid', key: 'invalid', message: error instanceof Error ? error.message : 'Not a valid set of bounds' };
    }
  }
  return null;
}

const coord = (value: number) => formatNumber(value, 5);

export function PlaceSearch({ inputId }: { inputId?: string }) {
  const [text, setText] = useState('');
  const [results, setResults] = useState<Suggestion[]>([]);
  // The query the results are for. Enter only picks results that match what is typed.
  const [resultsFor, setResultsFor] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'error' | 'empty'>('idle');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const skipSearch = useRef<string | null>(null);
  const listId = useId();
  const optionId = (index: number) => `${listId}-${index}`;

  useEffect(() => {
    const query = text.trim();
    if (skipSearch.current === text) return;
    const local = localSuggestion(query);
    if (local) {
      setResults([local]);
      setResultsFor(query);
      setStatus('idle');
      setActive(0);
      return;
    }
    if (query.length < 2) {
      setResults([]);
      setStatus('idle');
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setStatus('loading');
      try {
        const response = await fetch(photonUrl(query), { signal: controller.signal });
        if (!response.ok) throw new Error(`Search failed (${response.status})`);
        const data = (await response.json()) as { features?: PhotonFeature[] };
        const found = (data.features ?? []).map(describeFeature).filter((item): item is Suggestion => item !== null);
        setResults(found);
        setResultsFor(query);
        setActive(0);
        setStatus(found.length ? 'idle' : 'empty');
      } catch (error) {
        if (controller.signal.aborted) return;
        setResults([]);
        setStatus('error');
        console.warn('Place search failed', error);
      }
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [text]);

  function pick(item: Suggestion) {
    if (item.kind === 'invalid') return;
    let label = text;
    if (item.kind === 'place') {
      setArea((area) => ({ ...area, center: item.center }), { focus: 'always', placeName: item.name });
      label = item.name;
    } else if (item.kind === 'point') {
      setArea((area) => ({ ...area, center: item.center }), { focus: 'always', placeName: '' });
    } else {
      setArea((area) => areaForBounds(item.bounds, area), { focus: 'always', placeName: '' });
    }
    skipSearch.current = label;
    setText(label);
    setOpen(false);
    if (window.matchMedia(NARROW_QUERY).matches) setDrawerOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!results.length) return;
      event.preventDefault();
      setOpen(true);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((index) => (index + step + results.length) % results.length);
    } else if (event.key === 'Enter') {
      const item = results[active] ?? results[0];
      if (item && open && resultsFor === text.trim()) {
        event.preventDefault();
        pick(item);
      }
    } else if (event.key === 'Escape') {
      if (open && (results.length || status !== 'idle')) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      } else if (text) {
        event.preventDefault();
        event.stopPropagation();
        setText('');
      }
    }
  }

  const showList = open && text.trim().length > 0 && (results.length > 0 || status !== 'idle');

  return (
    <div className="search">
      <div className="search-box">
        <Search className="search-icon" size={16} aria-hidden="true" />
        <input
          id={inputId}
          type="search"
          className="search-input"
          placeholder="Search a place or lat, lon"
          value={text}
          role="combobox"
          aria-label="Search for a place"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && results[active] ? optionId(active) : undefined}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            skipSearch.current = null;
            setText(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
        />
        {status === 'loading' ? (
          <LoaderCircle className="search-spinner" size={16} aria-label="Searching" />
        ) : (
          text && (
            <button
              type="button"
              className="icon-btn icon-btn-sm search-clear"
              aria-label="Clear search"
              onClick={() => {
                setText('');
                setResults([]);
              }}
            >
              <X size={14} aria-hidden="true" />
            </button>
          )
        )}
      </div>
      {showList && (
        <div className="search-list" role="listbox" id={listId} aria-label="Search results">
          {results.map((item, index) => (
            <div
              key={item.key}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              aria-disabled={item.kind === 'invalid'}
              className={`search-option${index === active ? ' is-active' : ''}${item.kind === 'invalid' ? ' is-invalid' : ''}`}
              onPointerDown={(event) => event.preventDefault()}
              onPointerEnter={() => setActive(index)}
              onClick={() => pick(item)}
            >
              <span className="search-option-icon" aria-hidden="true">
                {item.kind === 'place' ? <MapPin size={15} /> : item.kind === 'point' ? <Crosshair size={15} /> : <SquareDashed size={15} />}
              </span>
              <span className="search-option-text">
                {item.kind === 'place' && (
                  <>
                    <span className="search-option-name">{item.name}</span>
                    {item.detail && <span className="search-option-detail">{item.detail}</span>}
                  </>
                )}
                {item.kind === 'point' && (
                  <>
                    <span className="search-option-name">Go to {coord(item.center[1])}, {coord(item.center[0])}</span>
                    <span className="search-option-detail">Latitude, longitude. Keeps the area size.</span>
                  </>
                )}
                {item.kind === 'bounds' && (
                  <>
                    <span className="search-option-name">Use these bounds</span>
                    <span className="search-option-detail">
                      W {coord(item.bounds.west)}, S {coord(item.bounds.south)}, E {coord(item.bounds.east)}, N {coord(item.bounds.north)}
                    </span>
                  </>
                )}
                {item.kind === 'invalid' && (
                  <>
                    <span className="search-option-name">Not valid bounds</span>
                    <span className="search-option-detail">{item.message}</span>
                  </>
                )}
              </span>
            </div>
          ))}
          {status === 'loading' && results.length === 0 && <div className="search-status">Searching…</div>}
          {status === 'empty' && <div className="search-status">No places found. Try a city, street or landmark.</div>}
          {status === 'error' && <div className="search-status">Search is not available right now. You can still type lat, lon.</div>}
          {results.some((item) => item.kind === 'place') && (
            <div className="search-credit">Search by Photon · © OpenStreetMap contributors</div>
          )}
        </div>
      )}
    </div>
  );
}
