import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { getScannerModel, type ScannerModelId } from '../lib/scannerModels';
import { scanShellOrientation } from './ScannerMarker';
import type { ScanParameters } from '../lib/scanParameters';

// A faint wireframe shell depicting a scanner's angular COVERAGE (not its body —
// that's ScannerMarker). For a raster scan it's a partial lat/long sphere with the
// unswept zenith/azimuth slices removed; for a spinning multibeam it's one ring +
// cone-spokes per beam elevation (a flat disk for a 0° beam). Hidden by default,
// driven by the View-menu toggle; see PointCloudViewer's `showScanWireframes`.
//
// Geometry is hand-built as disjoint vertex PAIRS rendered with <lineSegments>, the
// same idiom as ScannerMarker's TrajectoryPath — the lowercase r3f <line> intrinsic
// is broken, and a meshBasicMaterial wireframe would add a noisy triangulation
// diagonal across every cell. The buffer is disposed on unmount and given an
// explicit bounding sphere so it isn't frustum-culled when the world origin leaves
// view.

const DEG = Math.PI / 180;

// Radius factor: the shell radius is this times the scanner's real-world height
// (then times the user's marker-size multiplier), so it reads as a halo around the
// instrument rather than the full (tens-of-metres) scan reach.
const RADIUS_FACTOR = 5;

// A scanner-local point at (zenith from +Z, azimuth = Helios phi), radius R.
// Z-up; zenith 0 = straight up, 90 = horizon, 180 = straight down. The azimuth
// convention MUST match the backend's ray generation: PyHelios `sphere2cart`
// places phi from +Y, increasing toward +X (x = sin φ, y = cos φ) — NOT the
// math-standard from-+X (x = cos φ). Using cos/sin here put the shell 90° off
// (and mirrored) from the actual scan points. See LiDAR.cpp sphere2cart.
function sph(R: number, zenithDeg: number, azimuthDeg: number): [number, number, number] {
  const t = zenithDeg * DEG;
  const p = azimuthDeg * DEG;
  const s = Math.sin(t);
  return [R * s * Math.sin(p), R * s * Math.cos(p), R * Math.cos(t)];
}

// Push a polyline (consecutive world points) into `out` as disjoint segment pairs,
// so a single <lineSegments> draws it as a connected path.
function pushPolyline(out: number[], pts: Array<[number, number, number]>): void {
  for (let i = 0; i < pts.length - 1; i++) {
    out.push(...pts[i], ...pts[i + 1]);
  }
}

function finishGeometry(out: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(out), 3));
  // Without an explicit bounding sphere a hand-built geometry has none, so three.js
  // frustum-culls the whole line once the origin leaves view (it blinks out).
  g.computeBoundingSphere();
  return g;
}

// Raster: a partial lat/long grid over zenith ∈ [zMin,zMax] and azimuth ∈ [aMin,aMax].
// A full sphere is [0,180]×[0,360]; a banded zenith range drops the top/bottom caps,
// and an azimuth window narrower than 360° leaves a wedge open. Built in the scanner's
// own (untilted, zero-heading) frame with phi from +Y (see sph) — the group quaternion
// applies the heading/tilt (see the component), so azimuthOffset is NOT folded in here.
export function buildRasterGeometry(
  R: number,
  p: { zMin: number; zMax: number; aMin: number; aMax: number },
): THREE.BufferGeometry {
  const out: number[] = [];
  const aSpan = p.aMax - p.aMin;
  const zSpan = p.zMax - p.zMin;
  // Smoothness of each drawn curve (segments ~every 15°, clamped to a sane minimum).
  const AZ_DIV = Math.max(8, Math.round(Math.abs(aSpan) / 15));
  const ZE_DIV = Math.max(4, Math.round(Math.abs(zSpan) / 15));
  // How many grid lines to draw in each direction.
  const N_LAT = 7; // latitude rings across the zenith band
  const N_LON = Math.max(4, Math.round(Math.abs(aSpan) / 30)); // longitude arcs

  // Latitude rings: constant zenith, sweeping azimuth aMin..aMax.
  for (let i = 0; i <= N_LAT; i++) {
    const z = p.zMin + (zSpan * i) / N_LAT;
    const ring: Array<[number, number, number]> = [];
    for (let j = 0; j <= AZ_DIV; j++) {
      ring.push(sph(R, z, p.aMin + (aSpan * j) / AZ_DIV));
    }
    pushPolyline(out, ring);
  }
  // Longitude arcs: constant azimuth, sweeping zenith zMin..zMax.
  for (let i = 0; i <= N_LON; i++) {
    const a = p.aMin + (aSpan * i) / N_LON;
    const arc: Array<[number, number, number]> = [];
    for (let j = 0; j <= ZE_DIV; j++) {
      arc.push(sph(R, p.zMin + (zSpan * j) / ZE_DIV, a));
    }
    pushPolyline(out, arc);
  }

  return finishGeometry(out);
}

// Multibeam: for each beam elevation e (degrees above horizon → zenith 90−e), a
// latitude arc over [aMin,aMax] plus a few radial spokes from the origin out to the
// ring, suggesting the cone surface. A 0° beam → zenith 90 → every point lands in the
// z=0 plane, so the ring+spokes degenerate to a flat disk sector automatically (no
// special case needed). Same local frame (phi from +Y) as the raster builder.
export function buildMultibeamGeometry(
  R: number,
  p: { elevations: number[]; aMin: number; aMax: number },
): THREE.BufferGeometry {
  const out: number[] = [];
  const aSpan = p.aMax - p.aMin;
  const AZ_DIV = Math.max(8, Math.round(Math.abs(aSpan) / 10)); // smooth ring
  const N_SPOKES = Math.max(2, Math.round(Math.abs(aSpan) / 45)); // a few per beam

  for (const e of p.elevations) {
    const zenith = 90 - e;
    const ring: Array<[number, number, number]> = [];
    for (let j = 0; j <= AZ_DIV; j++) {
      ring.push(sph(R, zenith, p.aMin + (aSpan * j) / AZ_DIV));
    }
    pushPolyline(out, ring);
    for (let i = 0; i <= N_SPOKES; i++) {
      const a = p.aMin + (aSpan * i) / N_SPOKES;
      out.push(0, 0, 0, ...sph(R, zenith, a));
    }
  }

  return finishGeometry(out);
}

