# Install Phytograph

Phytograph runs on macOS (Apple Silicon and Intel), Windows 10/11, and
Linux (x64, glibc 2.38 or newer — see
[Install on Linux](#install-on-linux)).

## Download

Download the installer for your platform — each link always fetches the
newest release:

| Platform | Download |
|---|---|
| macOS (Apple Silicon, M1/M2/M3/M4) | [:material-download: `Phytograph-arm64.dmg`](https://github.com/PlantSimulationLab/Phytograph/releases/latest/download/Phytograph-arm64.dmg) |
| macOS (Intel) | [:material-download: `Phytograph-x64.dmg`](https://github.com/PlantSimulationLab/Phytograph/releases/latest/download/Phytograph-x64.dmg) |
| Windows 10/11 | [:material-download: `Phytograph-Setup.exe`](https://github.com/PlantSimulationLab/Phytograph/releases/latest/download/Phytograph-Setup.exe) |
| Linux (x64, glibc 2.38+) | [:material-download: `Phytograph-x86_64.AppImage`](https://github.com/PlantSimulationLab/Phytograph/releases/latest/download/Phytograph-x86_64.AppImage) |

Not sure which macOS build you need? Apple menu → **About This Mac**: a
*Chip* line starting with "Apple" means Apple Silicon; an *Intel* processor
means the Intel build.

For older versions, release notes, and checksums, see the
[GitHub Releases page](https://github.com/PlantSimulationLab/Phytograph/releases/latest).

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

!!! note "If the browser blocks the download"
    Edge and Chrome flag installers that few people have downloaded yet, and
    the file stays in your Downloads folder as a partial `.crdownload` until
    you explicitly keep it.

    **Edge** — press ++ctrl+j++ to open Downloads, hover the Phytograph entry,
    click the **…** menu, choose **Keep**, then **Show more → Keep anyway**.

    **Chrome** — open `chrome://downloads`, find the entry, and click
    **Keep** (it may sit behind a **…** menu on the warning bar).

    Both take two clicks: the first expands the warning, the second releases
    the download. Closing the panel in between leaves the partial file.

!!! note "If Windows blocks the installer"
    Right-click `Phytograph-Setup.exe` → **Properties** → tick **Unblock** at
    the bottom of the General tab → **Apply**, then run it. This is only needed
    when the **More info → Run anyway** link is hidden by a managed policy.

## Install on Linux

Phytograph ships as a single **AppImage** — nothing to install, but it does
need a reasonably recent distribution (see the requirement below).

Run it **from a terminal**:

```bash
chmod +x Phytograph-x86_64.AppImage
./Phytograph-x86_64.AppImage
```

As with macOS, the first launch takes about 30 seconds while the bundled
Python environment unpacks itself.

!!! warning "Requires glibc 2.38 or newer"
    Check your system first:

    ```bash
    ldd --version
    ```

    The first line ends with your glibc version. **2.38 or higher is
    required.**

    | Works | Does not work |
    |---|---|
    | Ubuntu 23.10+ (24.04 LTS and later) | Ubuntu 22.04 LTS and older |
    | Debian 13 "trixie" | Debian 12 and older |
    | Fedora 39+ | RHEL / Rocky / AlmaLinux 8 and 9 |
    | Arch, openSUSE Tumbleweed, other rolling releases | |

    On an older system the failure is confusing rather than obvious: the
    AppImage starts and the Phytograph window appears, but the compute
    backend cannot load and nothing works. The log records a loader error
    naming `GLIBC_2.38`. If you see that, this is the cause — the app cannot
    run on that machine, and no setting or permission will change it.

    This is a hard limit of how the Linux build is compiled, not a policy
    choice. Many HPC and institutional machines run RHEL 8/9 or Ubuntu 22.04
    and are affected; if that is your situation, please
    [open an issue](https://github.com/PlantSimulationLab/Phytograph/issues)
    so we can weigh building for an older baseline.

!!! note "Double-clicking usually won't work"
    Most Linux file managers — GNOME Files (Nautilus), Nemo, Caja — refuse
    to launch executables, for security reasons, so double-clicking an
    AppImage does nothing even after `chmod +x`. Launch it from a terminal
    as shown above. If you want a menu entry, create a `.desktop` file in
    `~/.local/share/applications/` pointing at the AppImage.

!!! note "AppImage prerequisites"
    The AppImage needs FUSE to mount itself. Most desktop distributions
    ship it; on a minimal install run `sudo apt install libfuse2`
    (Debian/Ubuntu) or your distribution's equivalent. Alternatively,
    extract and run without FUSE:
    `./Phytograph-x86_64.AppImage --appimage-extract-and-run`.

## What gets installed

Phytograph ships as a single self-contained application bundle. It
includes its own Python environment with all scientific libraries
(`open3d`, `scipy`, `pyhelios`) embedded. You don't need to install
Python, Conda, or anything else separately.

The app stores its preferences and recent files list in:

- **macOS**: `~/Library/Application Support/phytograph/`
- **Windows**: `%APPDATA%\phytograph\`
- **Linux**: `~/.config/phytograph/`

(Lowercase — this directory is named after the app's internal name. macOS and
Windows are case-insensitive so the capitalisation there makes no difference,
but on Linux it does.)

Imported point clouds are also cached on disk in a streaming format, so
reopening a scan is fast. That cache is separate, and safe to delete when
you need the space — anything still reachable from its original file is
rebuilt on demand:

- **macOS**: `~/Library/Caches/Phytograph/octrees/`
- **Windows**: `%LOCALAPPDATA%\Phytograph\cache\octrees\`
- **Linux**: `~/.cache/Phytograph/octrees/`

## What's next

Open the app and continue to **[Your first import](first-import.md)**.
