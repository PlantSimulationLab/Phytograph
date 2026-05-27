# Releasing

Tag a version and push; the workflow at `.github/workflows/release.yml`
builds the backend, signs and notarizes the app on macOS, builds for
Windows, and publishes a draft GitHub Release.

```bash
git tag v0.2.0
git push origin v0.2.0
```

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
