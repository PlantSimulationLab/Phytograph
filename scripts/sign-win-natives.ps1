<#
Signs, or verifies, every native library under one or more directory trees.

Windows application control (Smart App Control on Windows 11, WDAC/AppLocker on
a managed machine) judges each library as it LOADS, so one unsigned file is
enough to stop the app: issue #6 was a signed phytograph_backend.exe that died
at `import pandas` with "An Application Control policy has blocked this file".
electron-builder signs .exe files and nothing else, so everything else is signed
here.

Three callers, one definition of "signed":

  - release.yml "Sign bundled native libraries (Windows)" — the two sidecar
    trees under resources/, before electron-builder packages them.
  - scripts/after-pack-win-sign.cjs — the whole unpacked app, from inside
    electron-builder, which is the only point where Electron's own DLLs
    (ffmpeg.dll, libEGL.dll, ...) exist and the installer does not yet.
  - release.yml "Verify Windows signature" — `-VerifyOnly -IncludeExe` over the
    packaged tree, after electron-builder has signed the executables.

What is signed: every PE image that is not an .exe (electron-builder signs
those AFTER its afterPack hook, so signing them here would sign them twice).
Files are found by reading the PE header, not by extension — an extension list
is how the first version of this covered the sidecars and missed Electron.

What is NOT signed: a file that already carries a valid embedded signature. It
keeps its vendor's name. Re-signing would replace a better-known publisher with
ours, and for some redistributables the license grants copying, not modifying.
Every run prints who signed what, so the vendor list is never a guess.

"Signed" is asked of `signtool verify /pa /tw`, never Get-AuthenticodeSignature.
For a file Windows also knows through a CATALOG the cmdlet reports the catalog's
signer and ignores the signature embedded in the file, and a catalog stays on
the build machine. `/pa` without `/a` reads only the embedded signature; `/tw`
turns a missing timestamp into exit 2.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string[]]$Roots,
  # Check only; sign nothing and need no Azure credentials.
  [switch]$VerifyOnly,
  # Also require .exe files to be signed. Only meaningful once electron-builder
  # has run, so only the final verification passes it.
  [switch]$IncludeExe
)

$ErrorActionPreference = 'Stop'
$clock = [System.Diagnostics.Stopwatch]::StartNew()
function Write-Phase([string]$what) {
  Write-Host ("[{0,6:n1}s] {1}" -f $clock.Elapsed.TotalSeconds, $what)
}

$cfg = node (Join-Path $PSScriptRoot 'azure-sign-config.mjs') | ConvertFrom-Json
$ourCn = "CN=$($cfg.publisherName)"

# Prefer the signtool the signer itself runs (laid down by the workflow's
# pre-install step); fall back to the Windows SDK for a verify-only run.
$signtool = $null
foreach ($dir in @((Join-Path $env:LOCALAPPDATA 'TrustedSigning'), "${env:ProgramFiles(x86)}\Windows Kits\10\bin")) {
  if (-not (Test-Path $dir)) { continue }
  $signtool = Get-ChildItem -Path $dir -Filter 'signtool.exe' -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\' } |
    Sort-Object FullName -Descending | Select-Object -First 1
  if ($signtool) { break }
}
if (-not $signtool) { Write-Host 'FAIL: signtool.exe not found'; exit 1 }

# A PE image: "MZ", then "PE\0\0" at the offset stored at 0x3C.
function Test-PeImage([string]$path) {
  $fs = [System.IO.File]::OpenRead($path)
  try {
    $head = New-Object byte[] 64
    if ($fs.Read($head, 0, 64) -lt 64) { return $false }
    if ($head[0] -ne 0x4D -or $head[1] -ne 0x5A) { return $false }
    $offset = [System.BitConverter]::ToInt32($head, 60)
    if ($offset -le 0 -or $offset -gt ($fs.Length - 4)) { return $false }
    $fs.Position = $offset
    $sig = New-Object byte[] 4
    if ($fs.Read($sig, 0, 4) -lt 4) { return $false }
    return ($sig[0] -eq 0x50 -and $sig[1] -eq 0x45 -and $sig[2] -eq 0 -and $sig[3] -eq 0)
  } finally {
    $fs.Dispose()
  }
}

# 'timestamped' | 'untimestamped' | 'none', for the EMBEDDED signature only.
function Get-SignatureState([string]$path) {
  & $signtool.FullName verify /pa /tw /q $path *> $null
  switch ($LASTEXITCODE) {
    0 { return 'timestamped' }
    2 { return 'untimestamped' }
    default { return 'none' }
  }
}

