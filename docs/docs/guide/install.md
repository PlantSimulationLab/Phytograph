# Install Phytograph

Phytograph runs on macOS (Apple Silicon and Intel), Windows 10/11, and
Linux (x64).

## Download

Get the latest installer from the
[GitHub Releases page](https://github.com/PlantSimulationLab/phytograph/releases/latest).

| Platform | File |
|---|---|
| macOS (Apple Silicon, M1/M2/M3/M4) | `Phytograph-arm64.dmg` |
| macOS (Intel) | `Phytograph-x64.dmg` |
| Windows 10/11 | `Phytograph-Setup.exe` |
| Linux (most distros) | `Phytograph.AppImage` |
| Linux (Debian/Ubuntu) | `Phytograph-amd64.deb` |

## Install on macOS

1. Double-click the `.dmg` file.
2. Drag the **Phytograph** icon into your **Applications** folder.
3. Eject the disk image and launch Phytograph from Applications or
   Spotlight.

The first launch takes about 30 seconds while the bundled scientific
Python environment unpacks itself. Subsequent launches are instant.

Phytograph is signed with an Apple Developer ID and notarized by Apple, so
it opens with a normal double-click — no security warning.

!!! note "If macOS still says the app can't be opened"
    Older or unsigned builds may show *"Phytograph can't be opened because
    Apple cannot check it for malicious software"*. Right-click the app
    in Applications, choose **Open**, and click **Open** in the dialog.
    You only need to do this once.

## Install on Windows

1. Double-click `Phytograph-Setup.exe`.
2. If SmartScreen warns you, click **More info → Run anyway**.
3. Follow the installer prompts.
4. Launch Phytograph from the Start menu.

## Install on Linux

Two formats are provided. The **AppImage** runs on most distributions
without installing anything:

```bash
chmod +x Phytograph.AppImage
./Phytograph.AppImage
```

On **Debian/Ubuntu** you can install the `.deb` instead, which adds a
desktop launcher and menu entry:

```bash
sudo apt install ./Phytograph-amd64.deb
```

As with macOS, the first launch takes about 30 seconds while the bundled
Python environment unpacks itself.

!!! note "AppImage prerequisites"
    The AppImage needs FUSE to mount itself. Most desktop distributions
    ship it; on a minimal install run `sudo apt install libfuse2`
    (Debian/Ubuntu) or your distribution's equivalent. Alternatively,
    extract and run without FUSE:
    `./Phytograph.AppImage --appimage-extract-and-run`.

## What gets installed

Phytograph ships as a single self-contained application bundle. It
includes its own Python environment with all scientific libraries
(`open3d`, `scipy`, `pyhelios`) embedded. You don't need to install
Python, Conda, or anything else separately.

The app stores its preferences and recent files list in:

- **macOS**: `~/Library/Application Support/Phytograph/`
- **Windows**: `%APPDATA%\Phytograph\`
- **Linux**: `~/.config/Phytograph/`

## What's next

Open the app and continue to **[Your first import](first-import.md)**.
