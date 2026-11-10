#!/bin/sh
# Runs RealDeskRtcIT: deskd's data plane against the real desk-rtc, gateway-shim and deskctl, with a
# real Pion client on loopback. The binaries go under deskd/target, so desk-rtc/ stays untouched.
# The clipboard's tests through real X also need DESK_RTC_DISPLAY, a display they may use (never :0 or
# :10), and xclip on the PATH. Without it they're skipped, but for the one with no display.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
go=${GO:-$HOME/.local/go/bin/go}
dist=$here/deskd/target/desk-rtc-dist
mkdir -p "$dist"

cd "$here/../desk-rtc"
CGO_ENABLED=0 "$go" build -p 1 -o "$dist/" ./cmd/desk-rtc ./cmd/gateway-shim ./cmd/deskctl

export JAVA_HOME=${JAVA_HOME:-$HOME/.local/share/ma-desk-toolchain/jdk-21}
cd "$here"
DESK_RTC_DIST=$dist exec ./mvnw -q -pl deskd verify -Dtest=none -Dsurefire.failIfNoSpecifiedTests=false -Dit.test=RealDeskRtcIT,RealGuildRtcIT
