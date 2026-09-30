import { describe, expect, it } from 'vitest';
import type { EditUpdate } from '../../core/engine/protocol';
import { applyEditUpdate, currentEditState, setModelParts } from './model';

const mesh = (x: number) => ({ positions: Float32Array.of(x, 0, 0, x + 1, 0, 0, x, 1, 0), indices: Uint32Array.of(0, 1, 2) });

function update(version: number, rest: Partial<EditUpdate> = {}): EditUpdate {
  return { model: 7, version, objects: [], parts: [], hidden: [], notes: {}, warnings: [], ...rest };
}

describe('edit geometry kept for the viewer', () => {
  it("keeps a bridge's deck and piers apart, since they share a key", () => {
    setModelParts([], undefined, undefined, 7);
    applyEditUpdate(
      update(1, {
        objects: [
          { key: 'br:1', part: 'roads', mesh: mesh(0) },
          { key: 'br:1', part: 'piers', mesh: mesh(5) },
        ],
      }),
    );
    // A viewer opened later (or after a new model) replays both.
    expect(currentEditState().objects.map((o) => o.part).sort()).toEqual(['piers', 'roads']);
    applyEditUpdate(update(2, { objects: [{ key: 'br:1', part: 'piers', mesh: null }] }));
    expect(currentEditState().objects.map((o) => o.part)).toEqual(['roads']);
  });

  it('drops what came before an update that sends everything again', () => {
    setModelParts([], undefined, undefined, 7);
    applyEditUpdate(update(1, { objects: [{ key: 'b:1', part: 'buildings', mesh: mesh(0) }], parts: [{ id: 'roads', part: null }] }));
    applyEditUpdate(update(2, { reset: true, objects: [{ key: 'b:2', part: 'buildings', mesh: mesh(3) }] }));
    const state = currentEditState();
    expect(state.objects.map((o) => o.key)).toEqual(['b:2']);
    expect(state.parts).toEqual([]);
    expect(state.reset).toBe(true);
  });

  it("ignores updates for another model or an older version", () => {
    setModelParts([], undefined, undefined, 7);
    expect(applyEditUpdate(update(3, { objects: [{ key: 'b:1', part: 'buildings', mesh: mesh(0) }] }))).toBe(true);
    expect(applyEditUpdate(update(2, { objects: [{ key: 'b:2', part: 'buildings', mesh: mesh(0) }] }))).toBe(false);
    expect(applyEditUpdate({ ...update(4), model: 6 })).toBe(false);
    expect(currentEditState().objects.map((o) => o.key)).toEqual(['b:1']);
  });
});
