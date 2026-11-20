import { describe, expect, it } from 'vitest';
import { orbitDragMove, orbitDragStart } from './orbitDrag';

const idle = { dragging: false, last: { x: 0, y: 0 } };

describe('orbitDragMove', () => {
  it('rotates by the travel since the last move while the left button is held', () => {
    const s0 = orbitDragStart({ clientX: 100, clientY: 100 });
    const a = orbitDragMove(s0, { clientX: 110, clientY: 95, buttons: 1 });
    expect(a.rotate).toEqual({ dx: 10, dy: -5 });
    const b = orbitDragMove(a.state, { clientX: 112, clientY: 95, buttons: 1 });
    expect(b.rotate).toEqual({ dx: 2, dy: 0 });
  });

  it('ends a drag whose pointerup never came instead of rotating on a plain hover', () => {
    const s0 = orbitDragStart({ clientX: 100, clientY: 100 });
    const hover = orbitDragMove(s0, { clientX: 400, clientY: 300, buttons: 0 });
    expect(hover.rotate).toBeNull();
    expect(hover.state.dragging).toBe(false);
    // And it stays ended, even if a button is down on a later move.
    expect(orbitDragMove(hover.state, { clientX: 420, clientY: 310, buttons: 1 }).rotate).toBeNull();
  });

  it('a held right or middle button alone does not keep a left drag going', () => {
    const s0 = orbitDragStart({ clientX: 0, clientY: 0 });
    expect(orbitDragMove(s0, { clientX: 5, clientY: 5, buttons: 2 }).state.dragging).toBe(false);
    expect(orbitDragMove(s0, { clientX: 5, clientY: 5, buttons: 4 }).state.dragging).toBe(false);
    expect(orbitDragMove(s0, { clientX: 5, clientY: 5, buttons: 3 }).rotate).toEqual({ dx: 5, dy: 5 });
  });

  it('does nothing when not dragging or when the pointer did not move', () => {
    expect(orbitDragMove(idle, { clientX: 9, clientY: 9, buttons: 1 }).rotate).toBeNull();
    const s0 = orbitDragStart({ clientX: 7, clientY: 7 });
    expect(orbitDragMove(s0, { clientX: 7, clientY: 7, buttons: 1 }).rotate).toBeNull();
  });
});
