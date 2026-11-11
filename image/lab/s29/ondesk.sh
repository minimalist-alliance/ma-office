# S-29: a new desk-stream told a level as desk-rtc tells it on connecting ("level <x>\nresume\nkeyframe\n"), many times.
# Run as root over SSM on a staging DeskKind=test desk of your own only: it stops desk-rtc for the run and starts it again,
# and leaves desk-stream stopped (desk-rtc's next viewer starts it). Each line: video packets in 3 s, and desk-stream's
# "error:" lines for that start. Results: image/evidence/s29-2026-11-11/start-level-*.txt.
set -u
cat > /var/tmp/s29rtc.py <<'P'
import os, select, socket, struct, sys, time
level = sys.argv[1]
path = '/run/desk-media/stream.sock'
if os.path.exists(path): os.unlink(path)
ln = socket.socket(socket.AF_UNIX); ln.bind(path); os.chmod(path, 0o666); ln.listen(1); ln.settimeout(20)
c, _ = ln.accept()
c.sendall(f'level {level}\nresume\nkeyframe\n'.encode())
end, v, buf, eof = time.monotonic() + 3, 0, b'', False
while time.monotonic() < end:
    rd, _, _ = select.select([c], [], [], max(0, end - time.monotonic()))
    if not rd: continue
    d = c.recv(1 << 20)
    if not d: eof = True; break
    buf += d
    while len(buf) >= 2:
        n = struct.unpack('>H', buf[:2])[0]
        if len(buf) < 2 + n: break
        p = buf[2:2 + n]; buf = buf[2 + n:]
        if p[1] & 0x7f == 96: v += 1
print(f'video_packets={v} eof={eof}', flush=True)
P
chmod 644 /var/tmp/s29rtc.py
systemctl stop desk-rtc
for level in high max max max max max max max max max max max max max max max max max max max max medium medium medium medium medium low low low low low; do
  systemctl stop desk-stream; systemctl reset-failed desk-stream 2>/dev/null
  setpriv --reuid=1101 --regid=1101 --clear-groups python3 /var/tmp/s29rtc.py $level > /var/tmp/s29rtc.out 2>&1 &
  FP=$!; sleep 0.5
  since=$(date -u '+%Y-%m-%d %H:%M:%S')
  systemctl start desk-stream; wait $FP
  sleep 0.5
  err=$(journalctl -u desk-stream --since "$since UTC" --no-pager -o cat | grep -c 'error:')
  echo "level $level: $(cat /var/tmp/s29rtc.out) errors=$err restarts=$(systemctl show -p NRestarts --value desk-stream)"
done
systemctl stop desk-stream; systemctl reset-failed desk-stream 2>/dev/null
rm -f /run/desk-media/stream.sock /var/tmp/s29rtc.py /var/tmp/s29rtc.out
systemctl start desk-rtc; sleep 2
echo "desk-rtc $(systemctl is-active desk-rtc), desk-stream $(systemctl is-active desk-stream)"
