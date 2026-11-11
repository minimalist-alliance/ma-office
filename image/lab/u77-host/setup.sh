#!/bin/bash
# setup.sh: the u77-host lab box as a TEST host, as root, after host-overlay.sh's files (LAB ONLY; a member's host has none of it):
# test.conf and the test tools (the CDP forward, WR2-01's test hosts only), the dev key's public half as a test-only template key,
# a fake Platform on the loopback with the link pointed at it, the artifact server and the session pages as lab units that
# survive a reboot.
set -euo pipefail
LAB=/var/tmp/lab; L=/usr/local/lib/desk-host; TT=/var/lib/desk-host/test
echo "# a TEST host (image/lab/u77-host). A member's host never has this file." > /etc/desk-host/test.conf
install -d -m 755 $TT $TT/template-keys
install -m 644 $LAB/cdp_forward.py $TT/
: > $TT/test-cdp.on
install -m 644 $LAB/dev.pem $TT/template-keys/dev.pem
sed -i '/^# --- u77 lab/,$d' /etc/desk-host/desk-host.conf
cat >> /etc/desk-host/desk-host.conf <<C
# --- u77 lab (image/lab/u77-host/setup.sh); none of this is on a member's host
LINK_API=http://127.0.0.1:18443
DESKD_ENV=DESKD_API_URL=https://api.verify.invalid;DESKD_JWKS_URL=https://api.verify.invalid/v1/jwks
HOST_PORTS=18766
C
install -d -m 700 /root/fake; install -m 644 $LAB/fake_platform.py $LAB/fake.py /root/fake/
install -d -m 755 /srv/desk-host/lab-art
tok=$(curl -fsS -m 3 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)
md() { curl -fsS -m 3 -H "X-aws-ec2-metadata-token: $tok" "http://169.254.169.254/latest/meta-data/$1"; }
[ -f /root/fake/state.json ] || python3 -I /root/fake/fake.py init "$(md instance-id)" "$(md public-ipv4)" "$(md tags/instance/DeskSlot1)" "$(md tags/instance/DeskSlot2)"
unit() { printf '[Unit]\nDescription=TEST ONLY: %s (u77-host lab)\nBefore=desk-host-link.service\n[Service]\nEnvironment=DESK_HOST_LIB=/usr/local/lib/desk-host\nExecStart=%s\nRestart=always\n[Install]\nWantedBy=multi-user.target\n' "$2" "$3" > /etc/systemd/system/$1.service; }
unit lab-fake-platform "a fake Platform" "/usr/bin/python3 -I /root/fake/fake_platform.py --port 18443 --state /root/fake/state.json --log /root/fake/requests.jsonl"
unit lab-art "the test artifacts on the loopback" "/usr/bin/python3 -m http.server 18080 --bind 127.0.0.1 --directory /srv/desk-host/lab-art"
unit lab-pages "the session pages on the slots' host side" "/usr/bin/python3 -I $LAB/sess_slot.py serve"
systemctl daemon-reload
systemctl enable --now lab-fake-platform lab-art lab-pages
systemctl restart desk-host-link
for i in $(seq 1 30); do grep -q '"route": "/v1/host/report", "status": 200' /root/fake/requests.jsonl 2>/dev/null && break; sleep 2; done
journalctl -u desk-host-link --no-pager -o cat | tail -3
