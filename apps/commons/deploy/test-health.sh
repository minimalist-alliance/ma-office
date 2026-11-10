#!/bin/sh
# Tests deploy/health without a desk: a member's desk (no guild flag) is healthy with nothing running, and a Guild
# Desk is unhealthy until commons-server answers. Run: apps/commons/deploy/test-health.sh (needs python3).
set -u
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'kill "$srv" 2>/dev/null; rm -rf "$tmp"' EXIT
srv=
fails=0
check() { # check <name> <want exit> <env...>
  name=$1; want=$2; shift 2
  env "$@" "$here/health" >/dev/null 2>&1; got=$?
  if [ "$got" = "$want" ]; then echo "ok   $name"; else echo "FAIL $name: exit $got, want $want"; fails=$((fails + 1)); fi
}
port=$(python3 -I -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
common="COMMONS_HTTP=127.0.0.1:$port COMMONS_RELAY_SOCKET=$tmp/commons.sock"

check "member's desk, nothing running: healthy" 0 $common COMMONS_GUILD_FLAG="$tmp/guild"
touch "$tmp/guild"
check "Guild Desk, nothing running: unhealthy" 1 $common COMMONS_GUILD_FLAG="$tmp/guild"

python3 -I -c '
import http.server, socket, sys
port, sock = int(sys.argv[1]), sys.argv[2]
u = socket.socket(socket.AF_UNIX); u.bind(sock)
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b"ok\n")
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
' "$port" "$tmp/commons.sock" &
srv=$!
i=0; while [ ! -S "$tmp/commons.sock" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
sleep 0.3
check "Guild Desk, serving with its socket: healthy" 0 $common COMMONS_GUILD_FLAG="$tmp/guild"
rm "$tmp/commons.sock"
check "Guild Desk, no relay socket: unhealthy" 1 $common COMMONS_GUILD_FLAG="$tmp/guild"
rm "$tmp/guild"
check "member's desk again: healthy" 0 $common COMMONS_GUILD_FLAG="$tmp/guild"

[ "$fails" = 0 ] && echo "5 of 5 passed" || { echo "$fails failed"; exit 1; }
