#!/bin/sh
# Runs a command in this package on the build Mac, after copying the package there (only ~/ma-build on that Mac).
#   MAC_HOST=user@mac scripts/mac.sh 'swift test'
# Nothing here touches anything outside ~/ma-build on that Mac.
set -eu
HOST="${MAC_HOST:?set MAC_HOST to the build Mac (user@host)}"
DIR="${MAC_DIR:-ma-build/mac-connector}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ssh -o BatchMode=yes "$HOST" "mkdir -p ~/$DIR"
rsync -a --delete --exclude .build --exclude dist "$HERE/" "$HOST:$DIR/"
ssh -o BatchMode=yes "$HOST" "cd ~/$DIR && $1"
