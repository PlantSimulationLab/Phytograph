import { BrowserWindow, Menu, MenuItemConstructorOptions, app, shell } from 'electron';
import { IPC, type MenuCommandPayload, type SnapViewDirection } from '../shared/ipc.js';

const isMac = process.platform === 'darwin';
const isE2E = process.env.PHYTOGRAPH_E2E === '1';
const isDev = !app.isPackaged;

const REPO_URL = 'https://github.com/PlantSimulationLab/phytograph';

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
              { role: 'about' },
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
            { label: 'Point Cloud…', click: () => send({ kind: 'import-point-cloud' }) },
            { label: 'Mesh…', click: () => send({ kind: 'import-mesh' }) },
            { label: 'Skeleton…', click: () => send({ kind: 'import-skeleton' }) },
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
          label: 'Viewer',
          accelerator: 'CmdOrCtrl+1',
          click: () => send({ kind: 'nav', target: 'viewer' }),
        },
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+2',
          click: () => send({ kind: 'nav', target: 'options' }),
        },
        { type: 'separator' },
        {
          label: 'Reset Camera',
          accelerator: 'CmdOrCtrl+0',
          click: () => send({ kind: 'reset-camera' }),
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
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Phytograph on GitHub',
          click: () => {
            void shell.openExternal(REPO_URL);
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
