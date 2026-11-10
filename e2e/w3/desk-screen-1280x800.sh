#!/bin/bash
# W3: takes one temporary test desk from a 1920x1080 screen to 1280x800, on its root disk, with no bake, and reads back that the
# screen, the window and the stream all follow. For the Platform Engineer, as root over SSM, after desk-rtc, desk-stream and deskd
# are rolled out, with no Browser window open. A root swap undoes it. Safe to run twice. --check only reads back.
# --size 1600x900 sets that size instead (the owner asked for it, 2026-11-06); --size 1280x800 goes back. Each edit starts from the
# 1920x1080 originals the first run backed up, so any size can follow any other.
#
#   b64=$(base64 -w0 e2e/w3/desk-screen-1280x800.sh)
#   aws ssm send-command --instance-ids <the temporary desk> --document-name AWS-RunShellScript --timeout-seconds 900 \
#     --parameters "$(jq -n --arg c "echo $b64 | base64 -d > /var/tmp/w3-screen.sh && bash /var/tmp/w3-screen.sh [--size 1600x900]" '{commands: [$c]}')"
#
# It has never run. What it can't prove, and the harness has to: that desk-rtc's X connection comes back with the new size (it
# reconnects on the next input, so only a click can show it) and that the real stream reaches a client at 1280x800. measure.spec.ts
# stops if either doesn't hold, with W3_EXPECT_SCREEN=1280x800.
set -u

MODE=edit SIZE=1280x800
while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE=--check ;;
    --size) SIZE=${2:-}; shift ;;
    *) echo "usage: $0 [--check] [--size 1280x800|1600x900]" >&2; exit 2 ;;
  esac
  shift
done
case "$SIZE" in
  # 59.96 Hz, the same as the 1920x1080 mode. Horizontal timings as spikes/browser-bench/real-stack/screen.sh, which ran on this driver;
  # its 83.46 MHz gave 59.78 Hz, and a slower mode could read as a slightly slower page.
  1280x800) MODELINE='Modeline "1280x800_60.00" 83.71 1280 1344 1480 1680 800 803 809 831 -hsync +vsync' ;;
  # cvt 1600 900 60: 59.95 Hz. The 1920x1080 mode in the image is cvt's too.
  1600x900) MODELINE='Modeline "1600x900_60.00" 118.25 1600 1696 1856 2112 900 903 908 934 -hsync +vsync' ;;
  *) echo "REFUSED: --size is 1280x800 or 1600x900" >&2; exit 2 ;;
