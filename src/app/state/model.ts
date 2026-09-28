// The generated mesh arrays live outside the store: they can be hundreds of
// megabytes and nothing should re-render because of them. The viewer reads
// them when the result version in the store changes.

import type { MeshPart } from '../../core/types';

let parts: MeshPart[] = [];

export function setModelParts(next: MeshPart[]): void {
  parts = next;
}

export function getModelParts(): MeshPart[] {
  return parts;
}
