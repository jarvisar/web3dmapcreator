import { MeshBasicMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { ComposedMesh } from './composed';

// Two objects of one triangle each, and a third triangle belonging to nothing.
const source = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0, 4, 0, 0, 5, 0, 0, 4, 1, 0]),
  indices: Uint32Array.of(0, 1, 2, 3, 4, 5, 6, 7, 8),
  objects: { keys: ['a', 'b'], subs: ['', ''], runs: Uint32Array.of(0, 0, 1, 0, 3, 1, 1, 2, 3, 6) },
};

function composed() {
  return new ComposedMesh(source, false, () => new MeshBasicMaterial());
}

describe('ComposedMesh', () => {
  it('draws only what is shown, and objects in their colours', () => {
    const mesh = composed();
    mesh.update(() => '');
    expect(mesh.geometry.index!.count).toBe(9);
    expect(mesh.groupKeys).toEqual([{ colour: '', wall: false }]);
    mesh.update((entry) => (entry.key === 'b' ? 'layer:x' : ''));
    expect(mesh.groupKeys.map((g) => g.colour)).toEqual(['', 'layer:x']);
  });

  it('hides an object that goes from its part colour to hidden', () => {
    const mesh = composed();
    mesh.update(() => '');
    // Hidden and the part's own colour ('') once looked the same to the change check.
    expect(mesh.update((entry) => (entry.key === 'a' ? null : ''))).toBe(true);
    expect(mesh.geometry.index!.count).toBe(6);
    expect(mesh.update((entry) => (entry.key === 'a' ? null : ''))).toBe(false);
    expect(mesh.update(() => '')).toBe(true);
    expect(mesh.geometry.index!.count).toBe(9);
  });

  it('keeps triangles that belong to no object', () => {
    const mesh = composed();
    mesh.update(() => null);
    expect(mesh.geometry.index!.count).toBe(3);
  });

  it('hides the triangles no object owns on their own, for a hidden part', () => {
    const mesh = composed();
    mesh.update(() => '');
    expect(mesh.update(() => '', null)).toBe(true);
    expect(mesh.geometry.index!.count).toBe(6);
    expect(mesh.update(() => '', '')).toBe(true);
    expect(mesh.geometry.index!.count).toBe(9);
  });

  it('gives the box around what is shown, for framing and the size', () => {
    const mesh = composed();
    mesh.update(() => '');
    expect(mesh.shownBounds()).toEqual([0, 0, 0, 5, 1, 0]);
    // The unowned triangle is the one from x 4 to 5.
    mesh.update(() => '', null);
    expect(mesh.shownBounds()).toEqual([0, 0, 0, 3, 1, 0]);
    mesh.update((entry) => (entry.key === 'a' ? null : ''), null);
    expect(mesh.shownBounds()).toEqual([2, 0, 0, 3, 1, 0]);
    mesh.update(() => null, null);
    expect(mesh.shownBounds()).toBeNull();
    expect(Array.from(mesh.entryCentres())).toEqual([0.5, 0.5, 0, 2.5, 0.5, 0]);
  });
});
