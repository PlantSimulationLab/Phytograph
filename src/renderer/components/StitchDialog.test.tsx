import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { StitchDialog, type StitchCloudOption, type StitchMeshOption } from './StitchDialog';

afterEach(cleanup);

// The origin warning is the guard for the issue-#3 follow-up: stitching discards
// scanner origins, so a merged cloud can't run origin-dependent analyses (Backfill
// Misses overlay, Helios triangulation, LAD). The dialog must warn — but ONLY when
// a SELECTED cloud actually carries an origin (nothing is lost when merging plain
// clouds that never had one).

const CLOUDS: StitchCloudOption[] = [
  { id: 'a', label: 'scan_a', pointCount: 100, hasOrigin: true },
  { id: 'b', label: 'scan_b', pointCount: 200, hasOrigin: true },
  { id: 'c', label: 'plain_c', pointCount: 300, hasOrigin: false },
];

function open(props: Partial<React.ComponentProps<typeof StitchDialog>> = {}) {
  const onStitch = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <StitchDialog
      isOpen
      onClose={onClose}
      clouds={CLOUDS}
      initialSelectedIds={props.initialSelectedIds}
      onStitch={onStitch}
      {...props}
    />,
  );
  return { onStitch, onClose, view };
}

const warning = () => screen.queryByTestId('stitch-origin-warning');
const runButton = () => screen.getByTestId('stitch-run') as HTMLButtonElement;
const retainBox = () =>
  screen.getByTestId('stitch-retain-originals').querySelector('input') as HTMLInputElement;

describe('StitchDialog origin warning', () => {
  it('shows no warning until an origin-bearing cloud is selected', () => {
    open();
    // Nothing selected → no warning, button reads "Stitch" and is disabled (<2).
    expect(warning()).toBeNull();
    expect(runButton().textContent).toContain('Stitch');
    expect(runButton().textContent).not.toContain('anyway');
    expect(runButton().disabled).toBe(true);
  });

  it('warns and relabels the button when selected clouds carry origins', () => {
    open({ initialSelectedIds: new Set(['a', 'b']) });
    const w = warning();
    expect(w).not.toBeNull();
    // Plural copy + the three named origin-dependent analyses.
    expect(w!.textContent).toContain('2 selected clouds have scanner origins');
    expect(w!.textContent).toContain('Backfill Misses');
    expect(w!.textContent).toContain('Helios triangulation');
    expect(w!.textContent).toContain('Leaf Area Density');
    // The action makes the discard explicit.
    expect(runButton().textContent).toBe('Stitch anyway');
    expect(runButton().disabled).toBe(false);
  });

  it('uses singular copy when exactly one selected cloud has an origin', () => {
    // a (origin) + c (no origin) → exactly one origin lost.
    open({ initialSelectedIds: new Set(['a', 'c']) });
    expect(warning()!.textContent).toContain('One selected cloud has a scanner origin');
    expect(runButton().textContent).toBe('Stitch anyway');
  });

  it('does NOT warn when merging only origin-less clouds', () => {
    open({
      clouds: [
        { id: 'x', label: 'plain_x', hasOrigin: false },
        { id: 'y', label: 'plain_y', hasOrigin: false },
      ],
      initialSelectedIds: new Set(['x', 'y']),
    });
    expect(warning()).toBeNull();
    expect(runButton().textContent).toBe('Stitch');
    expect(runButton().disabled).toBe(false);
  });

  it('still runs the stitch when the user confirms past the warning', () => {
    const { onStitch, onClose } = open({ initialSelectedIds: new Set(['a', 'b']) });
    fireEvent.click(runButton());
    expect(onStitch).toHaveBeenCalledWith(['a', 'b'], { retainOriginals: false });
    expect(onClose).toHaveBeenCalled();
  });
});

