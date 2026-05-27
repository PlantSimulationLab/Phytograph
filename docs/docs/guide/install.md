# Install Phytograph

Phytograph runs on macOS (Apple Silicon and Intel) and Windows 10/11.
There is no installer for Linux yet — see the
[developer instructions](../developers/getting-started/installation.md)
to build from source.

## Download

Get the latest installer from the
[GitHub Releases page](https://github.com/PlantSimulationLab/phytograph/releases).

| Platform | File |
|---|---|
| macOS (Apple Silicon, M1/M2/M3/M4) | `Phytograph-X.Y.Z-arm64.dmg` |
| macOS (Intel) | `Phytograph-X.Y.Z.dmg` |
| Windows 10/11 | `Phytograph Setup X.Y.Z.exe` |

## Install on macOS

1. Double-click the `.dmg` file.
2. Drag the **Phytograph** icon into your **Applications** folder.
3. Eject the disk image and launch Phytograph from Applications or
   Spotlight.

The first launch takes about 30 seconds while the bundled scientific
Python environment unpacks itself. Subsequent launches are instant.

!!! note "If macOS says the app can't be opened"
    On a fresh install you may see *"Phytograph can't be opened because
    Apple cannot check it for malicious software"*. Right-click the app
    in Applications, choose **Open**, and click **Open** in the dialog.
    You only need to do this once.

## Install on Windows

1. Double-click `Phytograph Setup X.Y.Z.exe`.
2. If SmartScreen warns you, click **More info → Run anyway**.
3. Follow the installer prompts.
4. Launch Phytograph from the Start menu.

## What gets installed

Phytograph ships as a single self-contained application bundle. It
includes its own Python environment with all scientific libraries
(`open3d`, `scipy`, `pyhelios`) embedded. You don't need to install
Python, Conda, or anything else separately.

The app stores its preferences and recent files list in:

- **macOS**: `~/Library/Application Support/Phytograph/`
- **Windows**: `%APPDATA%\Phytograph\`

## What's next

Open the app and continue to **[Your first import](first-import.md)**.
