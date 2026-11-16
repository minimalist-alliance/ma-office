#!/bin/sh
# Developer ID signing and notarization for MA Connector, for when Minimalist Alliance's own Apple Developer account exists.
# Never a person's Apple ID or signing identity: the identity must be MA's ("Developer ID Application: Minimalist Alliance
# (<TEAMID>)"), and the notarization credentials MA's App Store Connect API key, stored once as a keychain profile.
#
# Once, on the build Mac (README "Signing"):
#   security create-keychain -p "<a long random password>" ~/ma-build/ma-signing.keychain-db
#   security import developer-id-application.p12 -k ~/ma-build/ma-signing.keychain-db -T /usr/bin/codesign
#   xcrun notarytool store-credentials ma-notary --key AuthKey_<KEYID>.p8 --key-id <KEYID> --issuer <ISSUER-UUID> \
#     --keychain ~/ma-build/ma-signing.keychain-db
#
# Each release (on the build Mac, in this package):
#   scripts/sign-notarize.sh --team <TEAMID> --version 1.0.0 --build 1 \
#     --relay https://api.minimalistalliance.com \
#     [--update-url https://<downloads host>/connector/mac/appcast.json --update-key <base64url public key>] \
#     [--keychain ~/ma-build/ma-signing.keychain-db] [--profile ma-notary]
#
# Out: dist/MA Connector.app (signed, notarized, stapled) and dist/MA-Connector-<version>.zip, ready to publish with its
# signed update feed (connector-tool sign-update).
set -eu
cd "$(dirname "$0")/.."
TEAM=""
VERSION=""
BUILD=""
RELAY=""
UPDATE_URL=""
UPDATE_KEY=""
KEYCHAIN="$HOME/ma-build/ma-signing.keychain-db"
PROFILE="ma-notary"
while [ $# -gt 0 ]; do
  case "$1" in
    --team) TEAM="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --build) BUILD="$2"; shift 2 ;;
    --relay) RELAY="$2"; shift 2 ;;
    --update-url) UPDATE_URL="$2"; shift 2 ;;
    --update-key) UPDATE_KEY="$2"; shift 2 ;;
    --keychain) KEYCHAIN="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ -n "$TEAM" ] && [ -n "$VERSION" ] && [ -n "$BUILD" ] && [ -n "$RELAY" ] || { echo "--team, --version, --build and --relay are needed" >&2; exit 2; }
echo "$TEAM" | grep -Eq '^[A-Z0-9]{10}$' || { echo "a team id is 10 letters and digits" >&2; exit 2; }
[ -f "$KEYCHAIN" ] || { echo "no signing keychain at $KEYCHAIN (README: Signing)" >&2; exit 2; }

# MA's identity only, never a person's: it names Minimalist Alliance and this team.
IDENTITY="$(security find-identity -v -p codesigning "$KEYCHAIN" | sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -1)"
case "$IDENTITY" in
  "Developer ID Application: Minimalist Alliance ($TEAM)") ;;
  *) echo "the keychain's identity isn't MA's Developer ID for $TEAM: '$IDENTITY'" >&2; exit 1 ;;
esac

ARGS="--relay $RELAY --version $VERSION --build $BUILD --team $TEAM"
[ -n "$UPDATE_URL" ] && ARGS="$ARGS --update-url $UPDATE_URL"
[ -n "$UPDATE_KEY" ] && ARGS="$ARGS --update-key $UPDATE_KEY"
# shellcheck disable=SC2086
scripts/build-app.sh $ARGS

APP="dist/MA Connector.app"
security unlock-keychain "$KEYCHAIN"
codesign --force --options runtime --timestamp --entitlements Resources/MAConnector.entitlements \
  --keychain "$KEYCHAIN" --sign "$IDENTITY" "$APP"
codesign --verify --strict --deep --verbose=2 "$APP"
codesign -dv "$APP" 2>&1 | grep -q "TeamIdentifier=$TEAM" || { echo "signed for another team" >&2; exit 1; }

# Notarize the signed app (zipped for the upload), then staple the ticket so it opens offline too.
SUBMIT="dist/notarize-$VERSION.zip"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$SUBMIT"
xcrun notarytool submit "$SUBMIT" --keychain-profile "$PROFILE" --keychain "$KEYCHAIN" --wait --timeout 30m | tee dist/notarize.log
grep -q "status: Accepted" dist/notarize.log || { echo "notarization wasn't accepted: see notarytool log" >&2; exit 1; }
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose=2 "$APP"
rm -f "$SUBMIT"

ZIP="dist/MA-Connector-$VERSION.zip"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
shasum -a 256 "$ZIP"
echo "Signed, notarized and stapled: $ZIP. Next: connector-tool sign-update <update key> $ZIP $VERSION $BUILD <download url> > appcast.json"
