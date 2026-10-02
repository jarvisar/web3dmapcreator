// Road edits have to be written through writeRoads (core/edit/blocks.ts).
// Written straight into the edits, a colour set on a whole street doesn't
// clear the blocks inside it that have their own, and a block put back
// isn't carved out of the street's edit around it, so the change seems to
// do nothing. This finds every place in src that writes into an edits'
// objects and fails on one that isn't listed here with the reason it doesn't
// need writeRoads. A new one either goes through writeRoads or gets a reason.
//
// It matches the ways the code writes them now (\`objects[key] =\`, \`delete
// objects[key]\`, \`.objects =\`), so a write some other way (Object.assign,
// a spread with a computed key) gets past it.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ALLOWED: Record<string, Record<string, string>> = {
  'src/app/state/editActions.ts': {
    putObjects: 'puts keys back as an earlier edits object had them, for the Undo on a toast',
    patchedObjects: "writes keys that aren't roads. Roads go through writeRoads first",
    resetObjects: 'drops every edit of a whole road segment, its ranges and splits with it',
    removeObjects: "removes keys that aren't roads. Roads go through writeRoads first",
    restoreObjects: "puts back keys that aren't roads, and the bridges of roads put back",
    replaceWithDrawnRoads: 'keeps a bridge, which is not a road key',
    deleteLayer: 'takes one layer off every edit that has it. Everything in the layer leaves it, so nothing needs carving',
  },
  'src/app/state/history.ts': {
    applyStep: 'undo and redo put keys back as they were',
  },
  'src/app/state/linkScope.ts': {
    editsForArea: 'copies the edits a link carries, as they are',
  },
  'src/core/edit/types.ts': {
    sanitizeEdits: 'reads saved, linked and imported edits as they come',
    mergeEdits: 'adds edits from a link or file to these, theirs winning a key at a time',
  },
  // Not edits: a mesh part's objects, and the objects a generation describes.
  'src/core/pipeline/mesh.ts': { '*': 'part.objects is the triangles of each object, not edits' },
  'src/worker/engine.worker.ts': { '*': 'result.objects is what the model describes, not edits' },
};

const WRITE = /\bobjects\[[^\]]+\]\s*=[^=]|delete\s+[\w.]*objects\[|\.objects\s*=[^=]/;
// Top-level functions and class methods. Helpers declared inside one count as it.
const FUNCTION = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^ {2}(?:private\s+|public\s+)?(?:async\s+)?(\w+)\s*\([^)]*\)[^=]*\{\s*$|^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('road edits', () => {
  it('are only written into the edits through writeRoads, or where a reason says why not', () => {
    const unlisted: string[] = [];
    for (const path of files('src')) {
      const file = relative('.', path).replace(/\\/g, '/');
      if (file === 'src/core/edit/blocks.ts') continue;
      const lines = readFileSync(path, 'utf8').split(/\r?\n/);
      let inside = '';
      lines.forEach((line, i) => {
        const fn = FUNCTION.exec(line);
        if (fn && !/^\s*(if|for|while|switch|catch)\b/.test(line)) inside = fn[1] ?? fn[2] ?? fn[3] ?? inside;
        if (!WRITE.test(line)) return;
        const allowed = ALLOWED[file];
        if (allowed?.['*'] || allowed?.[inside]) return;
        unlisted.push(`${file}:${i + 1} in ${inside || 'the module'}: ${line.trim()}`);
      });
    }
    expect(unlisted, 'Write road edits through writeRoads (core/edit/blocks.ts), or list the function with the reason it needs none').toEqual([]);
  });

  it('notices a write that bypasses writeRoads', () => {
    expect(WRITE.test("  objects['r:abc'] = { layer: 'L' };")).toBe(true);
    expect(WRITE.test('  delete edits.objects[key];')).toBe(true);
    expect(WRITE.test('  if (objects[key] === edit) return;')).toBe(false);
  });
});