// "Keep original clouds" makes the merge non-destructive: the sources stay in
// the scene (hidden) instead of being removed. It defaults OFF so the
// destructive behavior is unchanged unless the user opts in, and it is not
// persisted — every open starts from the safe-to-assume default.
describe('StitchDialog retain-originals option', () => {
  it('defaults to unchecked, so the destructive path is unchanged', () => {
    open({ initialSelectedIds: new Set(['a', 'b']) });
    expect(retainBox().checked).toBe(false);
  });

  it('passes retainOriginals: true once the box is ticked', () => {
    const { onStitch } = open({ initialSelectedIds: new Set(['a', 'b']) });
    fireEvent.click(retainBox());
    expect(retainBox().checked).toBe(true);
    fireEvent.click(runButton());
    expect(onStitch).toHaveBeenCalledWith(['a', 'b'], { retainOriginals: true });
  });

  it('resets to unchecked when the dialog is reopened', () => {
    const { view } = open({ initialSelectedIds: new Set(['a', 'b']) });
    fireEvent.click(retainBox());
    expect(retainBox().checked).toBe(true);

    // Close and reopen — the option must not persist across opens.
    view.rerender(
      <StitchDialog
        isOpen={false}
        onClose={() => {}}
        clouds={CLOUDS}
        initialSelectedIds={new Set(['a', 'b'])}
        onStitch={() => {}}
      />,
    );
    view.rerender(
      <StitchDialog
        isOpen
        onClose={() => {}}
        clouds={CLOUDS}
        initialSelectedIds={new Set(['a', 'b'])}
        onStitch={() => {}}
      />,
    );
    expect(retainBox().checked).toBe(false);
  });

  it('tells the user the origins survive on the retained clouds', () => {
    open({ initialSelectedIds: new Set(['a', 'b']) });
    // Destructive default: the advice is to register first or keep originals.
    expect(warning()!.textContent).toContain('Register the clouds first');
    fireEvent.click(retainBox());
    // Retained: the origin-dependent analyses are still runnable on the sources.
    expect(warning()!.textContent).toContain('The originals keep their origins');
  });
});

