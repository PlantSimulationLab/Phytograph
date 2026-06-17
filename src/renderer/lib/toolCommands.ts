// Shared metadata + helpers for the one tool registry that drives three
// surfaces: the static Toolbar, the Cmd+K command palette, and the native Tools
// menu (src/main/menu.ts). The registry array itself is built inside
// PointCloudViewer (its actions close over component state); this module owns the
// *type* and the pure availability logic so the Toolbar, palette, and tests can
// all share one definition.
import type { LucideIcon } from 'lucide-react';

/** A selection prerequisite a command may need before it can act. */
export type ToolRequires =
  | 'cloud'
  | 'mesh'
  | 'skeleton'
  | 'plant'
  | 'multiple-clouds'
  | 'multiple-meshes'
  | null;

/** The four static-toolbar / Tools-menu categories. */
export type ToolGroup = 'preprocess' | 'segment' | 'reconstruct' | 'create' | 'simulate';

export interface ToolCommand {
  id: string;
  name: string;
  keywords?: string[];
  action: () => void;
  category: string;
  requires?: ToolRequires;
  /** Toolbar/menu group. Omitted/null → palette & menu only, never on the toolbar. */
  toolGroup?: ToolGroup | null;
  icon?: LucideIcon;
  /**
   * Stable `data-testid` for the toolbar button. Defaults to `tool-${id}`.
   * Set explicitly to preserve the historical testids the E2E suite drives.
   */
  testId?: string;
  /**
   * Multi-input tools open a dialog that picks their own inputs, so they stay
   * clickable with nothing selected (the dialog explains what's missing).
   * Single-input/gizmo tools grey out via `requires` until a target exists.
   */
  multiInput?: boolean;
  /** Toggled-state predicate so the toolbar can highlight an open panel/mode. */
  isActive?: () => boolean;
}

/** Live selection counts the availability check reads. */
export interface SelectionState {
  hasCloud: boolean;
  hasMesh: boolean;
  hasSkeleton: boolean;
  hasPlantMesh: boolean;
  cloudCount: number;
  meshCount: number;
  /**
   * Scans present in the scene (data-bearing clouds AND param-only scanner
   * markers), regardless of selection. Gates multi-input tools.
   */
  totalScanCount: number;
}

/**
 * Whether a command can act given the current selection. Multi-input tools pick
 * their own inputs in a dialog (the modal owns a scan picker), so they don't
 * need a *selected* cloud — but they still need at least one scan to EXIST in
 * the scene to have anything to pick (an empty scene leaves nothing to mesh /
 * stitch / align / invert / scan). Everything else is gated on `requires`
 * against the selection.
 */
export function isCommandAvailable(cmd: ToolCommand, sel: SelectionState): boolean {
  if (cmd.multiInput) return sel.totalScanCount >= 1;
  switch (cmd.requires) {
    case 'cloud': return sel.hasCloud;
    case 'mesh': return sel.hasMesh;
    case 'skeleton': return sel.hasSkeleton;
    case 'plant': return sel.hasPlantMesh;
    case 'multiple-clouds': return sel.cloudCount >= 2;
    case 'multiple-meshes': return sel.meshCount >= 2;
    case null:
    case undefined: return true;
    default: return true;
  }
}

/** Human-readable name of what a command needs, for disabled-state tooltips. */
export function requiresText(requires: ToolRequires): string {
  switch (requires) {
    case 'cloud': return 'a point cloud';
    case 'mesh': return 'a mesh';
    case 'skeleton': return 'a skeleton';
    case 'plant': return 'a plant mesh';
    case 'multiple-clouds': return '2+ point clouds';
    case 'multiple-meshes': return '2+ meshes';
    default: return '';
  }
}

// Toolbar groups are split across three sections, each its own toolbar block
// and menu. **Tools** is analysis-only (operates on existing data); geometry
// generation (**Create**) and scanner setup/simulation (**Simulate**) are
// scene-building, not analysis tools, so they live in their own sections.

/** Analysis tool groups — the **Tools** toolbar block and Tools menu. */
export const TOOL_GROUPS: { id: ToolGroup; label: string }[] = [
  { id: 'preprocess', label: 'Pre-processing' },
  { id: 'segment', label: 'Segmentation' },
  { id: 'reconstruct', label: 'Reconstruction' },
];

/** Geometry-generation groups — the **Create** toolbar block and Create menu. */
export const CREATE_GROUPS: { id: ToolGroup; label: string }[] = [
  { id: 'create', label: 'Create' },
];

/** Scanner-setup / simulation groups — the **Simulate** block and menu. */
export const SIMULATE_GROUPS: { id: ToolGroup; label: string }[] = [
  { id: 'simulate', label: 'Simulate' },
];

/** Commands belonging to a toolbar group, preserving registry order. */
export function commandsForGroup(commands: ToolCommand[], group: ToolGroup): ToolCommand[] {
  return commands.filter(c => c.toolGroup === group);
}
