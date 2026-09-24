import { describe, it, expect } from 'vitest';
import { labelStrokeRequest, planSessionSync } from './sessionEditSync';
import type { SceneAction } from '../state/sceneActions';
import type { CloudEditState, LabelStroke, PendingDeleteRegion } from './pointCloudTypes';

const stroke = (strokeId: string, extra: Partial<LabelStroke> = {}): LabelStroke =>
  ({ strokeId, region: { kind: 'box' } as never, toClass: 64, ...extra });
const label = (before: string[], after: string[], slug = 'manual_class'): SceneAction => ({
  t: 'labelEdit', id: 'c1', slug,
  before: { strokes: before.map((s) => stroke(s)), activeClass: 64 },
  after: { strokes: after.map((s) => stroke(s)), activeClass: 64 },
});
const region = (n: number) => ({ kind: 'box', min: [n, 0, 0] } as unknown as PendingDeleteRegion);
const edit = (n: number): CloudEditState => ({
  translation: { x: 0, y: 0, z: 0 }, erasedIndices: new Set(),
  pendingDeletes: Array.from({ length: n }, (_, i) => region(i)),
});
const mask = (a: number, b: number): SceneAction =>
  ({ t: 'maskEdit', id: 'c1', before: edit(a), after: edit(b) });

describe('planSessionSync', () => {
  it('an undo rolls the column back to the BEFORE strokes', () => {
    // The old sync read the target from the store before the undo re-rendered,
    // i.e. the AFTER state, and so asked the session to keep everything.
    expect(planSessionSync([label(['a'], ['a', 'b'])], 'undo')).toEqual([
      { op: 'resetLabels', cloudId: 'c1', slug: 'manual_class', surviving: [stroke('a')] },
    ]);
  });

  it('a redo re-paints exactly the strokes the undo removed, with their ids', () => {
    const ops = planSessionSync([label(['a'], ['a', 'b'])], 'redo');
    expect(ops).toEqual([{
      op: 'redoLabels', cloudId: 'c1', slug: 'manual_class',
      strokes: [stroke('b')], surviving: [stroke('a'), stroke('b')],
    }]);
  });

  it('an erase undo keeps the BEFORE depth, and a redo re-sends the dropped regions', () => {
    expect(planSessionSync([mask(1, 3)], 'undo'))
      .toEqual([{ op: 'resetDeletes', cloudId: 'c1', keep: 1 }]);
    expect(planSessionSync([mask(1, 3)], 'redo'))
      .toEqual([{ op: 'redoDeletes', cloudId: 'c1', regions: [region(1), region(2)] }]);
  });

  it('a translation-only mask edit needs nothing from the session', () => {
    expect(planSessionSync([mask(2, 2)], 'undo')).toEqual([]);
  });

  it('ignores actions whose truth is in the store', () => {
    const move: SceneAction = { t: 'transform', kind: 'mesh', id: 'm',
      before: { position: { x: 0, y: 0, z: 0 } }, after: { position: { x: 1, y: 0, z: 0 } } };
    expect(planSessionSync([move], 'undo')).toEqual([]);
  });

  it('unwinds a multi-action undo newest first', () => {
    const ops = planSessionSync([label(['a'], ['a', 'b'], 'x'), label([], ['c'], 'y')], 'undo');
    expect(ops.map((o) => (o as { slug: string }).slug)).toEqual(['y', 'x']);
  });
});

describe('labelStrokeRequest', () => {
  it('carries the From gate and the slab a redo must replay', () => {
    const req = labelStrokeRequest(stroke('s', { fromClasses: [0], slab: { kind: 'slab' } as never }));
    expect(req).toMatchObject({ stroke_id: 's', to_class: 64, from_classes: [0], slab: { kind: 'slab' } });
  });
});
