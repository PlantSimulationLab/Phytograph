import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as THREE from 'three';
import { columnsToSourceRows, displayRowsOf, gatherScalarFields, recordDisplayRows } from './displayRows';
import type { PointCloudData } from './pointCloudTypes';

const box = { min: new THREE.Vector3(), max: new THREE.Vector3(), center: new THREE.Vector3(), size: new THREE.Vector3() };
const display = (n: number): PointCloudData =>
  ({ positions: new Float32Array(n * 3), pointCount: n, bounds: box } as PointCloudData);

describe('displayRows', () => {
  it('gathers a display copy\'s scalar fields by its rows', () => {
    const fields = {
      is_miss: { values: Float32Array.from([0, 1, 0, 0, 1]), min: 0, max: 1 },
      reflectance: { values: Float32Array.from([10, 11, 12, 13, 14]), min: 10, max: 14 },
    };
    const out = gatherScalarFields(fields, Uint32Array.from([0, 1, 4]))!;
    expect(Array.from(out.is_miss.values)).toEqual([0, 1, 1]);
    expect(Array.from(out.reflectance.values)).toEqual([10, 11, 14]);
  });

  it('writes a result computed on the copy back onto the source rows', () => {
    const d = display(3);
    recordDisplayRows(d, Uint32Array.from([0, 2, 4]));   // rows 1 and 3 erased
    const out = columnsToSourceRows({ wood_class: { values: Float32Array.from([1, 2, 1]), min: 1, max: 2 } }, d, 5);
    expect(Array.from(out.wood_class.values)).toEqual([1, 0, 2, 0, 1]);
    const noisy = columnsToSourceRows({ noise: { values: Float32Array.from([2, 2, 2]), min: 1, max: 2 } }, d, 5, 1);
    expect(Array.from(noisy.noise.values)).toEqual([2, 1, 2, 1, 2]);
  });

  it('passes a column through when the copy holds every row (translation only)', () => {
    const d = display(3);
    const col = { values: Float32Array.from([1, 2, 3]), min: 1, max: 3 };
    expect(displayRowsOf(d)).toBeUndefined();
    expect(columnsToSourceRows({ c: col }, d, 3).c).toBe(col);
  });
});

describe('flat-cloud tools write onto the cloud itself', () => {
  it('never replaces a cloud with its display copy, and keeps the copy\'s columns', async () => {
    const src = (await readFile(join(process.cwd(), 'src/renderer/components/PointCloudViewer.tsx'), 'utf8'))
      .replace(/\0/g, '');
    // The display copy carries its scalar fields (misses excluded at compute)
    // and records which rows it holds.
    expect(src).toMatch(/scalarFields: rows \? gatherScalarFields\(data\.scalarFields, rows\) : data\.scalarFields/);
    expect(src).toMatch(/if \(rows\) recordDisplayRows\(display, rows\);/);
    // No write-back spreads a display copy into the cloud.
    expect(src).not.toMatch(/onUpdateCloud\([^,]+, \{\s*\.\.\.(displayData|d|cd|f\.displayData),/);
    // noise, ground, DEM height, wood (together and per cloud), organs, trees.
    expect((src.match(/writeFlatColumns\(/g) ?? []).length).toBe(7);
    // The display copy already carries a pending translation; nothing adds it again.
    expect(src).not.toMatch(/inlineParts\.push\(\[pt\[0\] \+ t\.x, pt\[1\] \+ t\.y, pt\[2\] \+ t\.z\]\)/);
  });

  it('marks a cloud edited the moment a session edit commits', async () => {
    const src = (await readFile(join(process.cwd(), 'src/renderer/components/PointCloudViewer.tsx'), 'utf8'))
      .replace(/\0/g, '');
    // Erase, label strokes, and deferred normals / scalar fields all change the
    // session without (yet) rebuilding the octree; recovery must not then
    // rebuild a lost octree from the source file.
    expect(src).toMatch(/deleted_count;\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*onMarkScanEdited\(cloud\.id\);/);
    expect(src).toMatch(/const markLabelsChanged = useCallback\([\s\S]{0,700}onMarkScanEdited\(cloudId\);/);
    expect((src.match(/onMarkScanEdited\(id\);/g) ?? []).length).toBe(2);
  });
});
