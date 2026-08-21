// The single list of tools that appear in the native menu bar (Tools / Create /
// Simulate). It lives in `shared/` because it has to be read from BOTH sides of
// the process boundary: `src/main/menu.ts` builds the native submenus from it,
// and `toolMenu.test.ts` (next to this file) checks it against the renderer's
// tool registry so a tool can never again be added to the toolbar and silently
// left out of the menu.
//
// Why a separate list instead of importing the registry: the registry array is
// built inside PointCloudViewer because each command's `action` closes over
// component state, so the main process can't import it (it's React/renderer
// code). Only the *static* part — id, label, section — is needed to draw a
// menu, and that's what this file holds. The ids are the contract: clicking an
// item sends `{ kind: 'tool', toolId }`, which the renderer dispatches through
// __runToolCommand into the registry entry with that id.
//
// Menu labels are NOT the registry's `name` — menu convention is to suffix a
// trailing ellipsis on items that open a dialog before doing anything, so they
// are spelled out here.

/** A menu section, rendered as one submenu under its parent menu. */
export interface ToolMenuSection {
  label: string;
  /** Registry ids, in menu order. `null` renders a separator. */
  items: (ToolMenuItem | null)[];
}

export interface ToolMenuItem {
  /** Registry command id — the `toolId` sent to the renderer on click. */
  id: string;
  /** Menu label; trailing `…` when the tool opens a dialog first. */
  label: string;
}

/** Sections of the **Tools** menu (analysis operations on existing data). */
export const TOOLS_MENU: ToolMenuSection[] = [
  {
    label: 'Pre-processing',
    items: [
      { id: 'cloud-translate', label: 'Transform Point Cloud' },
      { id: 'set-scene-origin', label: 'Set Scene Origin' },
      { id: 'pick-point', label: 'Pick Point' },
      { id: 'cloud-crop', label: 'Crop Point Cloud' },
      { id: 'cloud-erase', label: 'Erase Brush' },
      { id: 'cloud-cross-section', label: 'Cross-section' },
      { id: 'cloud-filter', label: 'Filter Points' },
      { id: 'cloud-resample', label: 'Resample Point Cloud' },
      { id: 'cloud-move-origin', label: 'Move to Origin' },
      { id: 'cloud-backfill-misses', label: 'Backfill Misses' },
      null,
      { id: 'cloud-stitch', label: 'Stitch Clouds…' },
    ],
  },
  {
    label: 'Segmentation',
    items: [
      { id: 'cloud-label', label: 'Label Points' },
      { id: 'cloud-ground-segment', label: 'Segment Ground' },
      { id: 'cloud-wood-segment', label: 'Segment Wood / Leaf' },
      { id: 'cloud-segment-trees', label: 'Segment Trees' },
    ],
  },
  {
    label: 'Reconstruction & Analysis',
    items: [
      { id: 'cloud-triangulate', label: 'Triangulate…' },
      { id: 'cloud-dem', label: 'Generate DEM' },
      { id: 'cloud-skeleton', label: 'Extract Skeleton' },
      { id: 'cloud-qsm', label: 'Build QSM…' },
      { id: 'compute-lad', label: 'Compute Leaf Area Density…' },
      { id: 'fit-crown', label: 'Fit Crown & Metrics…' },
    ],
  },
  {
    // Registration spans two registry groups: cloud↔cloud ICP is a
    // `preprocess` toolbar tool, while the mesh ICP / distance tools have no
    // `toolGroup` at all (they're reached from the mesh context menu). The menu
    // gathers them under one heading because that's how a user thinks of them.
    label: 'Registration',
    items: [
      // Auto-Register first: it works from any starting pose, where ICP needs
      // the clouds already close. That ordering matches which one a user should
      // reach for by default.
      { id: 'cloud-auto-register', label: 'Auto-Register Clouds…' },
      { id: 'cloud-align', label: 'Align Clouds (ICP)…' },
      { id: 'mesh-mesh-align', label: 'Align Mesh to Mesh (ICP)…' },
      { id: 'mesh-cloud-icp', label: 'Align Mesh to Cloud (ICP)…' },
      { id: 'mesh-cloud-align', label: 'Cloud-to-Mesh Distance…' },
    ],
  },
];

/** The **Create** menu — geometry generation + scanner placement. */
export const CREATE_MENU: ToolMenuItem[] = [
  { id: 'create-plant', label: 'Generate Plant…' },
  { id: 'import-model', label: 'Import Model…' },
  { id: 'create-voxel', label: 'Create Voxel Grid' },
  { id: 'create-plane', label: 'Create Plane…' },
  { id: 'add-scan', label: 'Add Scan…' },
];

/** The **Simulate** menu — synthetic scanning. */
export const SIMULATE_MENU: ToolMenuItem[] = [
  { id: 'lidar-scan', label: 'Run Synthetic Scan…' },
];

/** Every registry id reachable from the native menu bar. */
export function allMenuToolIds(): string[] {
  return [
    ...TOOLS_MENU.flatMap(s => s.items.filter((i): i is ToolMenuItem => i !== null).map(i => i.id)),
    ...CREATE_MENU.map(i => i.id),
    ...SIMULATE_MENU.map(i => i.id),
  ];
}
