#!/usr/bin/env node
// Prune installer binaries from old GitHub Releases.
//
// Why this exists: each release ships ~3.6 GB of installers (six binaries,
// plus a duplicate dmg/zip pair per macOS arch because electron-updater wants
// the zip while humans want the dmg). Actions *artifacts* self-expire after 30
// days; release *assets* never do. Four releases were enough to fill the org's
// entire 20 GB shared-storage quota — at which point GitHub meters the overage
// daily whether or not any workflow runs, so an idle weekend still burns
// allowance. See `npm run prune:releases -- --dry-run`.
//
// Policy: keep the binaries for the newest KEEP releases (default 2 — the
// current one and one prior, so there's always a rollback target). Older
// releases keep their tag, notes, and small metadata (.yml manifests and
// .blockmap files, ~3 MB per release) — only the large binaries are removed.
// Keeping the manifests matters: electron-updater reads latest*.yml, and a
// release page with notes but no multi-hundred-MB payload still reads as a
// real historical entry.
//
// Deleting an asset is irreversible — GitHub keeps no copy and these binaries
// are code-signed and notarized, so restoring one means re-running the whole
// signed pipeline against the old tag. Hence: --dry-run is the default posture
// in review, prereleases and drafts are skipped, and anything unparseable is
// left alone rather than guessed at.

import { execFileSync } from 'node:child_process'

const REPO = process.env.PRUNE_REPO || 'PlantSimulationLab/Phytograph'
// Extensions worth reclaiming. Everything else (.yml, .blockmap) is tiny and
// load-bearing for the updater, so it stays.
const BINARY_RE = /\.(dmg|zip|exe|AppImage|deb|rpm|snap|tar\.gz)$/i

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const keepArg = args.find((a) => a.startsWith('--keep='))
const keep = keepArg ? Number(keepArg.split('=')[1]) : 2

if (!Number.isInteger(keep) || keep < 1) {
  console.error(`FAIL: --keep must be a positive integer (got ${keep})`)
  process.exit(1)
}

const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const mb = (b) => (b / 1024 / 1024).toFixed(1).padStart(8)

// Semver-ish comparison on the tag. We deliberately do NOT trust the API's
// return order or published_at: a re-published or back-dated release would
// otherwise silently change which versions are protected.
function parseVersion(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

const releases = JSON.parse(
  gh('api', '--paginate', `/repos/${REPO}/releases?per_page=100`),
)

// Drafts and prereleases are excluded from the ordering entirely: they must
// never consume a "keep" slot (that would silently unprotect a real release)
// and must never be pruned.
const stable = releases
  .filter((r) => !r.draft && !r.prerelease && parseVersion(r.tag_name))
  .sort((a, b) => {
    const [A, B] = [parseVersion(a.tag_name), parseVersion(b.tag_name)]
    return B[0] - A[0] || B[1] - A[1] || B[2] - A[2]
  })

const skipped = releases.length - stable.length
if (skipped > 0) {
  console.log(`Skipping ${skipped} draft/prerelease/unparseable release(s) — never pruned.`)
}

const protectedReleases = stable.slice(0, keep)
const prunable = stable.slice(keep)

console.log(`\nKeeping binaries for the newest ${keep} release(s):`)
for (const r of protectedReleases) console.log(`  KEEP  ${r.tag_name}`)

if (prunable.length === 0) {
  console.log(`\nNothing older than that — no pruning needed.`)
  process.exit(0)
}

let freed = 0
let deleted = 0
let failed = 0

for (const r of prunable) {
  const binaries = (r.assets || []).filter((a) => BINARY_RE.test(a.name))
  if (binaries.length === 0) {
    console.log(`\n  ${r.tag_name}: already pruned.`)
    continue
  }
  console.log(`\n  PRUNE ${r.tag_name}:`)
  for (const a of binaries) {
    if (dryRun) {
      console.log(`    would delete ${mb(a.size)} MB  ${a.name}`)
      freed += a.size
      continue
    }
    try {
      gh('api', '-X', 'DELETE', `/repos/${REPO}/releases/assets/${a.id}`)
      console.log(`    deleted      ${mb(a.size)} MB  ${a.name}`)
      freed += a.size
      deleted++
    } catch (err) {
      // Never fail the release over cleanup: a failed delete just means the
      // storage is reclaimed on the next run.
      console.log(`    FAILED       ${mb(a.size)} MB  ${a.name} — ${err.message.split('\n')[0]}`)
      failed++
    }
  }
}

const verb = dryRun ? 'would free' : 'freed'
console.log(`\n${verb} ${(freed / 1024 ** 3).toFixed(2)} GB` + (dryRun ? ' (dry run — nothing deleted)' : ` across ${deleted} asset(s)`))
if (failed > 0) console.log(`${failed} deletion(s) failed; they will be retried on the next release.`)
