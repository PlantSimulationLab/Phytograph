import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ORIGIN_SNAP_SURFACE, nearestSnapSurfaceHit } from './originSnapSurface';
import { SCENE_OVERLAY } from './sceneOverlay';

function meshIn(groupUserData: Record<string, unknown>): THREE.Mesh {
  const group = new THREE.Group();
  Object.assign(group.userData, groupUserData);
  const mesh = new THREE.Mesh();
  group.add(mesh);
  return mesh;
}

describe('nearestSnapSurfaceHit', () => {
  it('returns the nearest tagged mesh, whatever order the hits arrive in', () => {
    const far = { object: meshIn(ORIGIN_SNAP_SURFACE.userData), distance: 9 };
    const near = { object: meshIn(ORIGIN_SNAP_SURFACE.userData), distance: 4 };
    expect(nearestSnapSurfaceHit([far, near])).toBe(near);
  });

  it('ignores untagged meshes and overlays in front of the surface', () => {
    const marker = { object: meshIn({}), distance: 1 };
    const overlay = {
      object: meshIn({ ...ORIGIN_SNAP_SURFACE.userData, ...SCENE_OVERLAY.userData }),
      distance: 2,
    };
    const surface = { object: meshIn(ORIGIN_SNAP_SURFACE.userData), distance: 5 };
    expect(nearestSnapSurfaceHit([marker, overlay, surface])).toBe(surface);
    expect(nearestSnapSurfaceHit([marker, overlay])).toBeNull();
  });

  it('ignores line geometry inside a tagged group', () => {
    const group = new THREE.Group();
    Object.assign(group.userData, ORIGIN_SNAP_SURFACE.userData);
    const edges = new THREE.LineSegments();
    group.add(edges);
    expect(nearestSnapSurfaceHit([{ object: edges, distance: 1 }])).toBeNull();
  });
});
