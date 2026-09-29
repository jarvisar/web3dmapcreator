// Width, height and viewBox are all in mm so the file imports at true size.
// Every group is an Inkscape layer. Plotter files get one numbered layer per pen
// colour ("1 - pen #000000"), which AxiDraw, vpype and saxi read as pen changes.
import type { OutputGroup, RenderResult } from '../result';
import { escapeXml, fmt } from './format';

function describe(result: RenderResult): string {
  const m = result.meta;
  const lat = `${Math.abs(m.centre.lat).toFixed(5)}°${m.centre.lat >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(m.centre.lon).toFixed(5)}°${m.centre.lon >= 0 ? 'E' : 'W'}`;
  return (
    `Map data ${m.attribution} (ODbL, openstreetmap.org/copyright). Vector tiles OpenMapTiles. ` +
    `Made with Jarvizar City Model. Centre ${lat} ${lon}, bearing ${fmt(m.bearing)}°, scale 1:${m.scale}, ` +
    `map area ${(m.widthM / 1000).toFixed(2)} x ${(m.heightM / 1000).toFixed(2)} km. ` +
    `Canvas ${fmt(result.width)} x ${fmt(result.height)} mm: check the imported size matches.`
  );
}

function groupAttributes(group: OutputGroup): string {
  const color = escapeXml(group.color);
  if (group.kind === 'fill') return `fill="${color}" stroke="none"`;
  return (
    `fill="none" stroke="${color}" stroke-width="${fmt(group.strokeWidth)}" ` +
    'stroke-linecap="round" stroke-linejoin="round"'
  );
}

function pathElements(group: OutputGroup, indent: string): string[] {
  return group.paths.map((p) => {
    const width = p.strokeWidth !== undefined ? ` stroke-width="${fmt(p.strokeWidth)}"` : '';
    const cls = p.cls ? ` data-class="${escapeXml(p.cls)}"` : '';
    return `${indent}<path${cls}${width} d="${p.d}"/>`;
  });
}

export function toSvg(result: RenderResult): string {
  const w = fmt(result.width);
  const h = fmt(result.height);
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ` +
      `width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">`,
    `  <title>${escapeXml(result.meta.title || 'Map')}</title>`,
    `  <desc>${escapeXml(describe(result))}</desc>`,
  ];
  if (result.background) {
    out.push(`  <rect id="background" width="${w}" height="${h}" fill="${escapeXml(result.background)}"/>`);
  }

  if (result.mode === 'plotter') {
    const pens: { color: string; groups: OutputGroup[] }[] = [];
    for (const group of result.groups) {
      let pen = pens.find((p) => p.color === group.color);
      if (!pen) {
        pen = { color: group.color, groups: [] };
        pens.push(pen);
      }
      pen.groups.push(group);
    }
    pens.forEach((pen, index) => {
      const width = pen.groups[0]?.strokeWidth ?? 0.3;
      const name = `${index + 1} - pen ${pen.color}`;
      out.push(
        `  <g id="pen${index + 1}" inkscape:groupmode="layer" inkscape:label="${escapeXml(name)}" ` +
          `fill="none" stroke="${escapeXml(pen.color)}" stroke-width="${fmt(width)}" stroke-linecap="round" stroke-linejoin="round">`,
      );
      for (const group of pen.groups) {
        out.push(`    <g id="${group.id}" inkscape:label="${escapeXml(group.label)}">`);
        out.push(...pathElements(group, '      '));
        out.push('    </g>');
      }
      out.push('  </g>');
    });
  } else {
    for (const group of result.groups) {
      out.push(
        `  <g id="${group.id}" inkscape:groupmode="layer" inkscape:label="${escapeXml(group.label)}" ${groupAttributes(group)}>`,
      );
      out.push(...pathElements(group, '    '));
      out.push('  </g>');
    }
  }
  out.push('</svg>', '');
  return out.join('\n');
}
