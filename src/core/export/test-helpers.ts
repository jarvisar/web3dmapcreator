// Fixtures and readers for the export tests and scripts/check-bambu.ts.

import { strFromU8, unzipSync } from 'fflate';
import type { MaterialRole, MeshPart, Plate } from '../types';

export interface Mesh {
  positions: number[];
  indices: number[];
}

/** A closed, outward-wound box. */
export function box(x: number, y: number, z: number, width: number, depth: number, height: number): Mesh {
  const positions = [
    x, y, z, x + width, y, z, x + width, y + depth, z, x, y + depth, z,
    x, y, z + height, x + width, y, z + height, x + width, y + depth, z + height, x, y + depth, z + height,
  ];
  const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { positions, indices };
}

/** Independent solids in one part, never welded. */
export function part(id: string, name: string, role: MaterialRole, ...meshes: Mesh[]): MeshPart {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const mesh of meshes) {
    const offset = positions.length / 3;
    positions.push(...mesh.positions);
    indices.push(...mesh.indices.map((i) => i + offset));
  }
  return { id, name, role, positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

export function plate(name: string, parts: MeshPart[], bounds: [number, number, number, number]): Plate {
  return { name, parts, bounds };
}

export async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

export async function unzip(data: Blob): Promise<Record<string, Uint8Array>> {
  return unzipSync(await blobBytes(data));
}

export async function unzipText(data: Blob): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(await unzip(data))) out[name] = strFromU8(bytes);
  return out;
}

export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (whole, name: string) => {
    if (name.startsWith('#x')) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(parseInt(name.slice(1), 10));
    return ENTITIES[name] ?? whole;
  });
}

/**
 * Enough XML for 3MF parts: elements, attributes and text. No DTDs. Tags keep
 * their prefixes ("p:path"), since the files use fixed prefixes.
 */
export function parseXml(source: string): XmlNode {
  const root: XmlNode = { tag: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([^\s/>]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  const attribute = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let match = token.exec(source); match; match = token.exec(source)) {
    const [, cdata, closing, tag, rest, selfClosing, text] = match;
    const top = stack[stack.length - 1];
    if (cdata !== undefined) top.text += cdata;
    else if (text !== undefined) top.text += decode(text);
    else if (tag !== undefined) {
      if (closing) {
        if (top.tag !== tag) throw new Error(`Mismatched </${tag}> inside <${top.tag}>`);
        stack.pop();
        continue;
      }
      const node: XmlNode = { tag, attrs: {}, children: [], text: '' };
      for (let a = attribute.exec(rest); a; a = attribute.exec(rest)) node.attrs[a[1]] = decode(a[2] ?? a[3]);
      attribute.lastIndex = 0;
      top.children.push(node);
      if (!selfClosing) stack.push(node);
    }
  }
  if (stack.length !== 1) throw new Error(`Unclosed <${stack[stack.length - 1].tag}>`);
  return root;
}

/** Descendants with a tag, depth first. */
export function findAll(node: XmlNode, tag: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode) => {
    for (const child of n.children) {
      if (child.tag === tag) out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

export function child(node: XmlNode, tag: string): XmlNode | undefined {
  return node.children.find((c) => c.tag === tag);
}

/** value of <metadata key="..." value="..."/> among a node's children. */
export function metadataValue(node: XmlNode, key: string): string | undefined {
  return node.children.find((c) => c.tag === 'metadata' && c.attrs.key === key)?.attrs.value;
}
