import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { getCloudMisses } from '../../../utils/backendApi';
import { MISS_COLOR } from '../../../lib/classification';

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
 * on demand, already relocated onto the hit cloud's bounding sphere, and draws
 * them in the unmistakable miss colour. Mounted only while the user has "Show
 * misses" enabled for the scan, so the fetch cost is paid only when wanted.
 */
export function MissOverlay({ sessionId, origin, pointSize = 0.05, refreshKey }: MissOverlayProps) {
  const [positions, setPositions] = useState<Float32Array | null>(null);

  useEffect(() => {
    let cancelled = false;
    getCloudMisses(sessionId, origin ?? null)
      .then((res) => {
        if (cancelled) return;
        setPositions(res.positions.length ? new Float32Array(res.positions) : new Float32Array(0));
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
      size: pointSize,
      sizeAttenuation: true,
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
