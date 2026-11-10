#!/usr/bin/env bash
# Builds Commons and runs it locally: the stand-in guild server on 127.0.0.1:8790 (voice on UDP
# 8791), serving the page. Open http://127.0.0.1:8790/?name=Ana in up to three browsers or tabs.
# Needs Go (~/.local/go) and Node 24 (~/.local/node-v24). Boards are kept in server/data/.
# --build-only stops after building (on the shared machine, build under its lock:
# flock ~/work/.build.lock nice -n 10 apps/commons/run.sh --build-only).
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/go/bin:$HOME/.local/node-v24/bin:$PATH"
ADDR="${COMMONS_ADDR:-127.0.0.1:8790}"
UDP="${COMMONS_UDP:-127.0.0.1:8791}"
(cd server && CGO_ENABLED=0 go build -trimpath -o bin/commons-server ./cmd/commons-server)
(cd web && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && npx vite build --logLevel warn)
[ "${1:-}" = --build-only ] && exit 0
exec server/bin/commons-server -dev -addr "$ADDR" -udp "$UDP" -web web/dist -data server/data "$@"
