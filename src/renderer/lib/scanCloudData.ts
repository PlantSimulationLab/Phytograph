// A synthetic scan's per-scanner result as PointCloudData.
//
// Pure (no React state): it lived inside PointCloudViewer as a dependency-free
// useCallback, and moved here so what it keeps alive can be tested.
import * as THREE from 'three';
import type { LidarScanResult } from '../utils/backendApi';
import type { PointCloudData } from './pointCloudTypes';
import { assembleScanScalarFields } from './pointCloudHelpers';
import { STANDARD_HIT_FIELD_SLUGS } from './scanHitFields';

/**
 * Build PointCloudData from one scanner's scan result: bounds, and either the
 * octree ref of the cloud session the scan was routed through, or (with no
 * session) positions, RGB colors, a dedicated `intensities` array (so "color by
 * intensity" works) and the rest of the per-hit scalars as named scalarFields.
 */
export function buildScanCloudData(
  result: LidarScanResult, fileName: string, retainedFields: string[],
): PointCloudData | null {
  const n = result.numPoints;
  if (n === 0) return null;

  // Points arrive as a flat xyz Float32Array (zero-copy from the binary frame).
  const positions = result.points;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  // A session-backed scan keeps NO flat arrays, exactly like an imported octree
  // cloud (buildPointCloudFromOctree): OctreePointCloud draws it and every tool
  // reads it by session_id. The arrays below are zero-copy views over the WHOLE
  // response buffer (every scanner's points, colors and scalars), so keeping
  // any one of them pinned all of it, ~45 B per point (about 0.9 GB for a 20 M-
  // point scan), for as long as the scan or an undo step held the data.
  // Only with a real octree: the backend registers the session first and builds
  // the octree best-effort (_create_lidar_scan_session), so a failed
  // PotreeConverter run leaves a session with no cache_id, whose flat points
  // are then the only renderable copy.
  const keepFlat = !(result.session?.session_id && result.session.cache_id);
  const colors = keepFlat && result.colors && result.colors.length === n * 3 ? result.colors : undefined;

  // Turn each returned scalar list into a ScalarField, honoring the user's
  // retained-fields selection: unchecked standard fields are pruned, and
  // checked fields are kept even when constant (so e.g. a single-sweep
  // `timestamp` still shows in Color by). `intensity` also populates the
  // dedicated `intensities` array used by the intensity color mode + filter.
  // (A session-backed scan's fields are its octree attributes, set below.)
  const { scalarFields, intensities } = keepFlat
    ? assembleScanScalarFields(result.scalars, n, retainedFields, STANDARD_HIT_FIELD_SLUGS)
    : { scalarFields: {}, intensities: undefined };

  // Every synthetic scan with hits is routed through an octree-backed cloud
  // session (like an imported cloud); attach the octree ref carrying the cache
  // id + session id + miss flag + projected-miss octree id so it renders via
  // OctreePointCloud and session-backed ops (triangulation, LAD, crop, the
  // MissOctree overlay) read the points by session_id instead of serializing
  // the whole cloud inline. `result.session` is absent only when the scan
  // returned no hits or the octree build failed, leaving a plain flat cloud.
  let octree: PointCloudData['octree'];
  const session = result.session;
  if (session?.session_id) {
    // Surface the octree's per-attribute ranges + labels so the Color-by
    // dropdown can offer the retained per-hit scalar fields (timestamp,
    // target_index, …). The picker reads these off the octree ref for octree-
    // backed clouds (octreeScalarFieldOptions) rather than the flat
    // scalarFields map, so without them a synthetic-scan cloud shows no scalar
    // options at all — including constant-valued retained fields. Mirrors the
    // meta.attributes → attributeRanges/labels conversion in pointCloudParsers.
    const attributeRanges: Record<string, { min: number[]; max: number[] }> = {};
    const attributeLabels: Record<string, string> = {};
    for (const a of session.attributes ?? []) {
      if (Array.isArray(a.min) && Array.isArray(a.max)) {
        attributeRanges[a.name] = { min: a.min, max: a.max };
      }
      if (a.label) attributeLabels[a.name] = a.label;
    }
    octree = {
      cacheId: session.cache_id ?? session.session_id,
      sourceXyzPath: session.cache_dir ?? '',
      sessionId: session.session_id,
      hasMisses: Boolean(session.has_misses),
      scanOrigin: session.scan_origin ?? null,
      missOctreeCacheId: session.miss_octree_cache_id ?? null,
      ...(Object.keys(attributeRanges).length > 0 ? { attributeRanges } : {}),
      ...(Object.keys(attributeLabels).length > 0 ? { attributeLabels } : {}),
      // The colorbar's outlier-resistant per-attribute domains. Carried for
      // the same reason attributeRanges is: this literal is hand-built rather
      // than produced by buildPointCloudFromOctree, so anything it forgets is
      // simply absent — and an absent robust range silently reverts a
      // synthetic scan's scalar colorbars to raw extrema.
      ...(session.robust_attribute_ranges
        ? { robustAttributeRanges: session.robust_attribute_ranges }
        : {}),
    };
  }

  return {
    positions: keepFlat ? positions : new Float32Array(0),
    colors,
    intensities,
    scalarFields: Object.keys(scalarFields).length ? scalarFields : undefined,
    pointCount: n,
    bounds: {
      min: new THREE.Vector3(minX, minY, minZ),
      max: new THREE.Vector3(maxX, maxY, maxZ),
      center: new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
      size: new THREE.Vector3(maxX - minX, maxY - minY, maxZ - minZ),
    },
    fileName,
    // Same provenance as the octree ref above: present on the cloud-session
    // create response, and the height/X/Y colorbar falls back to the raw
    // (outlier-set) box without it.
    ...(session?.robust_bounds
      ? { robustBounds: { min: session.robust_bounds.min, max: session.robust_bounds.max } }
      : {}),
    octree,
  };
}
