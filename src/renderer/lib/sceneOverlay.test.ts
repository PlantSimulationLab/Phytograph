import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { SCENE_OVERLAY, isSceneOverlay } from './sceneOverlay';

// Applying the marker the way JSX does: `<mesh {...SCENE_OVERLAY}>` ends up as
// Object3D.userData on the created object.
function markOverlay<T extends THREE.Object3D>(obj: T): T {
  Object.assign(obj.userData, SCENE_OVERLAY.userData);
  return obj;
}

describe('isSceneOverlay', () => {
  it('is false for ordinary scene content', () => {
    expect(isSceneOverlay(new THREE.Mesh())).toBe(false);
    expect(isSceneOverlay(new THREE.Points())).toBe(false);
  });

  it('is true for a directly marked object', () => {
    expect(isSceneOverlay(markOverlay(new THREE.Mesh()))).toBe(true);
  });

  it('is true for a child of a marked group — the case gizmos rely on', () => {
    // Gizmos mark their root group; the shaft/head/hitbox meshes hang off it and
    // must inherit the marking rather than repeating it.
    const root = markOverlay(new THREE.Group());
    const child = new THREE.Mesh();
    const grandchild = new THREE.Mesh();
    root.add(child);
    child.add(grandchild);

    expect(isSceneOverlay(child)).toBe(true);
    expect(isSceneOverlay(grandchild)).toBe(true);
  });

  it('does not leak across siblings', () => {
    const scene = new THREE.Scene();
    const overlay = markOverlay(new THREE.Group());
    const content = new THREE.Mesh();
    scene.add(overlay, content);

    expect(isSceneOverlay(overlay)).toBe(true);
    expect(isSceneOverlay(content)).toBe(false);
  });

  it('is false once an object is detached from its marked parent', () => {
    const root = markOverlay(new THREE.Group());
    const child = new THREE.Mesh();
    root.add(child);
    expect(isSceneOverlay(child)).toBe(true);

    root.remove(child);
    expect(isSceneOverlay(child)).toBe(false);
  });

  it('handles null/undefined without throwing', () => {
    expect(isSceneOverlay(null)).toBe(false);
    expect(isSceneOverlay(undefined)).toBe(false);
  });

  it('tolerates an object whose userData was replaced wholesale', () => {
    const m = new THREE.Mesh();
    (m as unknown as { userData: unknown }).userData = undefined;
    expect(() => isSceneOverlay(m)).not.toThrow();
    expect(isSceneOverlay(m)).toBe(false);
  });

  it('marks content transparency-independently', () => {
    // The distinction is INTENT, not appearance: the crop box's fill is at
    // opacity 0.05 (visible, so an opacity===0 test misses it) and real content
    // can legitimately be transparent. Both directions asserted here.
    const faintOverlay = markOverlay(new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.05 }),
    ));
    const transparentContent = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.05 }),
    );
    expect(isSceneOverlay(faintOverlay)).toBe(true);
    expect(isSceneOverlay(transparentContent)).toBe(false);
  });
});
