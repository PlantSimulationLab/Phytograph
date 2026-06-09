import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { duplicateScanName, hasData, hasParams, scanDisplayName, type Scan } from './scan';
import { DEFAULT_SCAN_PARAMETERS } from './scanParameters';
import type { PointCloudData } from './pointCloudTypes';

function makeData(fileName?: string): PointCloudData {
  return {
    positions: new Float32Array([0, 0, 0]),
    pointCount: 1,
    bounds: {
      min: new THREE.Vector3(0, 0, 0),
      max: new THREE.Vector3(0, 0, 0),
      center: new THREE.Vector3(0, 0, 0),
      size: new THREE.Vector3(0, 0, 0),
    },
    fileName,
  };
}

describe('hasData / hasParams predicates', () => {
  it('hasData is true only when data is set', () => {
    const dataOnly: Scan = { id: '1', label: 'a', visible: true, color: '#000', data: makeData('a.las') };
    const paramsOnly: Scan = { id: '2', label: 'b', visible: true, color: '#000', params: DEFAULT_SCAN_PARAMETERS };
    expect(hasData(dataOnly)).toBe(true);
    expect(hasData(paramsOnly)).toBe(false);
  });

  it('hasParams is true only when params are set', () => {
    const dataOnly: Scan = { id: '1', label: 'a', visible: true, color: '#000', data: makeData('a.las') };
    const paramsOnly: Scan = { id: '2', label: 'b', visible: true, color: '#000', params: DEFAULT_SCAN_PARAMETERS };
    expect(hasParams(dataOnly)).toBe(false);
    expect(hasParams(paramsOnly)).toBe(true);
  });
});

describe('scanDisplayName', () => {
  it('uses an explicit label first', () => {
    const scan: Scan = { id: '1', label: 'North Tripod', visible: true, color: '#000' };
    expect(scanDisplayName(scan)).toBe('North Tripod');
  });

  it('falls back to data.fileName when label is empty', () => {
    const scan: Scan = { id: '1', label: '', visible: true, color: '#000', data: makeData('scan0.las') };
    expect(scanDisplayName(scan)).toBe('scan0.las');
  });

  it('falls back to "Untitled scan" when both are missing', () => {
    const scan: Scan = { id: '1', label: '', visible: true, color: '#000' };
    expect(scanDisplayName(scan)).toBe('Untitled scan');
  });
});

describe('duplicateScanName', () => {
  it('appends "(copy)" to a fresh base name', () => {
    expect(duplicateScanName('MyScan', [])).toBe('MyScan (copy)');
  });

  it('promotes "(copy)" to "(copy 2)" when duplicating a copy', () => {
    expect(duplicateScanName('MyScan (copy)', ['MyScan', 'MyScan (copy)']))
      .toBe('MyScan (copy 2)');
  });

  it('strips an existing "(copy N)" suffix before re-enumerating', () => {
    // Duplicating "MyScan (copy 2)" re-bases on "MyScan" rather than stacking
    // suffixes, then picks the first free copy slot.
    expect(duplicateScanName('MyScan (copy 2)', ['MyScan', 'MyScan (copy)']))
      .toBe('MyScan (copy 2)');
  });

  it('skips taken names to find the first free slot', () => {
    expect(
      duplicateScanName('MyScan', ['MyScan', 'MyScan (copy)', 'MyScan (copy 2)']),
    ).toBe('MyScan (copy 3)');
  });

  it('handles filename-style labels with extensions', () => {
    expect(duplicateScanName('tree.xyz', ['tree.xyz'])).toBe('tree.xyz (copy)');
  });

  it('treats the base independently of unrelated names in the set', () => {
    expect(duplicateScanName('Scan A', ['Scan B', 'Scan B (copy)']))
      .toBe('Scan A (copy)');
  });
});
