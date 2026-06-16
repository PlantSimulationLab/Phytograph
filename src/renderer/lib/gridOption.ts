import type { HeliosGrid } from '../utils/backendApi';

// A voxel box the user can pick as the triangulation / LAD grid. The caller
// derives `grid` from the box's transform + subdivisions (see
// voxelMeshToHeliosGrid). Shared by the triangulation and LAD modals.
export interface GridOption {
  id: string;        // mesh id of the voxel box
  label: string;     // human-readable label (name + dimensions)
  grid: HeliosGrid;
}
