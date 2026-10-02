// Just enough XML for GPX, KML and TCX, from SVGmap. DOMParser isn't there in
// a worker or in Node, and these files are simple: elements, attributes, text
// and CDATA. Names lose their namespace prefix, so gx:Track is Track.

export interface XmlVisitor {
  open(name: string, attrs: Record<string, string>): void;
  close(name: string): void;
  text(text: string): void;
}

const TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE(?:[^>[]|\[[\s\S]*?\])*>|<(\/?)([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTRIBUTE = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITY = /&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi;
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

const localName = (name: string) => name.slice(name.indexOf(':') + 1);

export function xmlRoot(source: string): string {
  const token = new RegExp(TOKEN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = token.exec(source)) !== null) {
    if (match[3] && !match[2]) return localName(match[3]);
  }
  return '';
}

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY, (whole, entity: string) => {
    if (entity[0] !== '#') return NAMED[entity.toLowerCase()] ?? whole;
    const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

export function walkXml(source: string, visitor: XmlVisitor): void {
  const token = new RegExp(TOKEN.source, 'g');
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = token.exec(source)) !== null) {
    if (match.index > last) visitor.text(decodeEntities(source.slice(last, match.index)));
    last = token.lastIndex;
    const [, cdata, slash, name, attributes, selfClosing] = match;
    if (cdata !== undefined) {
      visitor.text(cdata);
      continue;
    }
    // A comment, declaration or doctype.
    if (name === undefined) continue;
    const local = localName(name);
    if (slash) {
      visitor.close(local);
      continue;
    }
    const attrs: Record<string, string> = {};
    if (attributes) {
      const attribute = new RegExp(ATTRIBUTE.source, 'g');
      let a: RegExpExecArray | null;
      while ((a = attribute.exec(attributes)) !== null) attrs[localName(a[1])] = decodeEntities(a[2] ?? a[3] ?? '');
    }
    visitor.open(local, attrs);
    if (selfClosing) visitor.close(local);
  }
  if (last < source.length) visitor.text(decodeEntities(source.slice(last)));
}
