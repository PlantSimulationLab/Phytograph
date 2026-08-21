import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { srgbToLinear } from './PointCloud';
import { treeInstanceColor, rgbToHex, categoricalSchemeFor, colorForClassValue, GROUND_CLASS_ATTRIBUTE, WOOD_CLASS_ATTRIBUTE } from '../../../lib/classification';
import { sampleColormap } from '../../../lib/colormaps';

// The bug this pins: a cloud coloured by a scalar/categorical attribute and a
// per-scan cloud split out of it drew the SAME tree in two different shades —
// the parent washed out, the child over-saturated. Three code paths have to
// agree on the bytes that reach the framebuffer:
//
//   octree renderer  — bypasses outputColorSpace, writes sRGB display values
//                      straight out. This is the REFERENCE (it is also what
//                      the colourbar overlay shows).
//   flat, parent     — vertex colours, which three.js treats as LINEAR and
//                      encodes at output, so they must be stored linear.
//   flat, child      — material.color = THREE.Color('#hex'), which decodes
//                      sRGB->linear on input and is encoded at output.
//
// These reproduce each pipeline numerically and assert they land on the same
// 8-bit values. Reverting srgbToLinear() in PointCloud.tsx fails the parent
// case; dropping the hex decode fails the child case.

const toByte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
// three.js's linear->sRGB output encode (WebGLRenderer outputColorSpace).
const linearToSrgb = (v: number) =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;

/** Bytes the OCTREE renderer emits for an sRGB display colour (the reference). */
const octreeBytes = (rgb: readonly [number, number, number]) => rgb.map(toByte);

/** Bytes the FLAT renderer emits for a generated vertex colour, after the fix. */
const flatVertexBytes = (rgb: readonly [number, number, number]) =>
  rgb.map((c) => toByte(linearToSrgb(srgbToLinear(c))));

/** Bytes the FLAT renderer emits for a per-scan swatch via material.color. */
const flatSwatchBytes = (hex: string) => {
  const c = new THREE.Color(hex); // decodes sRGB -> linear working space
  return [c.r, c.g, c.b].map((v) => toByte(linearToSrgb(v)));
};

describe('srgbToLinear', () => {
  it('inverts the linear->sRGB output encode', () => {
    for (const v of [0, 0.02, 0.04045, 0.2, 0.5, 0.75, 1]) {
      expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 6);
    }
  });

  it('uses the piecewise curve, not a plain 2.2 gamma', () => {
    // Below the 0.04045 knee the transfer is linear (/12.92); a naive
    // Math.pow(c, 2.2) would be materially different here.
    expect(srgbToLinear(0.02)).toBeCloseTo(0.02 / 12.92, 12);
    expect(srgbToLinear(0.5)).toBeCloseTo(0.21404114, 6);
  });
});

describe('tree_instance colours agree across render paths', () => {
  it('parent (flat vertex colours) matches the octree reference', () => {
    for (const id of [1, 2, 3, 5, 8, 13, 40]) {
      const rgb = treeInstanceColor(id);
      expect(flatVertexBytes(rgb), `tree ${id}`).toEqual(octreeBytes(rgb));
    }
  });

  it('a split-out child swatch matches the tree it came from', () => {
    // The user-visible invariant: the child cloud's per-scan colour draws as
    // the same pixels as that tree in the parent cloud.
    for (const id of [1, 2, 3, 5, 8, 13, 40]) {
      const rgb = treeInstanceColor(id);
      expect(flatSwatchBytes(rgbToHex(rgb)), `tree ${id}`).toEqual(octreeBytes(rgb));
    }
  });
});

describe('fixed categorical schemes agree across render paths', () => {
  it.each([
    [GROUND_CLASS_ATTRIBUTE, [1, 2]],
    [WOOD_CLASS_ATTRIBUTE, [1, 2]],
  ])('%s renders identically as parent and as a split child', (attr, values) => {
    const scheme = categoricalSchemeFor(attr)!;
    for (const v of values) {
      const rgb = colorForClassValue(scheme, v);
      expect(flatVertexBytes(rgb), `${attr}=${v} parent`).toEqual(octreeBytes(rgb));
      expect(flatSwatchBytes(rgbToHex(rgb)), `${attr}=${v} child`).toEqual(octreeBytes(rgb));
    }
  });
});

describe('continuous colormaps agree across render paths', () => {
  it('viridis ramp renders the same in the flat and octree renderers', () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const rgb = sampleColormap('viridis', t);
      expect(flatVertexBytes(rgb), `t=${t}`).toEqual(octreeBytes(rgb));
    }
  });
});
