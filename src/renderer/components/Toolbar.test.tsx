import { describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { Box, Crop } from 'lucide-react';
import { Toolbar } from './Toolbar';
import { type ToolCommand, type SelectionState, CREATE_GROUPS } from '../lib/toolCommands';

afterEach(cleanup);

const EMPTY: SelectionState = {
  hasCloud: false,
  hasMesh: false,
  hasSkeleton: false,
  hasPlantMesh: false,
  cloudCount: 0,
  meshCount: 0,
  totalCloudCount: 0,
};

// A scene that holds one cloud, but with nothing selected.
const SCENE_WITH_CLOUD: SelectionState = { ...EMPTY, totalCloudCount: 1 };

function makeCommands(overrides: Partial<ToolCommand>[] = []): ToolCommand[] {
  const base: ToolCommand[] = [
    { id: 'cloud-crop', name: 'Crop', action: vi.fn(), category: 'Point Cloud', requires: 'cloud', toolGroup: 'preprocess', icon: Crop, testId: 'tool-crop' },
    { id: 'cloud-stitch', name: 'Stitch', action: vi.fn(), category: 'Point Cloud', toolGroup: 'preprocess', icon: Box, multiInput: true },
    { id: 'cloud-ground-segment', name: 'Segment Ground', action: vi.fn(), category: 'Point Cloud', requires: 'cloud', toolGroup: 'segment', icon: Box },
    // A palette-only command (no toolGroup) must NOT appear on the toolbar.
    { id: 'settings', name: 'Settings', action: vi.fn(), category: 'App', requires: null },
  ];
  return base.map(c => ({ ...c, ...(overrides.find(o => o.id === c.id) ?? {}) }));
}

describe('Toolbar', () => {
  it('renders group headings for non-empty groups only', () => {
    render(<Toolbar commands={makeCommands()} selection={EMPTY} />);
    expect(screen.getByText('Pre-processing')).toBeTruthy();
    expect(screen.getByText('Segmentation')).toBeTruthy();
    // No reconstruct commands → that heading is absent. (Create/Simulate are
    // separate sections rendered by their own Toolbar blocks.)
    expect(screen.queryByText('Reconstruction')).toBeNull();
  });

  it('excludes commands with no toolGroup', () => {
    render(<Toolbar commands={makeCommands()} selection={EMPTY} />);
    expect(screen.queryByTestId('tool-settings')).toBeNull();
  });

  it('uses the explicit testId when provided, else tool-${id}', () => {
    render(<Toolbar commands={makeCommands()} selection={EMPTY} />);
    expect(screen.getByTestId('tool-crop')).toBeTruthy();          // explicit
    expect(screen.getByTestId('tool-cloud-stitch')).toBeTruthy();  // fallback
  });

  it('disables single-input tools when their prerequisite is unmet', () => {
    render(<Toolbar commands={makeCommands()} selection={EMPTY} />);
    expect((screen.getByTestId('tool-crop') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('tool-cloud-ground-segment') as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables multi-input tools in an empty scene (no clouds to operate on)', () => {
    render(<Toolbar commands={makeCommands()} selection={EMPTY} />);
    expect((screen.getByTestId('tool-cloud-stitch') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables multi-input tools once a cloud exists, even with nothing selected', () => {
    render(<Toolbar commands={makeCommands()} selection={SCENE_WITH_CLOUD} />);
    expect((screen.getByTestId('tool-cloud-stitch') as HTMLButtonElement).disabled).toBe(false);
  });

  it('enables single-input tools once the prerequisite is selected', () => {
    render(<Toolbar commands={makeCommands()} selection={{ ...EMPTY, hasCloud: true, cloudCount: 1 }} />);
    expect((screen.getByTestId('tool-crop') as HTMLButtonElement).disabled).toBe(false);
  });

  it('renders a custom section (Create) with its own title and groups', () => {
    const cmds: ToolCommand[] = [
      { id: 'create-plant', name: 'Generate Plant', action: vi.fn(), category: 'Create', toolGroup: 'create', icon: Box, testId: 'tool-plant-generate' },
    ];
    render(<Toolbar commands={cmds} selection={EMPTY} title="Create" groups={CREATE_GROUPS} />);
    expect(screen.getByText('Create')).toBeTruthy();
    expect(screen.getByTestId('tool-plant-generate')).toBeTruthy();
    // A single group whose label equals the title shows no redundant sub-heading,
    // so "Create" appears exactly once.
    expect(screen.getAllByText('Create')).toHaveLength(1);
  });

  it('renders nothing when no command matches the block groups', () => {
    const { container } = render(
      <Toolbar commands={makeCommands()} selection={EMPTY} title="Create" groups={CREATE_GROUPS} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('runs the command action on click and skips it when disabled', () => {
    const cropAction = vi.fn();
    const stitchAction = vi.fn();
    const cmds = makeCommands([
      { id: 'cloud-crop', action: cropAction },
      { id: 'cloud-stitch', action: stitchAction },
    ]);
    // A cloud exists (so multi-input stitch is live) but none is selected (so
    // single-input crop stays disabled).
    render(<Toolbar commands={cmds} selection={SCENE_WITH_CLOUD} />);
    // Disabled crop button does nothing.
    screen.getByTestId('tool-crop').click();
    expect(cropAction).not.toHaveBeenCalled();
    // Enabled multi-input stitch fires.
    screen.getByTestId('tool-cloud-stitch').click();
    expect(stitchAction).toHaveBeenCalledOnce();
  });
});