esac
W=${SIZE%x*} H=${SIZE#*x}
PROFILE=/data/browser/profile
# Test hook: paths only. The guard below has no way round it.
ROOT=${W3_EDIT_ROOT:-}
CONF=$ROOT/etc/ma/xorg-dummy.conf
START=$ROOT/usr/local/lib/ma/desk-browser-start
BACKUP=$ROOT/var/backups/ma-w3-screen
TMP=$ROOT/var/tmp/ma-w3-screen
STREAM_CONF=$ROOT/opt/ma/desk-stream/current/stream.conf
HEALTH_SOCK=/run/desk/deskd-admin.sock
fails=0

die() { echo "REFUSED: $*" >&2; exit 2; }
say() { echo "--- $*"; }
check() { if [ "$1" = 0 ]; then echo "PASS  $2"; else echo "FAIL  $2"; fails=$((fails + 1)); fi; }
as_stream() { (cd /tmp && DISPLAY=:99 HOME=$TMP GST_REGISTRY_1_0=$TMP/registry.bin GST_PLUGIN_PATH=$ROOT/opt/ma/desk-stream/current/gst-plugins:$ROOT/usr/local/lib/ma/gst-plugins runuser -u stream -- "$@"); }

# ---- The guard: a DeskKind=test desk, and not one of the two that must stay at 1920x1080.
[ "$(id -u)" = 0 ] || die "run this as root"
token=$(curl -fsS -m 3 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 300' http://169.254.169.254/latest/api/token) || die "no IMDS, so nothing says what this machine is"
imds() { curl -fsS -m 3 -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/$1"; }
id=$(imds meta-data/instance-id) || die "IMDS gave no instance id"
# W3_PROTECTED: comma-separated instance IDs that must stay at 1920x1080 (the production desks and the shared test desk
# the release gate uses, e2e/tests/stream.spec.ts:174).
case ",${W3_PROTECTED:-}," in
  *",$id,"*) die "$id is protected (W3_PROTECTED)" ;;
esac
kind=$(imds meta-data/tags/instance/DeskKind 2>/dev/null) || kind=
if [ -z "$kind" ]; then   # tags not in IMDS on this instance: ask with its own role, if it can
  region=$(imds meta-data/placement/region) || die "IMDS gave no region"
  kind=$(aws ec2 describe-tags --region "$region" --filters "Name=resource-id,Values=$id" Name=key,Values=DeskKind --query 'Tags[0].Value' --output text 2>/dev/null) || kind=
fi
[ "$kind" = test ] || die "$id has DeskKind='$kind', and this only runs on DeskKind=test"
say "desk $id, DeskKind=$kind, $(imds meta-data/instance-type)"


# ---- The edit: every expected line checked first, then both files replaced whole, with owner and mode kept.
if [ "$MODE" = edit ]; then
  wanted=$(curl -s -m 3 --unix-socket "$HEALTH_SOCK" http://desk/health 2>/dev/null | python3 -I -c 'import json,sys
try: print(json.load(sys.stdin).get("stream",{}).get("wanted",""))
except Exception: print("")')
  case "$wanted" in "" | off) ;; *) die "this desk has a Browser window open (stream wanted=$wanted). Close it first: this restarts Xorg and Chromium" ;; esac
  install -d -m 700 "$BACKUP"
  for f in "$CONF" "$START"; do
    [ -f "$f" ] || die "$f is missing"
    [ -e "$BACKUP/$(basename "$f").orig" ] || cp -a "$f" "$BACKUP/$(basename "$f").orig"
  done
  MODELINE=$MODELINE W=$W H=$H CONF=$CONF START=$START BACKUP=$BACKUP python3 -I - <<'PY' || die "the files aren't as expected, and nothing was changed"
import os, sys
w, h = os.environ['W'], os.environ['H']
edits = {
    os.environ['CONF']: [
        ('Modeline "1920x1080_60.00" 173.00 1920 2048 2248 2576 1080 1083 1088 1120 -hsync +vsync', os.environ['MODELINE']),
        ('Virtual 1920 1080', 'Virtual %s %s' % (w, h)),
        ('Modes "1920x1080_60.00"', 'Modes "%sx%s_60.00"' % (w, h)),
    ],
    os.environ['START']: [('W=1920 H=1080', 'W=%s H=%s' % (w, h))],
}
out = {}
for path, pairs in edits.items():
    # From the 1920x1080 original backed up above, so one size can follow another. A file already at this size passes (0, 1).
    orig = os.path.join(os.environ['BACKUP'], os.path.basename(path) + '.orig')
    text = open(orig if os.path.exists(orig) else path).read()
    for old, new in pairs:
        o, n = text.count(old), text.count(new)
        if (o, n) == (1, 0): text = text.replace(old, new)
        elif (o, n) != (0, 1):
            sys.exit('%s: %r %d times, %r %d times' % (path, old, o, new, n))
    out[path] = text
for path, text in out.items():
    st = os.stat(path)
    tmp = path + '.w3tmp'
    with open(tmp, 'w') as f: f.write(text)
    os.chown(tmp, st.st_uid, st.st_gid); os.chmod(tmp, st.st_mode & 0o7777)
    os.replace(tmp, path)
PY
  say "edited (originals in $BACKUP)"
  grep -nE 'Modeline|Virtual|Modes' "$CONF"
  grep -nE '^W=' "$START"

  # Only these read the size at start. desk-rtc and deskd stay up: desk-rtc redials X when it next has input, and picks the size up
  # from the connection. Stopped in this order so Chromium writes its session while its display is still there (ADR 0009).
  say "restarting desk-xorg and desk-browser"
  systemctl stop desk-stream desk-browser desk-xorg || die "couldn't stop the units"
fi

# ---- Up, as a first Browser use would bring them. desk-stream stays off: deskd starts it for a viewer.
started=$(date +%s)
systemctl start desk-xorg desk-browser || check 1 "desk-xorg and desk-browser start"
up=
for _ in $(seq 1 300); do
  curl -s -m 2 http://127.0.0.1:9222/json/version >/dev/null && { up=1; break; }
  sleep 1
done
check "$([ -n "$up" ] && echo 0 || echo 1)" "Chromium's port answers, $(($(date +%s) - started)) s after the start (on a fresh root this is slow by itself)"
install -d -m 755 "$TMP"; chown stream "$TMP" 2>/dev/null

# ---- Read back. Each check reads the thing itself, not the file that asks for it.
size=$(as_stream xrandr --current 2>/dev/null | head -1)
echo "$size"
case "$size" in *"current $W x $H,"*) r=0 ;; *) r=1 ;; esac
check $r "the X screen is ${W}x$H"

geo=
for _ in $(seq 1 300); do   # as long as desk-browser-start's fit_window keeps trying
  win=$(as_stream xdotool search --onlyvisible --classname "$PROFILE" 2>/dev/null | head -1)
  [ -n "$win" ] && geo=$(as_stream xdotool getwindowgeometry --shell "$win" 2>/dev/null | tr '\n' ' ')
  case "$geo" in *"WIDTH=$W "*"HEIGHT=$H "*) break ;; esac
  sleep 1
