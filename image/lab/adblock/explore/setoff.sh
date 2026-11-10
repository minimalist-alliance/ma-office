# setoff.sh <host>... : write the test policy with noFiltering = the hosts (lab only; the real helper builds this file)
hosts=$(printf '"%s",' "$@"); hosts="[${hosts%,}]"; [ $# = 0 ] && hosts='[]'
cat > /etc/chromium/policies/managed/.ma-adblock.json.tmp <<J
{
  "ExtensionInstallForcelist": ["ddkjiahejlhfcafbddmgiahcphecmpfh;https://clients2.google.com/service/update2/crx"],
  "3rdparty": {"extensions": {"ddkjiahejlhfcafbddmgiahcphecmpfh": {"disableFirstRunPage": true, "noFiltering": $hosts}}}
}
J
chmod 644 /etc/chromium/policies/managed/.ma-adblock.json.tmp; mv /etc/chromium/policies/managed/.ma-adblock.json.tmp /etc/chromium/policies/managed/ma-adblock.json
