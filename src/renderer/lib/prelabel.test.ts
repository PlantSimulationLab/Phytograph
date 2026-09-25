import { describe, it, expect } from 'vitest';
import { defaultPrelabelMap } from './prelabel';

const wood = [
  { value: 1, label: 'Wood', color: [0, 0, 0] as [number, number, number] },
  { value: 2, label: 'Leaf', color: [0, 0, 0] as [number, number, number] },
];
// Your column numbers them differently, and has a class the tool lacks.
const mine = [
  { value: 0, label: 'Unclassified', color: [0, 0, 0] as [number, number, number] },
  { value: 64, label: 'leaf', color: [0, 0, 0] as [number, number, number] },
  { value: 65, label: 'WOOD ', color: [0, 0, 0] as [number, number, number] },
  { value: 66, label: 'Fruit', color: [0, 0, 0] as [number, number, number] },
];

describe('defaultPrelabelMap', () => {
  it('matches classes by name, whatever their numbers', () => {
    expect(defaultPrelabelMap('wood_class', wood, 'manual_class', mine)).toEqual({ 1: 65, 2: 64 });
  });

  it('leaves out classes with no namesake, and the source 0', () => {
    const ground = [
      { value: 0, label: 'Unclassified', color: [0, 0, 0] as [number, number, number] },
      { value: 1, label: 'Ground', color: [0, 0, 0] as [number, number, number] },
    ];
    expect(defaultPrelabelMap('ground_class', ground, 'manual_class', mine)).toEqual({});
  });

  it('copies instance ids unchanged between instance columns', () => {
    expect(defaultPrelabelMap('tree_instance', [], 'plant_instance', [])).toBeNull();
  });
});