interface ScanPatternWireframeProps {
  origin: { x: number; y: number; z: number };
  pattern: ScanParameters['pattern'];
  model?: ScannerModelId;
  zenithMinDeg: number;
  zenithMaxDeg: number;
  azimuthMinDeg: number;
  azimuthMaxDeg: number;
  azimuthOffsetDeg: number;
  tiltRollDeg: number;
  tiltPitchDeg: number;
  beamElevationAnglesDeg: number[];
  // First trajectory pose attitude (Hamilton qx,qy,qz,qw) for a moving scan; when
  // present it orients the shell in place of the static tilt/heading.
  bodyQuaternion?: [number, number, number, number];
  color: string;
  // The user's "Scan marker size" multiplier — the shell scales with the marker.
  markerScale: number;
}

export function ScanPatternWireframe({
  origin,
  pattern,
  model,
  zenithMinDeg,
  zenithMaxDeg,
  azimuthMinDeg,
  azimuthMaxDeg,
  azimuthOffsetDeg,
  tiltRollDeg,
  tiltPitchDeg,
  beamElevationAnglesDeg,
  bodyQuaternion,
  color,
  markerScale,
}: ScanPatternWireframeProps) {
  const R = useMemo(
    () =>
      RADIUS_FACTOR *
      getScannerModel(model).heightMeters *
      (markerScale > 0 ? markerScale : 1),
    [model, markerScale],
  );

  const geometry = useMemo(
    () =>
      pattern === 'spinning_multibeam'
        ? buildMultibeamGeometry(R, {
            elevations: beamElevationAnglesDeg,
            aMin: azimuthMinDeg,
            aMax: azimuthMaxDeg,
          })
        : buildRasterGeometry(R, {
            zMin: zenithMinDeg,
            zMax: zenithMaxDeg,
            aMin: azimuthMinDeg,
            aMax: azimuthMaxDeg,
          }),
    [
      R,
      pattern,
      beamElevationAnglesDeg,
      zenithMinDeg,
      zenithMaxDeg,
      azimuthMinDeg,
      azimuthMaxDeg,
    ],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);

  // Orientation: a moving scan uses its first-pose attitude; a static scan uses the
  // heading+tilt quaternion. The yaw folds in azimuthOffset (so the arcs above stay
  // azimuthOffset-free to avoid double-counting it), and the tilt leans about the
  // phiMin (azimuthMin) scan direction so the shell tips with the real rays.
  const quaternion = useMemo(
    () =>
      bodyQuaternion
        ? new THREE.Quaternion(
            bodyQuaternion[0],
            bodyQuaternion[1],
            bodyQuaternion[2],
            bodyQuaternion[3],
          ).normalize()
        : scanShellOrientation(
            tiltRollDeg,
            tiltPitchDeg,
            azimuthOffsetDeg,
            azimuthMinDeg,
          ),
    [bodyQuaternion, tiltRollDeg, tiltPitchDeg, azimuthOffsetDeg, azimuthMinDeg],
  );

  return (
    <group position={[origin.x, origin.y, origin.z]} quaternion={quaternion}>
      <lineSegments frustumCulled={false}>
        <primitive object={geometry} attach="geometry" />
        <lineBasicMaterial color={color} transparent opacity={0.35} depthTest={false} />
      </lineSegments>
    </group>
  );
}

// Derives ScanPatternWireframe props from a scan's ScanParameters. Memoization is
// anchored on the stable `params` reference (and its primitive fields) so the GPU
// geometry rebuilds only on a real edit — never per frame. `beamElevationAnglesDeg`
// is passed straight through (stable while `params` is stable); do NOT map it inline,
// which would feed a fresh array into the geometry memo every render (the documented
// GPU-memory leak in ScannerMarker.tsx).
export function ScanWireframeEntry({
  params,
  color,
  markerScale,
}: {
  params: ScanParameters;
  color: string;
  markerScale: number;
}) {
  const traj = params.trajectory;
  const bodyQuaternion = useMemo<[number, number, number, number] | undefined>(
    () =>
      traj
        ? [traj.poses[0].qx, traj.poses[0].qy, traj.poses[0].qz, traj.poses[0].qw]
        : undefined,
    [traj],
  );
  return (
    <ScanPatternWireframe
      origin={params.origin}
      pattern={params.pattern}
      model={params.scannerModel}
      zenithMinDeg={params.zenithMinDeg}
      zenithMaxDeg={params.zenithMaxDeg}
      azimuthMinDeg={params.azimuthMinDeg}
      azimuthMaxDeg={params.azimuthMaxDeg}
      azimuthOffsetDeg={params.azimuthOffsetDeg}
      tiltRollDeg={params.tiltRollDeg}
      tiltPitchDeg={params.tiltPitchDeg}
      beamElevationAnglesDeg={params.beamElevationAnglesDeg}
      bodyQuaternion={bodyQuaternion}
      color={color}
      markerScale={markerScale}
    />
  );
}
