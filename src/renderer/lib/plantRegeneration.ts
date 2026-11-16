// Rebuilding a generated plant at another age.
//
// A Helios Context starts time-seeded, so a plant session created without the
// plant's seed grows a DIFFERENT random plant. That is what Age− (and Age+ on
// any reopened project, whose plant sessions are not saved) used to do, while
// the growth animation and GIF export passed the seed. One builder for every
// session request, so none can leave it out.
import type { PlantSessionCreateRequest } from '../utils/backendApi';
import type { MeshEntry } from './pointCloudTypes';

export type RegenerablePlant = Pick<
  MeshEntry, 'plantType' | 'plantPosition' | 'plantSeed' | 'plantLeafInclination'
>;

/** The session request that regrows `plant` at `age`, seeded with its own seed. */
export function plantSessionCreateRequest(plant: RegenerablePlant, age: number): PlantSessionCreateRequest {
  return {
    plant_type: plant.plantType!,
    initial_age: age,
    position_x: plant.plantPosition?.x ?? 0,
    position_y: plant.plantPosition?.y ?? 0,
    position_z: plant.plantPosition?.z ?? 0,
    random_seed: plant.plantSeed,
    leaf_inclination: plant.plantLeafInclination,
  };
}

const extentCache = new WeakMap<object, string>();

/**
 * "minx,miny,minz,maxx,maxy,maxz" of a mesh's vertices (mm), computed once per
 * vertex buffer. A geometric fingerprint for the Meshes panel's
 * `data-mesh-extent`: two random plants of one species can share a triangle
 * count while their geometry differs, so a count cannot tell them apart.
 */
export function meshExtentAttr(data: { vertices: ArrayLike<number>; vertexCount: number }): string {
  const cached = extentCache.get(data.vertices as object);
  if (cached !== undefined) return cached;
  const v = data.vertices;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < data.vertexCount; i++) {
    for (let k = 0; k < 3; k++) {
      const x = v[i * 3 + k];
      if (x < lo[k]) lo[k] = x;
      if (x > hi[k]) hi[k] = x;
    }
  }
  const out = data.vertexCount > 0 ? [...lo, ...hi].map(x => x.toFixed(3)).join(',') : '';
  extentCache.set(data.vertices as object, out);
  return out;
}

/**
 * The seed a new plant is generated with: the user's, else a fresh one. Chosen
 * BEFORE generating and sent with the request, so the seed recorded on the mesh
 * is the one the plant was actually grown from. Recording a random seed after a
 * time-seeded build made every later regeneration a different plant.
 */
export function seedForNewPlant(requested: number | null | undefined, random: () => number = Math.random): number {
  return requested ?? Math.floor(random() * 1_000_000);
}
