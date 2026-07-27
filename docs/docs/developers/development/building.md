# Building Local Installers

Produces an unsigned `.dmg` / `.exe` you can install and test, without
needing Apple/Microsoft signing credentials.

```bash
# 1. Build the Python sidecar into a self-contained bundle.
#    Auto-discovers backend-api/venv/bin/python; the venv does not need
#    to be active.
npm run build:backend

# 2. Package the Electron app for the current OS.
SKIP_NOTARIZATION=1 npm run package          # macOS — skips notarization
npm run package:win                          # Windows
npm run package:linux                        # Linux (run on a Linux box)
```

Artifacts land in `~/builds/phytograph.noindex/` on a local build
(filenames are intentionally **version-free** so the lab-website "latest"
download links never change between releases):

- **macOS**: `Phytograph-arm64.dmg`, `Phytograph-x64.dmg`
- **Windows**: `Phytograph-Setup.exe`
- **Linux**: `Phytograph.AppImage`, `Phytograph-amd64.deb`

!!! note "Why not in the repo?"

    electron-builder unpacks a full `Phytograph.app` under `<output>/mac*/`
    alongside the installers. When the output directory lived inside the
    Dropbox-synced repo, macOS Launch Services registered those unpacked
    bundles and Phytograph appeared **three times** in the Apps launcher and
    Spotlight — and Dropbox synced ~2.8 GB of throwaway bundles.

    Local builds therefore write to `~/builds/phytograph.noindex`: outside the
    synced tree, and the `.noindex` suffix makes Spotlight skip the directory
    entirely. Only the finished DMG/ZIP should be copied into Dropbox for
    distribution — never the unpacked `.app`.

    CI keeps the repo-relative `release/` default (ephemeral runners, no
    Dropbox or Launch Services to pollute). Override anywhere with
    `PHYTOGRAPH_BUILD_OUTPUT=/some/path`. Resolution lives in
    `scripts/build-output-dir.mjs`.

## Launching the unsigned macOS build for testing

Gatekeeper blocks unsigned apps by default:

```bash
open ~/builds/phytograph.noindex/mac-arm64/Phytograph.app
# If macOS refuses: right-click the .app in Finder → Open → "Open anyway".
```

If you've previously installed Phytograph and the quarantine bit is
sticking around, you can clear it on unsigned builds only:

```bash
xattr -dr com.apple.quarantine /Applications/Phytograph.app
```

This does **not** work on signed builds — the CodeSignature seal makes
xattrs immutable; install via Finder drag instead.

## Why outputs are gitignored

`dist-*`, the build output dir, and `resources/phytograph_backend/` are all
reproducible from source by the scripts above. They're large, binary, and
machine-specific — ideal candidates for `.gitignore`.