# The subject of the certificate embedded in the file, or $null when there is none.
function Get-EmbeddedSubject([string]$path) {
  try {
    return [System.Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($path).Subject
  } catch {
    return $null
  }
}

# Our own signature must be timestamped: Azure's certificates last 72 hours. A
# vendor's valid but untimestamped signature is theirs to keep and is reported,
# not replaced.
function Test-Acceptable($entry) {
  if ($entry.State -eq 'timestamped') { return $true }
  if ($entry.State -eq 'untimestamped') {
    return ($entry.Subject -and $entry.Subject -notmatch [regex]::Escape($ourCn))
  }
  return $false
}

function Get-Entry($file) {
  [pscustomobject]@{
    File    = $file
    State   = Get-SignatureState $file.FullName
    Subject = Get-EmbeddedSubject $file.FullName
  }
}

# ---- Find the files ----
$files = @()
foreach ($root in $Roots) {
  if (-not (Test-Path -LiteralPath $root)) {
    Write-Host "FAIL: $root does not exist — nothing was checked there."
    exit 1
  }
  $found = @(Get-ChildItem -LiteralPath $root -Recurse -File |
    Where-Object { ($IncludeExe -or $_.Extension -ne '.exe') -and (Test-PeImage $_.FullName) })
  # Every tree handed to this script holds a Python runtime, a converter or
  # Electron itself. Zero native libraries means the search broke, not that
  # there is nothing to sign.
  if ($found.Count -eq 0) {
    Write-Host "FAIL: no native libraries found under $root"
    exit 1
  }
  Write-Host "$($found.Count) native libraries under $root"
  $files += $found
}
Write-Phase "found $($files.Count) files"

$entries = @($files | ForEach-Object { Get-Entry $_ })
Write-Phase 'read every signature'

# ---- Who signed what ----
$signed = @($entries | Where-Object { $_.State -ne 'none' })
Write-Host "Already signed: $($signed.Count) of $($entries.Count)"
$signed | Group-Object Subject | Sort-Object Count -Descending | ForEach-Object {
  Write-Host ("  {0,5}  {1}" -f $_.Count, $_.Name)
}
$vendorSigned = @($signed | Where-Object { $_.Subject -notmatch [regex]::Escape($ourCn) })
if ($vendorSigned.Count -gt 0) {
  Write-Host 'Files left under their vendor''s signature:'
  $vendorSigned | ForEach-Object { Write-Host "  $($_.File.FullName)  <-  $($_.Subject)" }
}
$untimestamped = @($signed | Where-Object { $_.State -eq 'untimestamped' })
if ($untimestamped.Count -gt 0) {
  Write-Host "WARNING: $($untimestamped.Count) signatures carry no timestamp and stop validating when the signer's certificate expires:"
  $untimestamped | ForEach-Object { Write-Host "  $($_.File.FullName)  <-  $($_.Subject)" }
}

if ($VerifyOnly) {
  $bad = @($entries | Where-Object { -not (Test-Acceptable $_) })
  if ($bad.Count -gt 0) {
    $bad | Select-Object -First 60 | ForEach-Object {
      Write-Host "  $($_.File.FullName)  (state: $($_.State), embedded signer: $($_.Subject))"
    }
    Write-Host "FAIL: $($bad.Count) of $($entries.Count) native libraries would be refused by Windows application control (listed above)."
    exit 1
  }
  Write-Phase "all $($entries.Count) native libraries carry a valid embedded signature"
  exit 0
}

# ---- Sign what has no valid signature ----
$todo = @($entries | Where-Object { $_.State -eq 'none' })
Write-Host "To sign: $($todo.Count)"
if ($todo.Count -gt 0) {
  # Two kinds of file here are not simply "unsigned", and both are a vendor's:
  # a copy of a Windows system DLL (signed through a catalog that does not
  # travel with it), and a file whose embedded signature no longer validates.
  # Said out loud, because signing them puts our name on someone else's file.
  $replaced = @($todo | Where-Object { $_.Subject })
  if ($replaced.Count -gt 0) {
    Write-Host "Of those, $($replaced.Count) carry an embedded signature that does not validate; ours replaces it:"
    $replaced | ForEach-Object { Write-Host "  $($_.File.FullName)  <-  $($_.Subject)" }
  }
  $catalogOnly = @($todo | Where-Object { -not $_.Subject } | ForEach-Object {
    $ps = Get-AuthenticodeSignature -LiteralPath $_.File.FullName
    if ($ps.SignatureType -eq 'Catalog') {
      [pscustomobject]@{ Path = $_.File.FullName; Signer = $ps.SignerCertificate.Subject }
    }
  })
  if ($catalogOnly.Count -gt 0) {
    Write-Host "Of those, $($catalogOnly.Count) are known to this machine only through a catalog (copies of another vendor's files):"
    $catalogOnly | ForEach-Object { Write-Host "  $($_.Path)  <-  $($_.Signer)" }
  }

  # Invoke-TrustedSigning resolves each catalog line against the catalog's OWN
  # directory, so the paths are written relative to the working directory and
  # the catalog is placed there.
  $catalog = Join-Path $PWD 'win-sign-catalog.txt'
  $outside = @($todo | ForEach-Object { Resolve-Path -LiteralPath $_.File.FullName -Relative } |
    Where-Object { [System.IO.Path]::IsPathRooted($_) })
  if ($outside.Count -gt 0) {
    Write-Host "FAIL: $($outside.Count) files are not under the working directory $PWD, so the signing catalog cannot name them (first: $($outside[0]))."
    exit 1
  }

  # Where the workflow's pre-install step saved the module.
  $env:PSModulePath = "$(Join-Path $env:USERPROFILE 'Documents\PowerShell\Modules');$env:PSModulePath"
  Import-Module TrustedSigning -RequiredVersion 0.4.1

  # Signing is RESUMED, not just run. signtool signs the list in order and
  # abandons the rest of it at the first file Azure fails: the first time the
  # real bundle went through, the service answered one digest (the 19th of 372)
  # with status "Failed" after 15 seconds, having signed the previous 18 in
  # about a second each, and 354 files were left untouched. Azure is handed
  # only a digest, so that verdict says nothing about the file. Each pass
  # therefore takes whatever is still unsigned and goes again. It stops when a
  # pass signs nothing twice running, which is what a real fault looks like
  # (expired secret, exhausted quota, a file signtool cannot sign), and every
  # failed pass is printed so a service that fails often does not hide here.
  $maxPasses = 8
  $remaining = $todo
  $pass = 0
  $stalled = 0
  $signError = $null
  while ($remaining.Count -gt 0 -and $pass -lt $maxPasses -and $stalled -lt 2) {
    $pass++
    $remaining | ForEach-Object { Resolve-Path -LiteralPath $_.File.FullName -Relative } |
      Set-Content -LiteralPath $catalog -Encoding utf8

    # The module throws on a signtool failure, which would skip the per-file
    # read below — the only thing that says WHICH files were left. Hold it.
    $signError = $null
    try {
      # -Timeout is per signtool batch (the module splits the list by
      # command-line length), in seconds. Its 300 s default is tight for a
      # batch holding the largest libraries in the bundle.
      Invoke-TrustedSigning `
        -Endpoint $cfg.endpoint `
        -CodeSigningAccountName $cfg.codeSigningAccountName `
        -CertificateProfileName $cfg.certificateProfileName `
        -FilesCatalog $catalog `
        -FileDigest SHA256 `
        -TimestampRfc3161 $cfg.timestampRfc3161 `
        -TimestampDigest $cfg.timestampDigest `
        -Timeout 900
    } catch {
      $signError = $_
    } finally {
      Remove-Item -LiteralPath $catalog -Force -ErrorAction SilentlyContinue
    }

    # Re-read each file rather than trusting the signer's exit code: the module
    # treats signtool's "completed with warnings" as success.
    $still = @($remaining | ForEach-Object { Get-Entry $_.File } | Where-Object { -not (Test-Acceptable $_) })
    $done = $remaining.Count - $still.Count
    Write-Phase "pass ${pass}: signed $done of $($remaining.Count), $($still.Count) left"
    if ($done -eq 0) { $stalled++ } else { $stalled = 0 }
    $remaining = $still
    if ($remaining.Count -gt 0) {
      Write-Host "::warning title=Windows signing pass $pass was cut short::$($remaining.Count) files left; first: $($remaining[0].File.FullName). $signError"
      Start-Sleep -Seconds ([Math]::Min(15 * $pass, 60))
    }
  }

  if ($remaining.Count -gt 0) {
    $remaining | Select-Object -First 60 | ForEach-Object { Write-Host "  $($_.File.FullName)  (state: $($_.State))" }
    # signtool's own words for the first few say WHY.
    $remaining | Select-Object -First 3 | ForEach-Object {
      & $signtool.FullName verify /pa /tw /v $_.File.FullName
    }
    if ($signError) { Write-Host "Invoke-TrustedSigning failed: $signError" }
    Write-Host "FAIL: $($remaining.Count) of $($todo.Count) files still have no valid embedded signature after $pass passes (listed above)."
    exit 1
  }
  Write-Phase "signed $($todo.Count) files in $pass pass(es)"
}

Write-Host "All $($entries.Count) native libraries carry a valid embedded signature."
# A caller's shell reports the last native command's exit code; make it ours.
exit 0
