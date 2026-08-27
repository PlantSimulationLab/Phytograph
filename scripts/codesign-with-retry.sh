#!/usr/bin/env bash
# Sign a Mach-O binary with the hardened runtime, retrying ONLY when Apple's
# timestamp service is the thing that failed.
#
# Why this exists: `codesign --timestamp` contacts Apple to countersign, and
# that service goes down. It took out the macOS Intel build of v0.74.0 after a
# 21-minute compile, at the last step before packaging:
#
#     resources/phytograph_backend/phytograph_backend: replacing existing signature
#     resources/phytograph_backend/phytograph_backend: The timestamp service is not available.
#
# Nothing about the binary or the certificate was wrong; Apple was briefly
# unreachable. This is the same class of failure that 2e4d09c added retries for
# on the notarization side, and the same distinction applies here:
#
#   - a TRANSPORT failure (timestamp service unreachable/timed out) says nothing
#     about the artifact and is worth another attempt;
#   - a VERDICT (no identity found, bad entitlements, unreadable binary) is
#     codesign telling us the inputs are wrong. Retrying that burns minutes and
#     disguises a real error as flakiness.
#
# So the grep below is deliberately narrow. Erring toward NOT retrying is the
# safe default: a spurious hard failure costs one re-run, while a retried
# verdict costs the same failure three times over with the cause buried.
#
# Backoff is generous for the reason notarize.cjs gives — retrying two seconds
# into an Apple outage just spends an attempt on the same bad weather.
#
# Usage: codesign-with-retry.sh <entitlements> <identity> <binary>

set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <entitlements> <identity> <binary>" >&2
  exit 2
fi

entitlements="$1"
identity="$2"
binary="$3"

if [ ! -f "$binary" ]; then
  echo "::error::codesign-with-retry: no such binary: $binary" >&2
  exit 1
fi

MAX_ATTEMPTS=3
BACKOFF=(30 90)

# Symptoms of the timestamp service being unreachable, rather than a verdict on
# the artifact. Matched case-insensitively against codesign's stderr.
TRANSPORT_RE='timestamp service is not available|timestamp service|The network connection was lost|The request timed out|Connection reset|could not be reached|temporarily unavailable'

attempt=1
while :; do
  set +e
  out=$(codesign --force --options runtime --timestamp \
          --entitlements "$entitlements" \
          --sign "$identity" \
          "$binary" 2>&1)
  rc=$?
  set -e

  [ -n "$out" ] && echo "$out"

  if [ "$rc" -eq 0 ]; then
    break
  fi

  if ! echo "$out" | grep -qiE "$TRANSPORT_RE"; then
    echo "::error::codesign failed for $binary and the error is not a timestamp-service outage — not retrying." >&2
    exit "$rc"
  fi

  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    echo "::error::codesign failed for $binary after $MAX_ATTEMPTS attempts; Apple's timestamp service stayed unavailable." >&2
    exit "$rc"
  fi

  delay="${BACKOFF[$((attempt - 1))]}"
  echo "codesign: Apple timestamp service unavailable (attempt $attempt/$MAX_ATTEMPTS); retrying in ${delay}s..." >&2
  sleep "$delay"
  attempt=$((attempt + 1))
done

# Verify what actually landed. A signature that exists but carries no timestamp
# would sail through here and be rejected at notarization instead, minutes
# later and with a worse error, so assert the timestamp is present.
codesign -dv --verbose=4 "$binary"

if codesign -dvv "$binary" 2>&1 | grep -qi "Timestamp="; then
  echo "codesign: verified signature with a trusted timestamp on $binary"
else
  echo "::error::$binary was signed but carries no timestamp — notarization would reject it." >&2
  exit 1
fi
