const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Up to `decimals` decimals, trailing zeros dropped. */
export function formatNumber(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return '';
  const fixed = value.toFixed(decimals);
  return decimals > 0 ? fixed.replace(/\.?0+$/, '') : fixed;
}

export function formatInteger(value: number): string {
  return integer.format(Math.round(value));
}

/** "2.13 × 1.57 km", or metres when both sides are under a kilometre. */
export function formatSizePair(widthM: number, heightM: number): string {
  if (Math.max(widthM, heightM) >= 1000) {
    return `${(widthM / 1000).toFixed(2)} × ${(heightM / 1000).toFixed(2)} km`;
  }
  return `${Math.round(widthM)} × ${Math.round(heightM)} m`;
}

export function formatDistance(metres: number): string {
  if (metres >= 1000) return `${(metres / 1000).toFixed(2)} km`;
  return `${Math.round(metres)} m`;
}

export function formatMm(value: number): string {
  if (value >= 100) return formatInteger(value);
  if (value >= 10) return value.toFixed(0);
  return formatNumber(value, 1);
}

export function formatMmPair(width: number, depth: number): string {
  return `${formatMm(width)} × ${formatMm(depth)} mm`;
}

/** 0.07 mm per metre is "1:14,286". */
export function formatRatio(mmPerMetre: number): string {
  if (!(mmPerMetre > 0)) return '1:?';
  return `1:${formatInteger(1000 / mmPerMetre)}`;
}

export function formatCount(value: number): string {
  if (value >= 1e6) return `${formatNumber(value / 1e6, value >= 1e7 ? 0 : 1)}M`;
  if (value >= 1e4) return `${Math.round(value / 1000)}k`;
  return formatInteger(value);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${formatNumber(bytes / (1024 * 1024), 1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function formatSeconds(seconds: number): string {
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60) return `${formatNumber(seconds, 1)} s`;
  return formatElapsed(seconds);
}

/** Loose decimal parse: accepts commas as thousands separators and unicode minus signs. */
export function parseDecimal(text: string): number | null {
  const cleaned = text.replace(/[−–﹣－]/g, '-').replace(/[\s,]/g, '').trim();
  if (!cleaned || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

export function capitalise(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/** "a, b and c" */
export function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const NBSP = String.fromCharCode(0xa0);

/** Non-breaking spaces between numbers and units, so "0.4 mm" never wraps apart. */
export function keepUnits(text: string): string {
  return text.replace(/(\d) (mm|m²|km|m|%|°)(?![a-z])/g, '$1' + NBSP + '$2');
}
