#!/usr/bin/env bash
# Linked mailboxes against a real provider: RealProviderIT, for the Courier launch plan's real-provider runs (§7).
#
# STAGING TEST ACCOUNTS ONLY. Never the owner's mail or any member's. The app passwords are asked for at hidden prompts
# here and handed to the test run through its environment only: never an argument, a file, a log or git.
#
# Usage, from services/:
#   deskd/scripts/courier-real-provider.sh <provider> <address> <peer-provider> <peer-address>
#     provider, peer-provider: gmail | icloud | fastmail | yahoo | outlook (outlook checks the refusal only until Wave 2.2)
#     address: the staging test account linked (A); peer-address: a second staging test account (B) on any provider, which
#     sends A mail and receives A's.
#
# What each account needs before a run:
#   - IMAP on (Gmail: on by default since 2025; Yahoo, iCloud and Fastmail: on), and an app password for each (Gmail and
#     Yahoo need 2-Step Verification first; iCloud: an app-specific password; Fastmail: an app password with IMAP and SMTP).
#   - Its usual folders: Inbox, Sent, Junk or Spam, Trash.
#   - For a first-sync run of size, a few hundred messages already in A (send them from B beforehand).
# It prints COURIER-RP {json} and writes target/courier-rp-<provider>.json: timings, the provider's capabilities and folders,
# and the authserv-ids on A's received mail (Providers' table needs iCloud's, Yahoo's and Fastmail's). It deletes what it sent.
set -euo pipefail
if [ $# -ne 4 ]; then
  sed -n '2,20p' "$0"
  exit 2
fi
provider=$1 address=$2 peer_provider=$3 peer=$4
echo "Linking $address ($provider) with $peer ($peer_provider) as its peer."
echo "These must be STAGING TEST ACCOUNTS. Type the words 'staging test accounts only' to go on:"
read -r confirm
[ "$confirm" = "staging test accounts only" ] || { echo "Stopped."; exit 1; }
read -r -s -p "App password for $address: " secret; echo
read -r -s -p "App password for $peer: " peer_secret; echo
export JAVA_HOME=${JAVA_HOME:-$HOME/.local/share/ma-desk-toolchain/jdk-21}
COURIER_RP_TEST_ACCOUNTS=staging-test-accounts-only \
COURIER_RP_PROVIDER="$provider" COURIER_RP_ADDRESS="$address" COURIER_RP_SECRET="$secret" \
COURIER_RP_PEER_PROVIDER="$peer_provider" COURIER_RP_PEER_ADDRESS="$peer" COURIER_RP_PEER_SECRET="$peer_secret" \
  ./mvnw -q -pl deskd -am verify -Dtest=none -Dsurefire.failIfNoSpecifiedTests=false -Dit.test=RealProviderIT
unset secret peer_secret
