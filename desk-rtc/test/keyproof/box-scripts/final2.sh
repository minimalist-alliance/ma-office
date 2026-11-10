#!/bin/bash
set -u
SP=${KEYPROOF_DIR:-${TMPDIR:-/tmp}/keyproof}; B=$SP/box.sh; WT=$SP/fix-wt; OUT=$WT/desk-rtc/test/keyproof/results
SHA=$(cut -d' ' -f1 $WT/desk-rtc/dist/desk-rtc-0.2.1.tgz.sha256); echo artifact $SHA
$B put $WT/desk-rtc/dist/desk-rtc-0.2.1.tgz /tmp/desk-rtc-0.2.1.tgz; $B put $SP/bin0/desk-rtc /tmp/rtc020
cat > $SP/rem-i2.sh <<R
sudo rm -rf /etc/systemd/system/desk-xorg.service.d; sudo systemctl daemon-reload
sudo install -m 755 /tmp/rtc020 /var/tmp/rtc020; sudo cp /tmp/desk-rtc-0.2.1.tgz /var/tmp/desk-rtc-0.2.1-final.tgz
cd /tmp; sudo rm -rf /opt/ma/desk-rtc/releases/0.2.1; sudo /opt/ma/bin/ma-update desk-rtc file:///var/tmp/desk-rtc-0.2.1-final.tgz $SHA 2>&1 | tail -1; cat /opt/ma/desk-rtc/current/VERSION; sudo sha256sum /opt/ma/desk-rtc/current/desk-rtc | cut -c1-16
tar -xzOf /var/tmp/desk-rtc-0.2.1-final.tgz ./desk-rtc 2>/dev/null | sha256sum | cut -c1-16; tar -xzOf /var/tmp/desk-rtc-0.2.1-final.tgz desk-rtc 2>/dev/null | sha256sum | cut -c1-16
R
$B ssh bash -s < $SP/rem-i2.sh
run() { local l=$1; shift; echo "=== $l"; $B ssh "cd /tmp; sudo timeout 400 /var/tmp/keyproof run $* --out /var/tmp/$l.json 2>&1 | grep -av XGB | cut -c1-400; sudo chmod 644 /var/tmp/$l.json"; $B get /var/tmp/$l.json $OUT/0.2.2-$l.json; }
reboot_box() { $B ssh 'sudo reboot' >/dev/null 2>&1; sleep 25; for _ in $(seq 1 60); do $B ssh true 2>/dev/null && break; sleep 5; done; }
reboot_box; echo "=== fresh boot, full"; $B ssh bash -s < $SP/rem-up.sh; run first-boot --phases viewport,named,ascii,letters,pace,burst,hold,wheel --order asis
for o in reverse seed1 seed2; do reboot_box; echo "=== fresh boot, order $o"; $B ssh bash -s < $SP/rem-up.sh; run boot-$o --phases viewport,letters --order $o; done
echo "=== after a Chromium kill -9"; $B ssh 'sudo systemctl kill -s KILL --kill-whom=main desk-browser; sleep 12; for i in $(seq 1 30); do sudo curl -s -m 2 http://127.0.0.1:9222/json/version >/dev/null && break; sleep 1; done; sleep 3'
run after-kill --phases viewport,letters --order seed3
echo "=== after a desk-rtc restart, same X"; $B ssh 'sudo systemctl restart desk-rtc devfake; sleep 4'
run after-rtc-restart --phases letters --order seed4
$B ssh 'sudo journalctl -u desk-rtc -n 50 --no-pager -o cat | grep -E "keymap loaded|no spare" | tail -2 | cut -c1-160'
echo "=== under load: 8 busy loops on 2 cores"; $B ssh 'for i in 1 2 3 4 5 6 7 8; do sudo systemd-run --unit=spin$i sh -c "while :; do :; done" >/dev/null 2>&1; done'
run under-load --phases letters,burst --order seed5
$B ssh 'for i in 1 2 3 4 5 6 7 8; do sudo systemctl stop spin$i; done'
echo "=== mixed: desk-rtc from the 0.2.0 code on this image, fresh X"
cat > $SP/rem-mix3.sh <<'R'
cd /tmp; sudo systemctl stop desk-browser desk-xorg; w=/var/tmp/rel-old2; sudo rm -rf $w; sudo mkdir -p $w; sudo cp -a /opt/ma/desk-rtc/current/. $w/; sudo install -m 755 /var/tmp/rtc020 $w/desk-rtc; echo 0.2.0-code2 | sudo tee $w/VERSION >/dev/null; sudo tar -C $w -czf /var/tmp/rel-old2.tgz .
sudo /opt/ma/bin/ma-update desk-rtc file:///var/tmp/rel-old2.tgz $(sudo sha256sum /var/tmp/rel-old2.tgz | cut -d' ' -f1) 2>&1 | tail -1; cat /opt/ma/desk-rtc/current/VERSION
R
$B ssh bash -s < $SP/rem-mix3.sh; $B ssh bash -s < $SP/rem-up.sh; run mixed-rtc-0.2.0 --phases viewport,letters --order asis
echo FINAL2-DONE
