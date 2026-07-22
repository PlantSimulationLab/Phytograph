# Releasing

Tag a version and push; the workflow at `.github/workflows/release.yml`
builds the backend and packages the app on four runners in parallel —
macOS Apple Silicon and macOS Intel (both signed + notarized), Windows,
and Linux — and uploads every artifact to a single GitHub Release.

```bash
git tag v0.2.0
git push origin v0.2.0
```

The two macOS runners exist because the Python backend (PyInstaller +
libhelios) must be compiled **natively on each architecture** — an
arm64-built backend inside an x64 app is dead on arrival on Intel Macs.
Each macOS job packages only its own architecture, and a final
`merge-latest-mac` job merges the two `latest-mac.yml` auto-updater
manifests so in-app updates work on both. The Intel job runs on
`macos-15-intel`, GitHub's last x86_64 image — it retires in August
2027, at which point Intel macOS builds end.

## Publishing and download links

The release is **published directly** (not left as a draft):
`build.publish.releaseType` in `package.json` is `release`, which is
required for the in-app "Check for Updates" (electron-updater) to detect
it. Expect these artifacts: two macOS `.dmg` + `.zip` pairs (arm64 and
x64), one Windows `.exe`, one Linux `.AppImage`, plus updater metadata
(`latest*.yml`, `.blockmap`).

Publishing flags the release "Latest" — which is what makes
`https://github.com/PlantSimulationLab/Phytograph/releases/latest` (the
link the lab website points at) resolve to it.

## Required GitHub Secrets

| Secret | Purpose |
|---|---|
| `APPLE_CERTIFICATE` | base64 of the `.p12` Developer ID cert |
| `APPLE_CERTIFICATE_PASSWORD` | password for the `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | Apple ID email used for notarization |
| `APPLE_PASSWORD` | app-specific password for notarization |
| `APPLE_TEAM_ID` | 10-character Apple Team ID |
| `WIN_CSC_LINK` | (optional) base64 of Windows code-signing cert |
| `WIN_CSC_KEY_PASSWORD` | (optional) Windows cert password |

!!! warning "Use an app-specific password"
    `APPLE_PASSWORD` should be an **app-specific password** generated at
    [appleid.apple.com](https://appleid.apple.com), not your real Apple ID
    password.

## Version bumping

When backend changes require users to receive a new build, all three of
these must move together — the supervisor refuses to start mismatched
versions:

1. `backend-api/main.py` — bump `BACKEND_VERSION`
2. `src/shared/constants.ts` — bump `EXPECTED_BACKEND_VERSION` to match
3. `package.json` — bump `version`

Then tag and push:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

See **[Version Lock](../architecture/version-lock.md)** for why this contract
exists.

## Commit conventions

Do **not** sign commits with AI co-author trailers. No
`Co-Authored-By: Claude …`, no "Generated with Claude Code" lines in PR
descriptions, no model attribution of any kind. Commits should appear
authored solely by the human committer.