// The Meshes side of the toggle merges mesh objects through the same modal.
// It must never leak cloud-only behavior (the origin warning, "Stitch anyway"),
// and it must make refused meshes visible-but-unpickable rather than absent.
describe('StitchDialog mesh mode', () => {
  const MESHES: StitchMeshOption[] = [
    { id: 'm1', label: 'cube', triangleCount: 12 },
    { id: 'm2', label: 'sphere', triangleCount: 1200 },
    { id: 'm3', label: 'leaf_mesh', triangleCount: 50, disabledReason: 'A triangulation keeps its scan and filter data.' },
  ];
  const modeButton = (m: 'clouds' | 'meshes') => screen.getByTestId(`stitch-mode-${m}`);
  const openMeshes = (props: Partial<React.ComponentProps<typeof StitchDialog>> = {}) => {
    const onMergeMeshes = vi.fn();
    const r = open({ meshes: MESHES, onMergeMeshes, ...props });
    return { ...r, onMergeMeshes };
  };

  it('opens on clouds by default and switches to meshes with the toggle', () => {
    openMeshes();
    expect(modeButton('clouds').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('stitch-mesh-picker')).toBeNull();
    fireEvent.click(modeButton('meshes'));
    expect(modeButton('meshes').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('stitch-mesh-picker').textContent).toContain('1,200 triangles');
    expect(screen.queryByTestId('stitch-picker')).toBeNull();
    expect(screen.getByTestId('stitch-retain-originals').textContent).toContain('Keep original meshes');
  });

  it('opens on meshes when only meshes are selected in the viewport', () => {
    openMeshes({ initialSelectedMeshIds: new Set(['m1', 'm2']) });
    expect(modeButton('meshes').getAttribute('aria-pressed')).toBe('true');
    expect(runButton().textContent).toBe('Merge');
    expect(runButton().disabled).toBe(false);
  });

  it('stays on clouds when a cloud is selected too', () => {
    openMeshes({ initialSelectedIds: new Set(['c']), initialSelectedMeshIds: new Set(['m1']) });
    expect(modeButton('clouds').getAttribute('aria-pressed')).toBe('true');
  });

  it('opens on meshes when the scene has no clouds', () => {
    openMeshes({ clouds: [] });
    expect(modeButton('meshes').getAttribute('aria-pressed')).toBe('true');
  });

  it('merges the picked meshes, and never calls the cloud stitch', () => {
    const { onStitch, onMergeMeshes, onClose } = openMeshes({ initialSelectedMeshIds: new Set(['m1', 'm2']) });
    fireEvent.click(retainBox());
    fireEvent.click(runButton());
    expect(onMergeMeshes).toHaveBeenCalledWith(['m1', 'm2'], { retainOriginals: true, matchColors: false, removeOverlap: false });
    expect(onStitch).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('passes each overlap option only once its own box is ticked', () => {
    const { onMergeMeshes } = openMeshes({ initialSelectedMeshIds: new Set(['m1', 'm2']) });
    fireEvent.click(screen.getByTestId('stitch-mesh-remove-overlap').querySelector('input')!);
    fireEvent.click(runButton());
    expect(onMergeMeshes).toHaveBeenLastCalledWith(['m1', 'm2'], { retainOriginals: false, matchColors: false, removeOverlap: true });
    fireEvent.click(screen.getByTestId('stitch-mesh-match-colors').querySelector('input')!);
    fireEvent.click(screen.getByTestId('stitch-mesh-remove-overlap').querySelector('input')!);
    fireEvent.click(runButton());
    expect(onMergeMeshes).toHaveBeenLastCalledWith(['m1', 'm2'], { retainOriginals: false, matchColors: true, removeOverlap: false });
  });

  it('offers the overlap options for meshes only', () => {
    openMeshes();
    expect(screen.queryByTestId('stitch-mesh-match-colors')).toBeNull();
    expect(screen.queryByTestId('stitch-mesh-remove-overlap')).toBeNull();
    fireEvent.click(modeButton('meshes'));
    expect(screen.getByTestId('stitch-mesh-match-colors')).toBeTruthy();
    expect(screen.getByTestId('stitch-mesh-remove-overlap')).toBeTruthy();
  });

  it('does not seed a refused mesh from the selection', () => {
    // m3 is a triangulation: selected in the viewport, but not mergeable, so
    // only m1 is picked and the merge stays disabled.
    openMeshes({ initialSelectedMeshIds: new Set(['m1', 'm3']) });
    expect(runButton().disabled).toBe(true);
    expect(screen.getByText('Select at least 2 meshes')).toBeTruthy();
  });

  it('never shows the scanner-origin warning in mesh mode', () => {
    // Clouds a + b (both with origins) are picked on the cloud side.
    openMeshes({ initialSelectedIds: new Set(['a', 'b']) });
    expect(warning()).not.toBeNull();
    fireEvent.click(modeButton('meshes'));
    expect(warning()).toBeNull();
    // …and the cloud picks survive the round trip.
    fireEvent.click(modeButton('clouds'));
    expect(runButton().textContent).toBe('Stitch anyway');
  });

  it('stops counting a picked mesh that vanishes while the dialog is open', () => {
    // m2 is removed from the scene (e.g. an undo) with the dialog still open.
    // The button must go dead rather than fire a merge of one mesh.
    const { view, onMergeMeshes } = openMeshes({ initialSelectedMeshIds: new Set(['m1', 'm2']) });
    expect(runButton().disabled).toBe(false);
    view.rerender(
      <StitchDialog
        isOpen
        onClose={() => {}}
        clouds={CLOUDS}
        onStitch={() => {}}
        meshes={MESHES.filter(m => m.id !== 'm2')}
        initialSelectedMeshIds={new Set(['m1', 'm2'])}
        onMergeMeshes={onMergeMeshes}
      />,
    );
    expect(runButton().disabled).toBe(true);
    expect(screen.getByText('Select at least 2 meshes')).toBeTruthy();
  });

  it('blocks a set that cannot share one mesh and says why', () => {
    const reason = 'Textured and untextured meshes cannot be merged into one mesh.';
    const { onMergeMeshes } = openMeshes({
      initialSelectedMeshIds: new Set(['m1', 'm2']),
      meshSetBlockReason: (ids) => (ids.includes('m2') ? reason : undefined),
    });
    expect(screen.getByTestId('stitch-mesh-block').textContent).toContain(reason);
    expect(runButton().disabled).toBe(true);
    fireEvent.click(runButton());
    expect(onMergeMeshes).not.toHaveBeenCalled();
  });
});
