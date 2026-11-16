import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { meshExtentAttr, plantSessionCreateRequest, seedForNewPlant } from './plantRegeneration';

describe('plantRegeneration', () => {
  it('regrows a plant with its own seed', () => {
    const req = plantSessionCreateRequest(
      { plantType: 'bean', plantPosition: { x: 1, y: 2, z: 3 }, plantSeed: 4242 }, 15);
    expect(req).toMatchObject({ plant_type: 'bean', initial_age: 15, random_seed: 4242,
      position_x: 1, position_y: 2, position_z: 3 });
  });

  it('picks a seed before generating, keeping the user\'s when given', () => {
    expect(seedForNewPlant(7)).toBe(7);
    expect(seedForNewPlant(0)).toBe(0);
    expect(seedForNewPlant(undefined, () => 0.5)).toBe(500_000);
  });

  it('fingerprints geometry by its extent, once per vertex buffer', () => {
    const data = { vertices: new Float32Array([0, 0, 0, 1, 2, 3, -1, 0.5, 2]), vertexCount: 3 };
    expect(meshExtentAttr(data)).toBe('-1.000,0.000,0.000,1.000,2.000,3.000');
    data.vertices[0] = 99; // same buffer: cached, not rescanned
    expect(meshExtentAttr(data)).toBe('-1.000,0.000,0.000,1.000,2.000,3.000');
  });
});

describe('the viewer regrows and frees plant sessions correctly', () => {
  it('creates every plant session through the seeded builder and generates with the recorded seed', async () => {
    const src = (await readFile(join(process.cwd(), 'src/renderer/components/PointCloudViewer.tsx'), 'utf8'))
      .replace(/\0/g, '');
    const creates = src.match(/createPlantSession\(/g) ?? [];
    const seeded = src.match(/createPlantSession\(plantSessionCreateRequest\(mesh, /g) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    expect(seeded.length).toBe(creates.length);
    // The seed the mesh records is the one the plant was generated with.
    expect(src).toMatch(/const seed = seedForNewPlant\(requestedSeed\)/);
    expect(src).toMatch(/generatePlantStreaming\(\s*seededPayload,/);
    expect(src).toMatch(/plantSeed: seed,/);
    // A replaced session is freed, and a lost session falls back to regrowing.
    expect(src).toMatch(/const releaseOldSession = \(\) =>/);
    expect((src.match(/releaseOldSession\(\);/g) ?? []).length).toBe(2);
    expect(src).toMatch(/response = await advancePlantSession\(mesh\.plantSessionId, dt\);\s*\} catch \(err\) \{/);
  });
});
