// Three decimals of a millimetre is a micron. Finer than any laser or pen, and
// it keeps file sizes down.
export function fmt(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  if (rounded === 0) return '0';
  return String(rounded);
}

export function polylineD(points: readonly (readonly [number, number])[], closed = false): string {
  if (points.length === 0) return '';
  let d = `M${fmt(points[0][0])},${fmt(points[0][1])}`;
  for (let i = 1; i < points.length; i++) d += `L${fmt(points[i][0])},${fmt(points[i][1])}`;
  return closed ? d + 'Z' : d;
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
