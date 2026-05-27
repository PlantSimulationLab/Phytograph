import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseHeliosScanXml, HeliosXmlParseError } from './heliosScanXml';

const FIXTURE_PATH = resolve(__dirname, '../../../tests/e2e/fixtures/sphere.xml');

describe('parseHeliosScanXml', () => {
  it('parses the bundled sphere.xml fixture into four scans', () => {
    const xml = readFileSync(FIXTURE_PATH, 'utf-8');
    const { scans } = parseHeliosScanXml(xml);

    expect(scans).toHaveLength(4);

    // First scan: origin (-2, 0, 0.5), 100x200, theta 0..150°.
    const s0 = scans[0];
    expect(s0.params.origin).toEqual({ x: -2, y: 0, z: 0.5 });
    expect(s0.params.zenithPoints).toBe(100);
    expect(s0.params.azimuthPoints).toBe(200);
    expect(s0.params.zenithRangeDeg).toBeCloseTo(150, 3);
    // No phiMin/phiMax → defaults to 0..2π → 360°.
    expect(s0.params.azimuthRangeDeg).toBeCloseTo(360, 3);
    expect(s0.params.returnType).toBe('single');
    expect(s0.filename).toBe('../data/sphere_scan0.xyz');

    // Second scan: no thetaMin/thetaMax → defaults to 0..π → 180°.
    const s1 = scans[1];
    expect(s1.params.origin).toEqual({ x: 0, y: -2, z: 0.5 });
    expect(s1.params.zenithRangeDeg).toBeCloseTo(180, 3);
    expect(s1.params.azimuthRangeDeg).toBeCloseTo(360, 3);
    expect(s1.filename).toBe('../data/sphere_scan1.xyz');
    expect(s1.asciiFormat).toBe('row column x y z r g b reflectance');

    // Labels auto-numbered.
    expect(scans.map(s => s.label)).toEqual(['Scan 1', 'Scan 2', 'Scan 3', 'Scan 4']);

    // All four scans should have filenames matching the sphere_scanN pattern.
    expect(scans.map(s => s.filename)).toEqual([
      '../data/sphere_scan0.xyz',
      '../data/sphere_scan1.xyz',
      '../data/sphere_scan2.xyz',
      '../data/sphere_scan3.xyz',
    ]);
  });

  it('treats <exitDiameter> / <beamDivergence> as multi-return and converts mrad', () => {
    const xml = `
      <scan>
        <origin>1 2 3</origin>
        <size>10 20</size>
        <exitDiameter>0.025</exitDiameter>
        <beamDivergence>0.001</beamDivergence>
      </scan>
    `;
    const { scans } = parseHeliosScanXml(xml);
    expect(scans).toHaveLength(1);
    expect(scans[0].params.returnType).toBe('multi');
    expect(scans[0].params.beamExitDiameterM).toBe(0.025);
    // 0.001 rad → 1.0 mrad
    expect(scans[0].params.beamDivergenceMrad).toBeCloseTo(1.0, 6);
  });

  it('parses <filename> and <ASCII_format> (trimmed) and reports null when absent', () => {
    const xml = `
      <scan>
        <filename>  ../data/foo.xyz  </filename>
        <ASCII_format>row column x y z r g b reflectance</ASCII_format>
        <origin>0 0 1</origin>
        <size>50 100</size>
        <translation>5 5 5</translation>
        <rotation>0.1 0.2</rotation>
      </scan>
      <scan>
        <origin>1 1 1</origin>
        <size>10 10</size>
      </scan>
    `;
    const { scans } = parseHeliosScanXml(xml);
    expect(scans).toHaveLength(2);
    expect(scans[0].filename).toBe('../data/foo.xyz');
    expect(scans[0].asciiFormat).toBe('row column x y z r g b reflectance');
    // Geometry fields still parse correctly alongside the new fields.
    expect(scans[0].params.origin).toEqual({ x: 0, y: 0, z: 1 });
    expect(scans[0].params.zenithPoints).toBe(50);
    expect(scans[0].params.azimuthPoints).toBe(100);
    // Missing tags → null (not undefined, not empty string).
    expect(scans[1].filename).toBeNull();
    expect(scans[1].asciiFormat).toBeNull();
  });

  it('throws HeliosXmlParseError when no <scan> elements are present', () => {
    expect(() => parseHeliosScanXml('<grid><center>0 0 0</center></grid>'))
      .toThrow(HeliosXmlParseError);
  });

  it('throws when <origin> is missing', () => {
    const xml = '<scan><size>10 10</size></scan>';
    expect(() => parseHeliosScanXml(xml)).toThrow(/missing required <origin>/);
  });

  it('throws when <size> is missing', () => {
    const xml = '<scan><origin>0 0 0</origin></scan>';
    expect(() => parseHeliosScanXml(xml)).toThrow(/missing required <size>/);
  });

  it('strips a leading <?xml ?> prolog before wrapping (Chromium DOMParser strict mode)', () => {
    const xml = `<?xml version="1.0"?>
<scan>
  <origin>1 2 3</origin>
  <size>10 20</size>
</scan>`;
    const { scans } = parseHeliosScanXml(xml);
    expect(scans).toHaveLength(1);
    expect(scans[0].params.origin).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('throws on malformed XML', () => {
    expect(() => parseHeliosScanXml('<scan><origin>not closed'))
      .toThrow(HeliosXmlParseError);
  });

  it('reads theta/phi values as degrees', () => {
    // Matches BPPtree_high.xml: thetaMax="150" is 150°. Helios docs are
    // explicit that scan angles are in degrees — no radian fallback.
    const xml = `
      <scan>
        <origin>0 0 0</origin>
        <size>10 10</size>
        <thetaMax>150</thetaMax>
      </scan>
    `;
    const { scans } = parseHeliosScanXml(xml);
    expect(scans[0].params.zenithRangeDeg).toBeCloseTo(150, 6);
    // phi defaults to 0..360°.
    expect(scans[0].params.azimuthRangeDeg).toBeCloseTo(360, 6);
  });

  it('clamps inverted theta/phi ranges to zero rather than throwing', () => {
    const xml = `
      <scan>
        <origin>0 0 0</origin>
        <size>10 10</size>
        <thetaMin>180</thetaMin>
        <thetaMax>0</thetaMax>
      </scan>
    `;
    const { scans } = parseHeliosScanXml(xml);
    expect(scans[0].params.zenithRangeDeg).toBe(0);
  });
});
