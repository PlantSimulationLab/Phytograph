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

    **`.noindex` handles Spotlight but not Launch Services.** The suffix
    suppresses Spotlight *content indexing* only; Launch Services is a separate
    subsystem that registers any app bundle it notices, so a build into the
    `.noindex` directory still lands in `lsregister -dump` and the Apps
    launcher. `scripts/run-electron-builder.mjs` therefore runs
    `lsregister -u` on each unpacked `<output>/mac*/Phytograph.app` after every
    local build (macOS only, skipped under `CI`, never fails the build).

    To audit by hand:

    ```bash
    /System/Library/Frameworks/CoreServices.framework/Frameworks/\
    LaunchServices.framework/Support/lsregister -dump | grep -i phytograph.app
    ```

    Only `/Applications/Phytograph.app` (and its nested helpers) should appear.
    Mounted DMG volumes under `/Volumes/` are normal — they clear on eject.

    CI keeps the repo-relative `release/` default (ephemeral runners, no
    Dropbox or Launch Services to pollute). Override anywhere with
    `PHYTOGRAPH_BUILD_OUTPUT=/some/path`. Resolution lives in
    `scripts/build-output-dir.mjs`.

### Generated directories inside a Dropbox checkout

A checkout that lives in a Dropbox folder would otherwise sync ~6.5 GB of
regenerable output — `node_modules`, `backend-api/venv`,
`resources/phytograph_backend`, the `dist-` dirs,
`pyhelios/pyhelios_build`, `docs/site`, `tmp`, and the pytest /
`__pycache__` caches — and hand all of it to whatever backup and
endpoint-security agents watch the same tree. On a profiled E2E run that
background churn cost more CPU than the tests themselves.

`scripts/dropbox-ignore.mjs` marks those directories with the
`com.dropbox.ignored` extended attribute:

```bash
npm run dropbox:ignore
```

!!! warning "Applying it by hand once does not stick"

    The attribute lives on the **directory**, and builds delete and
    recreate those directories — `npm run build:backend` replaces all
    ~1 GB of `resources/phytograph_backend/` every time. The fresh
    directory comes back un-ignored and starts syncing again. That is why
    the script is wired into `postinstall`, the tail of `npm run build`,
    and the exit path of `scripts/build-backend.mjs` rather than being a
    one-time `xattr -w`.

It no-ops off macOS, under `CI`, and outside a Dropbox tree.
`example-datasets/` is deliberately **not** ignored — it is gitignored
only because it is too large for git, but it is real input data that
belongs in sync.

`.claude/worktrees/` is ignored too. Agent worktrees are full duplicate
checkouts that build their own venv and `node_modules`, and they are
abandoned rather than cleaned up — one stale worktree measured 3.9 GB.
Prune them periodically:

```bash
git worktree list                        # anything under .claude/worktrees/
git worktree remove --force <path>       # after checking for unmerged commits
```

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
