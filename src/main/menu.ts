import { BrowserWindow, Menu, MenuItemConstructorOptions, app, shell } from 'electron';
import { IPC, type MenuCommandPayload, type SnapViewDirection } from '../shared/ipc.js';
import { REPO_URL } from '../shared/constants.js';

const isMac = process.platform === 'darwin';
const isE2E = process.env.PHYTOGRAPH_E2E === '1';
const isDev = !app.isPackaged;

export function installApplicationMenu(getMainWindow: () => BrowserWindow | null): void {
  // Tests assume an inert chrome — no native menu wired to the window.
  if (isE2E) {
    Menu.setApplicationMenu(null);
    return;
  }

  const send = (payload: MenuCommandPayload): void => {
    const win = getMainWindow();
    win?.webContents.send(IPC.MenuCommand, payload);
  };

  const snapItem = (label: string, direction: SnapViewDirection, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => send({ kind: 'snap-view', direction }),
  });

  const template: MenuItemConstructorOptions[] = [
    // macOS app menu (the first menu, always labeled "Phytograph").
    // We build this manually instead of role:'appMenu' so we can both slot
    // "Settings" between About and Services, and override the menu-bar label.
    ...(isMac
      ? ([
          {
            // Hard-coded instead of app.name: in dev, the running binary is
            // node_modules/electron/dist/Electron.app, whose CFBundleName
            // ("Electron") wins over app.setName() for the menu-bar label.
            // Setting the label directly on the menu template overrides it.
            label: 'Phytograph',
            submenu: [
              // Custom About dialog (React) instead of role:'about', which would
              // show Electron's framework logo + Electron's version. Ours lists
              // the app, backend, PyHelios, and helios-core versions.
              { label: 'About Phytograph', click: () => send({ kind: 'about' }) },
              { type: 'separator' },
              {
                label: 'Settings…',
                accelerator: 'CmdOrCtrl+,',
                click: () => send({ kind: 'nav', target: 'options' }),
              },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Import',
          submenu: [
            { label: 'Auto-detect…', click: () => send({ kind: 'import-auto' }) },
            { type: 'separator' },
            { label: 'Point Cloud…', click: () => send({ kind: 'import-point-cloud' }) },
            { label: 'Mesh…', click: () => send({ kind: 'import-mesh' }) },
            { label: 'Skeleton…', click: () => send({ kind: 'import-skeleton' }) },
            { label: 'Scan XML…', click: () => send({ kind: 'import-scan-xml' }) },
          ],
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => send({ kind: 'save' }),
        },
        {
          label: 'Export…',
          accelerator: 'Shift+CmdOrCtrl+E',
          click: () => send({ kind: 'export' }),
        },
        // Settings + Quit live in the app menu on macOS (per platform convention),
        // so only add them under File on Windows/Linux.
        ...(isMac
          ? []
          : ([
              { type: 'separator' },
              {
                label: 'Settings',
                accelerator: 'Ctrl+,',
                click: () => send({ kind: 'nav', target: 'options' }),
              },
              { type: 'separator' },
              { role: 'quit' },
            ] as MenuItemConstructorOptions[])),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          click: () => send({ kind: 'undo' }),
        },
        {
          label: 'Redo',
          accelerator: isMac ? 'Shift+CmdOrCtrl+Z' : 'CmdOrCtrl+Y',
          click: () => send({ kind: 'redo' }),
        },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        {
          label: 'Select All',
          accelerator: 'CmdOrCtrl+A',
          click: () => send({ kind: 'select-all' }),
        },
        {
          label: 'Deselect All',
          accelerator: 'Shift+CmdOrCtrl+A',
          click: () => send({ kind: 'deselect-all' }),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reset Camera (Fit All)',
          accelerator: 'CmdOrCtrl+0',
          click: () => send({ kind: 'reset-camera' }),
        },
        {
          label: 'Fit to Selection',
          accelerator: 'CmdOrCtrl+9',
          click: () => send({ kind: 'fit-selection' }),
        },
        {
          label: 'Camera View',
          submenu: [
            snapItem('Top', 'top'),
            snapItem('Bottom', 'bottom'),
            snapItem('Front', 'front'),
            snapItem('Back', 'back'),
            snapItem('Left', 'left'),
            snapItem('Right', 'right'),
            snapItem('Isometric', 'iso'),
          ],
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev
          ? ([
              { type: 'separator' },
              { role: 'reload' },
              { role: 'toggleDevTools' },
            ] as MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      // Tools — analysis operations on existing data. Each item runs a tool by
      // its registry id via { kind: 'tool' }; the renderer dispatches through
      // __runToolCommand (the tool actions live in PointCloudViewer's registry,
      // the single source of truth shared with the toolbar and Cmd+K palette).
      // Geometry generation and synthetic scanning are NOT here — they're
      // scene-building, so they live under their own Create / Simulate menus.
      label: 'Tools',
      submenu: [
        {
          label: 'Pre-processing',
          submenu: [
            { label: 'Translate Point Cloud', click: () => send({ kind: 'tool', toolId: 'cloud-translate' }) },
            { label: 'Crop Point Cloud', click: () => send({ kind: 'tool', toolId: 'cloud-crop' }) },
            { label: 'Erase Brush', click: () => send({ kind: 'tool', toolId: 'cloud-erase' }) },
            { label: 'Filter Points', click: () => send({ kind: 'tool', toolId: 'cloud-filter' }) },
            { label: 'Resample Point Cloud', click: () => send({ kind: 'tool', toolId: 'cloud-resample' }) },
            { label: 'Move to Origin', click: () => send({ kind: 'tool', toolId: 'cloud-move-origin' }) },
            { label: 'Backfill Misses', click: () => send({ kind: 'tool', toolId: 'cloud-backfill-misses' }) },
            { type: 'separator' },
            { label: 'Align Clouds (ICP)…', click: () => send({ kind: 'tool', toolId: 'cloud-align' }) },
            { label: 'Stitch Clouds…', click: () => send({ kind: 'tool', toolId: 'cloud-stitch' }) },
          ],
        },
        {
          label: 'Segmentation',
          submenu: [
            { label: 'Segment Ground', click: () => send({ kind: 'tool', toolId: 'cloud-ground-segment' }) },
            { label: 'Segment Wood / Leaf', click: () => send({ kind: 'tool', toolId: 'cloud-wood-segment' }) },
            { label: 'Segment Trees', click: () => send({ kind: 'tool', toolId: 'cloud-segment-trees' }) },
          ],
        },
        {
          label: 'Reconstruction & Analysis',
          submenu: [
            { label: 'Triangulate…', click: () => send({ kind: 'tool', toolId: 'cloud-triangulate' }) },
            { label: 'Extract Skeleton', click: () => send({ kind: 'tool', toolId: 'cloud-skeleton' }) },
            { label: 'Build QSM', click: () => send({ kind: 'tool', toolId: 'cloud-qsm' }) },
            { label: 'Compute Leaf Area Density…', click: () => send({ kind: 'tool', toolId: 'compute-lad' }) },
          ],
        },
      ],
    },
    {
      // Create — geometry generation + scanner placement (scene-building).
      label: 'Create',
      submenu: [
        { label: 'Generate Plant…', click: () => send({ kind: 'tool', toolId: 'create-plant' }) },
        { label: 'Import Model…', click: () => send({ kind: 'tool', toolId: 'import-model' }) },
        { label: 'Create Voxel Grid', click: () => send({ kind: 'tool', toolId: 'create-voxel' }) },
        { label: 'Add Scan…', click: () => send({ kind: 'tool', toolId: 'add-scan' }) },
      ],
    },
    {
      // Simulate — synthetic scanning.
      label: 'Simulate',
      submenu: [
        { label: 'Run Synthetic Scan…', click: () => send({ kind: 'tool', toolId: 'lidar-scan' }) },
      ],
    },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Report a Bug…',
          click: () => send({ kind: 'feedback', mode: 'bug' }),
        },
        {
          label: 'Request a Feature…',
          click: () => send({ kind: 'feedback', mode: 'feature' }),
        },
        { type: 'separator' },
        {
          label: 'Phytograph on GitHub',
          click: () => {
            void shell.openExternal(REPO_URL);
          },
        },
        // On macOS, About lives in the app menu (per convention). On
        // Windows/Linux there's no app menu, so surface it under Help.
        ...(isMac
          ? []
          : ([
              { type: 'separator' },
              { label: 'About Phytograph', click: () => send({ kind: 'about' }) },
            ] as MenuItemConstructorOptions[])),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