done
echo "$geo"
case "$geo" in *"WIDTH=$W "*"HEIGHT=$H "*) r=0 ;; *) r=1 ;; esac
check $r "Chromium's window is ${W}x$H"

# The page's own view, from a tab of its own, as image/verify.sh reads it: no second CDP client, only titles.
cat >"$TMP/size.html" <<'HTML'
<!doctype html><title>w3</title><style>html,body{margin:0;height:100%;background:#fff}</style>
<script>const p=()=>{document.title='W3:'+[screen.width,screen.height,innerWidth,innerHeight,devicePixelRatio].join(',')};p();addEventListener('resize',p);setInterval(p,500)</script>
HTML
chmod 644 "$TMP/size.html"
tab=$(curl -s -m 10 -X PUT "http://127.0.0.1:9222/json/new?file://$TMP/size.html" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["id"])' 2>/dev/null)
page=
for _ in $(seq 1 30); do
  sleep 1
  page=$(curl -s -m 5 http://127.0.0.1:9222/json/list | python3 -I -c 'import json,sys
for t in json.load(sys.stdin):
    if t["id"] == sys.argv[1]: print(t["title"])' "$tab" 2>/dev/null)
  [ "$page" = "W3:$W,$H,$W,$H,1" ] && break
done
echo "page, as screen.width,screen.height,innerWidth,innerHeight,devicePixelRatio: $page"
[ "$page" = "W3:$W,$H,$W,$H,1" ]; check $? "the page sees a ${W}x$H screen and a ${W}x$H viewport at DPR 1"

# Capture one frame the way the stream does, in the stream's own user: its size, and white to the last row and column (no black strip).
as_stream gst-launch-1.0 -q ximagesrc display-name=:99 use-damage=false num-buffers=1 ! videoconvert ! video/x-raw,format=GRAY8 ! filesink "location=$TMP/edge.gray" >/dev/null 2>&1
W=$W H=$H GRAY=$TMP/edge.gray python3 -I - <<'PY'
import os, sys
w, h = int(os.environ['W']), int(os.environ['H'])
try: d = open(os.environ['GRAY'], 'rb').read()
except OSError as e: print('no frame:', e); sys.exit(1)
print('captured %d bytes, %dx%d is %d' % (len(d), w, h, w * h))
if len(d) != w * h: sys.exit(1)
right = sum(d[y * w + w - 1] for y in range(h)) // h; bottom = sum(d[(h - 1) * w:h * w]) // w
print('last column averages %d, last row %d, of 255' % (right, bottom))
sys.exit(0 if right > 250 and bottom > 250 else 1)
PY
check $? "a captured frame is ${W}x$H, and the page reaches its last row and column"
[ -n "$tab" ] && curl -s -m 5 "http://127.0.0.1:9222/json/close/$tab" >/dev/null

# The encoder's own caps, from stream.conf's own strings, in a throwaway pipeline beside the real one.
pipe=$(STREAM_CONF=$STREAM_CONF python3 -I - <<'PY'
import configparser, os
c = configparser.ConfigParser(interpolation=None); c.read(os.environ['STREAM_CONF']); v = c['video']
print('%s ! %s ! x264enc name=encoder %s ! %s ! fakesink' % (v['capture'].replace('ximagesrc ', 'ximagesrc num-buffers=5 ', 1), v['convert'], v['x264'], v['caps']))
PY
)
read -r -a parts <<<"$pipe"
caps=$(as_stream timeout 120 gst-launch-1.0 -v "${parts[@]}" 2>&1 | grep -m1 -E 'encoder\.GstPad:src: caps')
echo "x264 output, with stream.conf's settings: $(echo "$caps" | grep -oE '(level=\(string\)[0-9.]+|width=\(int\)[0-9]+|height=\(int\)[0-9]+|framerate=\(fraction\)[0-9/]+)' | tr '\n' ' ')"
case "$caps" in *"width=(int)$W,"*"height=(int)$H,"*) r=0 ;; *) r=1 ;; esac
check $r "the encoder, on stream.conf's settings, outputs ${W}x$H"
rm -rf "$TMP"

health=$(curl -s -m 3 --unix-socket "$HEALTH_SOCK" http://desk/health 2>/dev/null)
echo "deskd /health: $(echo "$health" | cut -c1-300)"
echo "units: $(for u in desk-xorg desk-browser desk-stream desk-rtc deskd; do echo -n "$u=$(systemctl is-active $u) "; done)"

echo "Not proven here: a real stream at this size, and input landing. W3_EXPECT_SCREEN=${W}x$H in e2e/w3/measure.spec.ts checks both."
if [ "$fails" -gt 0 ]; then
  echo "RESULT: FAIL ($fails). Originals are in $BACKUP: cp -a them back, then systemctl restart desk-xorg desk-browser."
  exit 1
fi
echo "RESULT: PASS"
