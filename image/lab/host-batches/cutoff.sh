#!/bin/bash
# cutoff.sh (LAB ONLY): ADR 0078 3.4 on slot 2. Live switches off at the fake (so the link starts nothing); batch 7807 (TEST key: desk-rtc
# 0.5.0, the store's previous: nothing downloaded) as the candidate. (a) A switch killed right after its renames (CRASH_AT=switch-swap),
# then a stop and a start: put back by renames before the start, the record naming the old set, tree hashes matching it. (b) A switch
# killed after the new sandbox started (CRASH_AT=switch-start), the slot left running: the next switch smoke-tests what's switched and
# finishes. A test host's switches here are by hand (SWITCH_FORCE_LIVE, DESK_HOST_BATCH_FORCE_IDLE).
set -u
cd /var/tmp/lab; L=/usr/local/lib/desk-host
rec() { python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print({x: r.get(x) for x in ("batch","switching")}, "desk-rtc:", (r.get("releases") or {}).get("desk-rtc"))' /var/lib/desk-host/slots/2.json; }
sw() { CRASH_AT=${1:-} SWITCH_FORCE_LIVE=1 DESK_HOST_BATCH_FORCE_IDLE=1 python3 -I $L/desk-host-template upd -- /bin/bash $L/desk-host switch 2 >> /var/log/desk-host/cutoff.log 2>&1; echo "switch exit $?"; }
bash bsteps.sh live off; sleep 15
bash bsteps.sh order /root/orders/order-7807.json; bash bsteps.sh fetchwait 7807 | head -1
echo "== (a) CRASH_AT=switch-swap"; sw switch-swap
echo "record: $(rec)"; echo "rel/: $(ls -A /srv/desk-host/slots/2/rel | tr '\n' ' ')"; echo "desk-rtc sandbox: $(runc state dh-svc-2-desk-rtc 2>/dev/null | grep -o '"status": "[a-z]*"' || echo none)"
bash steps.sh mark 2 cut8; sleep 8
bash steps.sh stop 2; sleep 20; tail -2 /var/log/desk-host/reroot-2.log
bash steps.sh start 2; grep -h "cut off" /var/log/desk-host/link-2.log | tail -1
echo "record: $(rec)"; echo "rel/: $(ls -A /srv/desk-host/slots/2/rel | tr '\n' ' ')"
$L/desk-host-check --allow-verify-access --only releases,svc-spec
bash steps.sh browser 2 | tail -1; sleep 10; python3 -I sess_slot.py read 2
echo "== (b) CRASH_AT=switch-start"; sw switch-start
echo "record: $(rec)"; echo "desk-rtc sandbox: $(runc state dh-svc-2-desk-rtc 2>/dev/null | grep -o '"status": "[a-z]*"' || echo none)"
sw; echo "record: $(rec)"; grep -E "cut off|resuming|smoke test|switched in|ROLLED" /var/log/desk-host/cutoff.log | tail -5
$L/desk-host-check --allow-verify-access --only releases,svc-spec
python3 -I $L/desk-host-batch halt 7807 lab-cutoff-done | tail -1
