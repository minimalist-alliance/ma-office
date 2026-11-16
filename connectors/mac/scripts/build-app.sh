#!/bin/sh
# Builds "MA Connector.app" with SwiftPM only (no Xcode): both architectures, one universal binary, the bundle assembled by
# hand, signed ad-hoc with the hardened runtime, and zipped. Run on a Mac with the Command Line Tools (Swift 6.1 or later).
#
#   scripts/build-app.sh [--relay https://api.staging.minimalistalliance.com] [--version 1.0.0] [--build 1]
#                        [--update-url https://.../appcast.json --update-key <base64url public key>] [--team <TEAMID>]
#
# Out: dist/MA Connector.app and dist/MA-Connector-<version>.zip. Developer ID signing and notarization are
# scripts/sign-notarize.sh, run on this output once MA's Apple Developer account exists.
set -eu
cd "$(dirname "$0")/.."
RELAY="https://api.staging.minimalistalliance.com"
VERSION="1.0.0"
BUILD="1"
UPDATE_URL=""
UPDATE_KEY=""
TEAM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --relay) RELAY="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --build) BUILD="$2"; shift 2 ;;
    --update-url) UPDATE_URL="$2"; shift 2 ;;
    --update-key) UPDATE_KEY="$2"; shift 2 ;;
    --team) TEAM="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
case "$RELAY" in https://*) ;; *) echo "the relay must be https" >&2; exit 2 ;; esac

APP="dist/MA Connector.app"
rm -rf dist && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# Source paths never go into the binary: the build folder is mapped to a neutral name.
HERE="$(pwd)"
for ARCH in arm64 x86_64; do
  swift build -c release --product MAConnector --triple "$ARCH-apple-macosx14.0" \
    -Xswiftc -file-prefix-map -Xswiftc "$HERE=/ma-connector" \
    -Xswiftc -debug-prefix-map -Xswiftc "$HERE=/ma-connector" \
    -Xcc -ffile-prefix-map="$HERE=/ma-connector"
done
lipo -create -output "$APP/Contents/MacOS/MAConnector" \
  ".build/arm64-apple-macosx/release/MAConnector" ".build/x86_64-apple-macosx/release/MAConnector"
strip -x "$APP/Contents/MacOS/MAConnector"

# The icon (the brand kit's app icon, as it is) and the marks.
ICONSET="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$ICONSET"
for S in 16 32 128 256 512; do
  sips -z $S $S Resources/brand/app-icon-1024.png --out "$ICONSET/icon_${S}x${S}.png" >/dev/null
  D=$((S * 2))
  sips -z $D $D Resources/brand/app-icon-1024.png --out "$ICONSET/icon_${S}x${S}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
sips -Z 26 Resources/brand/mark-mono-black-256.png --out "$APP/Contents/Resources/MenuIcon.png" >/dev/null
sips -Z 52 Resources/brand/mark-mono-black-256.png --out "$APP/Contents/Resources/MenuIcon@2x.png" >/dev/null
cp Resources/brand/mark-primary.png Resources/brand/mark-on-dark.png "$APP/Contents/Resources/"
# One multi-resolution menu icon (macOS picks the @2x on a Retina screen).
tiffutil -cathidpicheck "$APP/Contents/Resources/MenuIcon.png" "$APP/Contents/Resources/MenuIcon@2x.png" \
  -out "$APP/Contents/Resources/MenuIcon.tiff" >/dev/null 2>&1 && rm "$APP/Contents/Resources/MenuIcon.png" "$APP/Contents/Resources/MenuIcon@2x.png"

plist() { /usr/libexec/PlistBuddy -c "$1" "$APP/Contents/Info.plist" >/dev/null; }
plist "Add :CFBundleIdentifier string com.minimalistalliance.connector"
plist "Add :CFBundleName string MA Connector"
plist "Add :CFBundleDisplayName string MA Connector"
plist "Add :CFBundleExecutable string MAConnector"
plist "Add :CFBundlePackageType string APPL"
plist "Add :CFBundleShortVersionString string $VERSION"
plist "Add :CFBundleVersion string $BUILD"
plist "Add :CFBundleIconFile string AppIcon"
plist "Add :CFBundleInfoDictionaryVersion string 6.0"
plist "Add :LSMinimumSystemVersion string 14.0"
plist "Add :LSUIElement bool true"
plist "Add :LSApplicationCategoryType string public.app-category.productivity"
plist "Add :NSHumanReadableCopyright string Minimalist Alliance"
plist "Add :NSAppleEventsUsageDescription string MA Connector asks Messages to send what you write in Courier."
plist "Add :MARelayURL string $RELAY"
[ -n "$UPDATE_URL" ] && plist "Add :MAUpdateURL string $UPDATE_URL"
[ -n "$UPDATE_KEY" ] && plist "Add :MAUpdatePublicKey string $UPDATE_KEY"
[ -n "$TEAM" ] && plist "Add :MATeamID string $TEAM"
printf 'APPL????' > "$APP/Contents/PkgInfo"

# No build machine's paths and no name of the person building it, in anything that ships.
WHO="$(id -un)"
leaks() {
  grep -R -a -l -F -e "/Users/" "$APP" 2>/dev/null
  # A short account name would match ordinary bytes; long ones are a person's.
  if [ "${#WHO}" -ge 6 ]; then grep -R -a -l -i -F -e "$WHO" "$APP" 2>/dev/null; fi
  return 0
}
if [ -n "$(leaks)" ]; then
  echo "the bundle holds a local path or the builder's name: stopping" >&2
  leaks | sort -u | head >&2
  exit 1
fi

# Ad-hoc, with the hardened runtime: the Developer ID signature replaces this (scripts/sign-notarize.sh).
codesign --force --options runtime --entitlements Resources/MAConnector.entitlements --timestamp=none --sign - "$APP"
codesign --verify --strict --verbose=1 "$APP"
lipo -archs "$APP/Contents/MacOS/MAConnector"

ditto -c -k --sequesterRsrc --keepParent "$APP" "dist/MA-Connector-$VERSION.zip"
shasum -a 256 "dist/MA-Connector-$VERSION.zip"
