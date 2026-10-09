#!/bin/sh
set -eu

binary=${1:?Cargo did not provide a development executable}
shift

# Prefer a development identity: it is stable on this Mac and deliberately
# separate from the Developer ID identity used for distributable builds.
# Sign by certificate SHA-1 hash, never by name: two certificates can share one
# common name across renewals, and codesign --sign <name> fails "ambiguous" then.
identity=$(
  /usr/bin/security find-identity -v -p codesigning 2>/dev/null |
    /usr/bin/grep 'Apple Development:' |
    /usr/bin/sed -n 's/.*\([0-9A-F]\{40\}\).*/\1/p' |
    /usr/bin/head -n 1
)

if [ -n "$identity" ]; then
  /usr/bin/codesign \
    --force \
    --sign "$identity" \
    --identifier com.anydaysomething.sndmail \
    --timestamp=none \
    "$binary"
else
  echo "warning: no Apple Development identity found; sndmail will use an ad-hoc signature" >&2
  echo "warning: Little Snitch may ask you to accept the modified app after rebuilds" >&2
fi

exec "$binary" "$@"
