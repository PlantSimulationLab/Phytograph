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
```

Artifacts land in `release/`:

- **macOS**: `Phytograph-X.Y.Z-arm64.dmg`, `Phytograph-X.Y.Z.dmg` (x64)
- **Windows**: `Phytograph Setup X.Y.Z.exe`

## Launching the unsigned macOS build for testing

Gatekeeper blocks unsigned apps by default:

```bash
open release/mac-arm64/Phytograph.app
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

`dist-*`, `release/`, and `resources/phytograph_backend/` are all
reproducible from source by the scripts above. They're large, binary, and
machine-specific — ideal candidates for `.gitignore`.
