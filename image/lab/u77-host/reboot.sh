#!/bin/bash
# reboot.sh order | after: the host's reboot for its own packages (ADR 0077 section 3; LAB ONLY, test data).
#   order: a cookie in each slot, a test /run/reboot-required (rebootPending), and Platform's reboot_host; the link tries it every
#          minute and the host refuses it until both desks are idle by their own idle.json, then reboots.
#   after: what the boot left: the order's refusals and its acceptance, how each desk closed (quit, exit_type), the boot, the link's
#          hello and the desks started again by the fake Platform, then their cookies.
set -u
cd /var/tmp/lab
case "$1" in
order)
  for k in 1 2; do bash steps.sh mark $k prereboot; done
  touch /run/reboot-required
  python3 -I /usr/local/lib/desk-host/desk-host-template reboot-pending
  python3 -I fake.py orders '[{"op": "reboot_host", "id": "reboot_host:lab-1", "urgent": false, "restart": [1, 2]}]'
  date -u +"ordered at %T" | tee /var/tmp/reboot-ordered ;;
after)
  echo "ordered: $(cat /var/tmp/reboot-ordered)"
  journalctl -b -1 -u desk-host-link --no-pager -o short-iso | grep -E "reboot_host" | sed -n '1p;$p'
  journalctl -b -1 --no-pager -o short-iso | grep -E "rebooting for the host's own packages|every desk stopped" | tail -2
  for k in 1 2; do grep -a 'desk-browser-close' /var/log/desk-host/desk-$k.log | tail -1; done
  cat /var/lib/desk-host/reboot.json; echo
  systemd-analyze | head -1
  journalctl -b -u desk-host-link --no-pager -o short-iso | grep -E "hello:|start_slot" | head -4
  for k in 1 2; do bash steps.sh start $k 600; done
  for k in 1 2; do bash steps.sh browser $k | tail -1; done; sleep 8
  for k in 1 2; do bash steps.sh read $k; done
  python3 -I /usr/local/lib/desk-host/desk-host-template reboot-pending || echo "no reboot pending now" ;;
esac
