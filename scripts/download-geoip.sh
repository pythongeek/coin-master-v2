#!/usr/bin/env bash
#
# scripts/download-geoip.sh — Download the MaxMind GeoLite2-Country.mmdb
#
# Usage:
#   MAXMIND_LICENSE_KEY=your_key_here ./scripts/download-geoip.sh
#
# Or set MAXMIND_LICENSE_KEY in your shell environment.
#
# The MaxMind GeoLite2 database is free to use under their license; signup
# is at https://www.maxmind.com/en/geolite2/signup and produces a license
# key. The script stores the file as ./geoip/GeoLite2-Country.mmdb which
# is bind-mounted into the backend container by docker-compose.yml.
#
# After this script completes, the backend will pick up the .mmdb on next
# lookup. If you want immediate effect, invalidate the in-process reader
# via the admin endpoint:
#
#   curl -X PUT http://<host>/api/admin/geoip/provider \
#     -H 'Content-Type: application/json' \
#     -H 'Authorization: Bearer *** {"provider":"geoip_lite"}'
#   curl -X PUT http://<host>/api/admin/geoip/provider \
#     -H 'Content-Type: application/json' \
#     -H 'Authorization: Bearer *** {"provider":"maxmind"}'
#
# The flip through `geoip_lite` invalidates the reader memo so the next
# `maxmind` switch reopens the freshly-downloaded file.

set -euo pipefail

if [ -z "${MAXMIND_LICENSE_KEY:-}" ]; then
  echo 'ERROR: MAXMIND_LICENSE_KEY env var is required.' >&2
  echo 'Sign up at https://www.maxmind.com/en/geolite2/signup and re-run.' >&2
  exit 1
fi

# Pick a writable target. The script lives in coin-master/scripts/
# so the geoip/ directory is a sibling of the script's parent.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET_DIR="$ROOT/geoip"
mkdir -p "$TARGET_DIR"

# MaxMind now requires edgestore / download URLs that depend on the
# edition id. As of 2026-Q1, the recommended endpoint for the GeoLite2
# free database is:
#   https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-Country&suffix=tar.gz&license_key=KEY
URL="https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-Country&suffix=tar.gz&license_key=${MAXMIND_LICENSE_KEY}"
TMP_TGZ="$(mktemp -t GeoLite2-Country.XXXXXX.tar.gz)"
trap 'rm -f "$TMP_TGZ"' EXIT

echo "Downloading GeoLite2-Country from $URL …"
curl --fail --silent --show-error -o "$TMP_TGZ" "$URL"

echo "Extracting .mmdb …"
TMP_DIR="$(mktemp -d -t geoip-extract.XXXXXX)"
tar -xzf "$TMP_TGZ" -C "$TMP_DIR"

# The archive contains a single .mmdb file. Find it.
MMDB_PATH="$(find "$TMP_DIR" -name 'GeoLite2-Country.mmdb' -print -quit)"
if [ -z "$MMDB_PATH" ]; then
  echo "ERROR: GeoLite2-Country.mmdb not found in archive." >&2
  rm -rf "$TMP_DIR"
  exit 2
fi

mv -f "$MMDB_PATH" "$TARGET_DIR/GeoLite2-Country.mmdb"
chmod 0644 "$TARGET_DIR/GeoLite2-Country.mmdb"
rm -rf "$TMP_DIR"

# Report what landed
SIZE=$(stat -c%s "$TARGET_DIR/GeoLite2-Country.mmdb" 2>/dev/null || stat -f%z "$TARGET_DIR/GeoLite2-Country.mmdb")
echo "OK: GeoLite2-Country.mmdb written ($SIZE bytes)"
echo "    path: $TARGET_DIR/GeoLite2-Country.mmdb"
echo
echo "Next steps:"
echo "  1. Restart the backend so docker-compose picks up the new file:"
echo "       docker compose -f $ROOT/docker-compose.yml restart backend"
echo "  2. Or invalidate the in-process reader via the admin API to avoid restart:"
echo "       curl -X PUT http://<host>/api/admin/geoip/provider -H \\"
echo "         'Content-Type: application/json' \\"
echo "         -d '{\"provider\":\"geoip_lite\"}'"
echo "       curl -X PUT http://<host>/api/admin/geoip/provider -H \\"
echo "         'Content-Type: application/json' \\"
echo "         -d '{\"provider\":\"maxmind\"}'"