#!/bin/bash
# rest.sh (LAB ONLY): after 7803's failure, a batch signed with a key the host doesn't trust (7804), desk-rtc saying held on a capped
# slot, and the unpack's memory with and without the whole-layer read (7805 with DESK_HOST_RELEASE_WHOLE_READ=1, then 7806), by hand in
# desk-host-upd as the link runs it.
set -u
cd /var/tmp/lab; L=/usr/local/lib/desk-host; U=/sys/fs/cgroup/desk-host-upd
echo "== 7804, another key"; before=$(ls /srv/desk-host/releases/desk-rtc | tr '\n' ' ')
bash bsteps.sh order /root/orders/order-7804.json; bash bsteps.sh fetchwait 7804 | head -2
echo "store before: $before; after: $(ls /srv/desk-host/releases/desk-rtc | tr '\n' ' '); downloads: [$(ls /var/lib/desk-host/dl)]"
echo "== desk-rtc held on a capped slot (slot 2)"
cp -a /etc/desk-host/egress.conf /root/egress.conf.keep
printf '\n[slot2]\ncapped_month_gb = 0.000001\ncapped_day_gb = 0.000001\n' >> /etc/desk-host/egress.conf
desk-host shaper 2 on >/dev/null; for i in $(seq 1 90); do [ "$(cat /run/desk-host/2/egress/profile)" = capped ] && break; sleep 2; done
echo "slot 2's profile: $(cat /run/desk-host/2/egress/profile)"
n0=$(grep -c "stream profile" /var/log/desk-host/svc-2-desk-rtc.log)
desk-host resandbox 2 desk-rtc | tail -1; sleep 5
echo "desk-rtc's log since: $(grep "stream profile" /var/log/desk-host/svc-2-desk-rtc.log | tail -n +$((n0 + 1)) | tail -2)"
pid=$(runc state dh-svc-2-desk-rtc | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["pid"])')
grep " /run/desk-egress " /proc/$pid/mountinfo | awk '{print "mount in desk-rtc:", $5, $6}'
cp -a /root/egress.conf.keep /etc/desk-host/egress.conf; desk-host shaper 2 on >/dev/null
echo "== 7805, the whole-layer read (mutation)"
python3 -I -c 'import json; o=json.load(open("/root/orders/order-7805.json")); print("components:", list(o["urls"]))'
echo reset > $U/memory.peak 2>/dev/null; o0=$(sed -n 's/^oom_kill //p' $U/memory.events)
( m=0; while :; do a=$(sed -n 's/^anon //p' $U/memory.stat); [ "${a:-0}" -gt "$m" ] && m=$a && echo $m > /tmp/w.anon; sleep 0.2; done ) & smp=$!
t0=$(date +%s); DESK_HOST_RELEASE_WHOLE_READ=1 python3 -I $L/desk-host-template upd -- $L/desk-host-batch fetch /root/orders/order-7805.json > /tmp/w.log 2>&1; rc=$?; kill $smp
echo "rc $rc after $(( $(date +%s) - t0 )) s; anon at most $(( $(cat /tmp/w.anon 2>/dev/null || echo 0) >> 20 )) MiB; oom_kill $(sed -n 's/^oom_kill //p' $U/memory.events) (was $o0); $(python3 -I -c 'import json; d=json.load(open("/var/lib/desk-host/batch/fetch.json")); print(d["state"], d.get("step"), (d.get("error") or "")[:160])')"
echo "== 7806, streamed"
echo reset > $U/memory.peak 2>/dev/null
( m=0; while :; do a=$(sed -n 's/^anon //p' $U/memory.stat); [ "${a:-0}" -gt "$m" ] && m=$a && echo $m > /tmp/s.anon; sleep 0.2; done ) & smp=$!
t0=$(date +%s); python3 -I $L/desk-host-template upd -- $L/desk-host-batch fetch /root/orders/order-7806.json > /tmp/s.log 2>&1; rc=$?; kill $smp
echo "rc $rc after $(( $(date +%s) - t0 )) s; anon at most $(( $(cat /tmp/s.anon 2>/dev/null || echo 0) >> 20 )) MiB; memory.peak $(( $(cat $U/memory.peak) >> 20 )) MiB; oom_kill $(sed -n 's/^oom_kill //p' $U/memory.events)"
grep "desk-host-release:" /tmp/s.log | tail -1
python3 -I - <<'P'
import json, tarfile, sys
sys.path.insert(0, "/usr/local/lib/desk-host")
P
python3 -I $L/desk-host-batch halt 7806 lab-memory-measure | tail -1; python3 -I $L/desk-host-batch gc
bash bsteps.sh state
$L/desk-host-check --allow-verify-access --only releases,batch-sig,svc-spec,update-cgroup
