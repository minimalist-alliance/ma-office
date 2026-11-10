#!/bin/bash
# stack.sh <dir with desk-rtc gateway-shim fake-deskd>: install desk-rtc as a release through ma-update and start the dev pieces.
set -u
D=$1; V=${2:-test}
w=/var/tmp/rel-$V; sudo rm -rf $w; sudo mkdir -p $w; sudo install -m 755 $D/desk-rtc $w/desk-rtc
sudo tee $w/run >/dev/null <<'R'
#!/bin/sh
set -eu
: "${RELEASE_DIR:?RELEASE_DIR is not set}"
exec "$RELEASE_DIR/desk-rtc" --socket /run/desk/rtc.sock --socket-group desk --data-dir /data/rtc --bind auto --port 443 --stream-socket /run/desk-media/stream.sock --stream-user stream --display :99
R
sudo tee $w/health >/dev/null <<'R'
#!/bin/sh
systemctl is-active --quiet desk-rtc
R
sudo chmod 755 $w/run $w/health; echo $V | sudo tee $w/VERSION >/dev/null
sudo tar -C $w -czf /var/tmp/rtc-$V.tgz .
sudo /opt/ma/bin/ma-update desk-rtc file:///var/tmp/rtc-$V.tgz $(sudo sha256sum /var/tmp/rtc-$V.tgz | cut -d' ' -f1) 2>&1 | tail -1; echo ma-update=$?
sudo systemctl stop devshim devfake 2>/dev/null; sudo systemctl reset-failed devshim devfake 2>/dev/null
IP=$(ip -4 -o route get 1.1.1.1 | sed -n 's/.* src \([^ ]*\).*/\1/p')
sudo systemd-run --unit=devshim $D/gateway-shim --addr 127.0.0.1:8787 >/dev/null 2>&1; sleep 1
sudo systemd-run --unit=devfake $D/fake-deskd --rtc-sock /run/desk/rtc.sock --api http://127.0.0.1:8787 --public-ip $IP >/dev/null 2>&1; sleep 2
systemctl is-active desk-rtc devshim devfake; curl -s http://127.0.0.1:8787/dev/state | cut -c1-200; echo
