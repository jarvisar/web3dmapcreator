// Names for what's selected, as the inspector and the hover tip show them.

import { kindOf, objectOf, type ObjectKind } from '../../../core/edit/keys';
import type { AddedShape, ModelEdits } from '../../../core/edit/types';
import type { EditData } from '../../state/model';

export interface Described {
  kind: ObjectKind;
  title: string;
  detail: string;
}

const ROAD_CLASSES: Record<string, string> = {
  motorway: 'Motorway',
  trunk: 'Trunk road',
  primary: 'Primary road',
  secondary: 'Secondary road',
  tertiary: 'Tertiary road',
  residential: 'Residential street',
  living_street: 'Living street',
  unclassified: 'Minor road',
  service: 'Service road',
  pedestrian: 'Pedestrian street',
  footway: 'Footway',
  sidewalk: 'Sidewalk',
  crosswalk: 'Crossing',
  steps: 'Steps',
  path: 'Path',
  track: 'Track',
  cycleway: 'Cycleway',
  bridleway: 'Bridleway',
  rail: 'Railway',
  raceway: 'Racetrack',
  unknown: 'Road',
};

export const SHAPE_NAMES: Record<AddedShape['kind'], string> = {
  text: 'Text',
  box: 'Box',
  cylinder: 'Cylinder',
  pin: 'Map pin',
  path: 'Drawn road',
  area: 'Drawn outline',
};

export const KIND_NAMES: Record<ObjectKind, [string, string]> = {
  building: ['building', 'buildings'],
  road: ['road', 'roads'],
  bridge: ['bridge', 'bridges'],
  water: ['body of water', 'bodies of water'],
  tree: ['tree', 'trees'],
  rock: ['rock', 'rocks'],
  shape: ['shape', 'shapes'],
};

function titleCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1).replace(/_/g, ' ');
}

export function roadClassName(cls: string): string {
  return ROAD_CLASSES[cls] ?? titleCase(cls || 'road');
}

export function describeKey(key: string, data: EditData, edits: ModelEdits): Described {
  const kind = kindOf(key) ?? 'building';
  const object = objectOf(key);
  const facts = data.objects[object];
  switch (kind) {
    case 'building': {
      const part = key !== object;
      const title = facts?.name || (facts?.detail ? titleCase(facts.detail) : 'Building');
      const detail = [part ? 'One part' : facts?.name && facts.detail ? titleCase(facts.detail) : '', facts?.measured ? 'measured with LiDAR' : '']
        .filter(Boolean)
        .join(', ');
      return { kind, title: part ? `${title} (part)` : title, detail };
    }
    case 'road': {
      const lines = data.roads;
      const piece = lines ? lines.keys.indexOf(key) : -1;
      if (!lines || piece < 0) return { kind, title: 'Road', detail: '' };
      const cls = roadClassName(lines.classes[piece]);
      return { kind, title: lines.names[piece] || cls, detail: lines.names[piece] ? cls : '' };
    }
    case 'bridge':
      return { kind, title: facts?.name ? `${facts.name} bridge` : 'Bridge', detail: facts?.detail ? roadClassName(facts.detail) : '' };
    case 'water':
      return { kind, title: facts?.name || facts?.detail || 'Water', detail: facts?.name ? (facts.detail ?? '') : '' };
    case 'tree':
      return { kind, title: 'Tree', detail: key.startsWith('t:f') ? 'In a forest' : 'Mapped tree' };
    case 'rock':
      return { kind, title: 'Rock', detail: 'Measured with LiDAR' };
    case 'shape': {
      const shape = edits.shapes.find((s) => `s:${s.id}` === key);
      if (!shape) return { kind, title: 'Shape', detail: '' };
      return { kind, title: shape.kind === 'text' ? `“${shape.text || 'Text'}”` : SHAPE_NAMES[shape.kind], detail: shape.kind === 'text' ? 'Text' : 'Added shape' };
    }
  }
}

/** "3 buildings and 2 roads" */
export function describeCounts(keys: string[]): string {
  const counts = new Map<ObjectKind, number>();
  for (const key of keys) {
    const kind = kindOf(key) ?? 'building';
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const parts = [...counts].map(([kind, n]) => (n === 1 ? `1 ${KIND_NAMES[kind][0]}` : `${n} ${KIND_NAMES[kind][1]}`));
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
