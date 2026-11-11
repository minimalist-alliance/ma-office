#!/bin/bash
# steps.sh <step> [args]: the u77-host lab's steps on the box, as root (LAB ONLY, test data only). Each prints what it saw.
#   start <k> | stop <k>              the fake Platform wants slot k running or stopped; waits for the link's report to say so
#   browser <k>                       Chromium started in slot k (units.sock, as its deskd would) and its CDP forward answering
#   seed <k> | mark <k> <name> | read <k>   sess_slot.py
#   slot <k>                          the slot's record, generation, what's in its store directory, the last close line
set -u
LAB=/var/tmp/lab
rep() { python3 -I - "$@" <<'P'
import json, sys, time
end = time.time() + float(sys.argv[1]); k = sys.argv[2]; want = sys.argv[3].split(",")
def last():
    s = {}
    try:
        for l in open("/root/fake/requests.jsonl"):
            r = json.loads(l)
            if r["route"] == "/v1/host/report" and r["status"] == 200:
                s = {str(x["k"]): x for x in r["body"]["slots"]}
    except OSError:
        pass
    return s.get(k, {})
while True:
    s = last()
    if s.get("state") in want or time.time() > end:
        break
    time.sleep(1)
print(f"slot {k}: {s.get('state')} on {s.get('template')} (behind {s.get('behind')}, holdUntil {(s.get('update') or {}).get('holdUntil')})")
sys.exit(0 if s.get("state") in want else 1)
P
}
case "$1" in
start) python3 -I $LAB/fake.py want "$2" running; rep "${3:-900}" "$2" running ;;
stop) python3 -I $LAB/fake.py want "$2" stopped; rep "${3:-300}" "$2" stopped,unmounted ;;
browser)
  for i in $(seq 1 60); do python3 -I $LAB/units.py "$2" start desk-browser --retry-busy 5 >/tmp/u.out 2>&1 && break; sleep 2; done; cat /tmp/u.out
  for i in $(seq 1 120); do curl -fsS -m 2 "http://10.98.$2.2:19222/json/version" >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS -m 2 "http://10.98.$2.2:19222/json/version" | python3 -I -c 'import json,sys; print("chromium", json.load(sys.stdin)["Browser"])' ;;
seed|read) python3 -I $LAB/sess_slot.py "$1" "$2" ;;
mark) python3 -I $LAB/sess_slot.py mark "$2" "$3" ;;
slot)
  k=$2; cat /var/lib/desk-host/slots/$k.json; echo
  ls -A /srv/desk-host/slots/ | tr '\n' ' '; echo
  grep -a 'desk-browser-close' /var/log/desk-host/desk-$k.log | tail -1 ;;
*) sed -n 2,8p "$0"; exit 2 ;;
esac
