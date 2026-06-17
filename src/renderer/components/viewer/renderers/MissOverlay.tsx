import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { getCloudMisses } from '../../../utils/backendApi';
import { MISS_COLOR } from '../../../lib/classification';
import { showToast } from '../../Toast';

interface MissOverlayProps {
  // Backend cloud-session that holds the sky/miss points.
  sessionId: string;
  // True beam apex (scan params origin) so the backend projects misses along
  // the real pulse direction; null lets the backend use the hit-cloud centre.
  origin?: { x: number; y: number; z: number } | null;
  // Point size in world units (matches the cloud's point size feel).
  pointSize?: number;
  // Bumped by the parent after a bake/edit so the overlay re-fetches the
  // (possibly compacted) miss set instead of showing stale positions.
  refreshKey?: number | string;
}

/**
 * Renders a scan's sky/miss points as a distinct overlay. Misses are stored at
 * their true far-field coordinates (~20 km) for LAD, so they're NOT in the
 * octree (their extent would wreck camera framing). This component fetches them
 * on demand and draws them in the unmistakable miss colour. When the scan has a
 * scanner origin, the backend projects the misses onto a sphere just beyond the
 * farthest hit so they stay visible against the cloud; with no origin they come
 * back at their true coordinates. Mounted only while the user has "Show misses"
 * enabled for the scan, so the fetch cost is paid only when wanted.
 */
export function MissOverlay({ sessionId, origin, pointSize = 0.05, refreshKey }: MissOverlayProps) {
  const [positions, setPositions] = useState<Float32Array | null>(null);

  useEffect(() => {
    let cancelled = false;
    getCloudMisses(sessionId, origin ?? null)
      .then((res) => {
        if (cancelled) return;
        // res.positions is already a Float32Array (zero-copy from the PHB1 frame).
        setPositions(res.positions);
        // Don't let the toggle look like a silent no-op. When the scan has misses
        // but none can be drawn yet, say why instead of rendering nothing.
        if (res.count === 0 && res.total > 0) {
          showToast({
            type: 'info',
            title: 'Sky/miss points not yet placeable',
            message: `${res.total.toLocaleString()} sky/miss point(s) are flagged but have no beam direction yet `
              + '(the scanner zeroed invalid-cell coordinates). Their directions are recovered from the scan grid '
              + 'during the leaf-area-density inversion; they can be shown once recovered.',
          });
        } else if (res.count === 0 && res.total === 0) {
          showToast({
            type: 'info',
            title: 'No sky/miss points',
            message: 'This scan has no sky/miss points to display.',
          });
        }
      })
      .catch(() => {
        if (!cancelled) setPositions(new Float32Array(0));
      });
    return () => { cancelled = true; };
    // origin is an object; depend on its components so a new {} with the same
    // numbers doesn't refetch, but a genuinely moved scanner does.
  }, [sessionId, origin?.x, origin?.y, origin?.z, refreshKey]);

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    if (positions && positions.length) {
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    }
    return geo;
  }, [positions]);

  useEffect(() => () => { geometry.dispose(); }, [geometry]);

  const material = useMemo(
    () => new THREE.PointsMaterial({
      color: new THREE.Color(MISS_COLOR[0], MISS_COLOR[1], MISS_COLOR[2]),
      // SCREEN-PIXEL sizing (sizeAttenuation:false) to match the octree's
      // Potree material, which uses PointSizeType.FIXED — i.e. `size` is pixels,
      // not world units. With sizeAttenuation:true a pointSize of 1 rendered each
      // miss as a 1-METRE sprite, so the thin projected sphere shell bloated into
      // a slab as thick as it was wide. Pixels keep misses dot-sized like the
      // hits regardless of zoom. Scale up slightly so they read as deliberate
      // markers rather than noise.
      size: Math.max(pointSize, 1) * 2,
      sizeAttenuation: false,
      // Misses are display aids, not data — keep them lightweight and always
      // visible (no depth-write so they don't occlude the real cloud).
      depthWrite: false,
      transparent: true,
      opacity: 0.9,
    }),
    [pointSize],
  );

  useEffect(() => () => { material.dispose(); }, [material]);

  if (!positions || positions.length === 0) return null;
  return <points geometry={geometry} material={material} />;
}
