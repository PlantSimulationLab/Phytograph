import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { TreeInventoryTree } from '../../../utils/backendApi';
import { treeOverlaySegments } from '../../../lib/treeInventory';

// DBH circles and stem-base markers for a tree inventory, drawn as line
// segments in DISPLAY space. The vertices are computed in float64 in
// `treeOverlaySegments` (world − worldShift − displayOffset) before they reach
// the float32 buffer, so UTM-scale plots keep millimeter precision. The
// selected tree is drawn in a second, brighter pass.
interface TreeInventoryOverlayProps {
  trees: TreeInventoryTree[];
  worldShift: [number, number, number];
  displayOffset: { x: number; y: number; z: number };
  selectedTreeId: number | null;
}

function useSegments(trees: TreeInventoryTree[], worldShift: [number, number, number],
  off: [number, number, number]) {
  const geometry = useMemo(() => {
    const verts: number[] = [];
    for (const t of trees) verts.push(...treeOverlaySegments(t, worldShift, off));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    return g;
  }, [trees, worldShift, off]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return geometry;
}

export function TreeInventoryOverlay({ trees, worldShift, displayOffset, selectedTreeId }: TreeInventoryOverlayProps) {
  const off = useMemo<[number, number, number]>(
    () => [displayOffset.x, displayOffset.y, displayOffset.z],
    [displayOffset.x, displayOffset.y, displayOffset.z],
  );
  const selected = useMemo(() => trees.filter(t => t.tree_id === selectedTreeId), [trees, selectedTreeId]);
  const all = useSegments(trees, worldShift, off);
  const sel = useSegments(selected, worldShift, off);
  return (
    <group name="tree-inventory-overlay" renderOrder={10}>
      <lineSegments geometry={all}>
        <lineBasicMaterial color="#facc15" depthTest={false} transparent opacity={0.85} />
      </lineSegments>
      {selected.length > 0 && (
        <lineSegments geometry={sel}>
          <lineBasicMaterial color="#f472b6" depthTest={false} />
        </lineSegments>
      )}
    </group>
  );
}
