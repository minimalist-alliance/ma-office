// What W3 shows in the desk's Chromium, from a loopback server on the desk, as stream.spec.ts does: same documents where the
// numbers should read against docs/benchmarks/2026-11-real-stack.md. streamlib.ts doesn't export them and has its own port, so
// these are copies. What differs from its report.js: no on-page fps counter (it would change pixels twice a second, and the
// stream is VFR, so a static page wouldn't be static), and `gm`, the longest gap between animation frames since the last report.
//
// On the desk this writes only under DIR and runs one transient unit as `nobody`. removePages() takes both away.
import type { TestDesk } from './w3lib';

export const PORT = 18767; // stream.spec.ts has 18765, browser-session.spec.ts 18766
export const DIR = '/var/tmp/ma-e2e-w3'; // not /tmp, which can be a tmpfs: a clip there would take memory from the page
const UNIT = 'ma-e2e-w3-pages';
export const pageUrl = (path: string) => `http://127.0.0.1:${PORT}/${path}`;

const REPORT_JS = `(function () {
  const q = new URLSearchParams(location.search);
  const S = { frames: 0, sf: 0, px: 0, lf: 0, gm: 0, y: scrollY, last: null };
  window.__extra = {};
  requestAnimationFrame(function loop(t) {
    if (S.last !== null) { const g = t - S.last; if (g > 25) S.lf++; if (g > S.gm) S.gm = g; }
    S.last = t; S.frames++;
    const y = scrollY;
    if (y !== S.y) { S.sf++; S.px += Math.abs(y - S.y); S.y = y; }
    requestAnimationFrame(loop);
  });
  window.__publish = () => {
    if (window.__before) window.__before();
    // deskd cuts a title at 256 characters (BrowserTabs.TITLE_CHARS), and a cut report can't be read, so keep these short.
    document.title = 'R' + JSON.stringify(Object.assign({ t: Math.round(performance.now()), f: S.frames, sf: S.sf, px: Math.round(S.px), lf: S.lf, gm: Math.round(S.gm), y: Math.round(scrollY),
      vis: document.visibilityState, foc: document.hasFocus() ? 1 : 0, n: q.get('n') || '' }, window.__extra)).replaceAll('"', '~');
    S.gm = 0;
  };
  setInterval(window.__publish, 1000);
  // Flicks are read from y once a report shows the wheel arrived (wc) and the page has settled. Only on that page: more titles are more load.
  if (q.get('flick')) { addEventListener('wheel', () => { window.__extra.wc = (window.__extra.wc || 0) + 1; }, { passive: true }); addEventListener('scrollend', window.__publish); }
  window.__publish();
})();`;

// Same document as streamlib.ts' SCROLL_HTML and real-stack/pages/scroll.html.
const SCROLL_HTML = `<!doctype html><meta charset="utf-8"><title>scroll test</title>
<style>body{margin:0 auto;max-width:1100px;font:18px/1.6 Georgia,serif;color:#222;background:#fafafa;padding:20px}
h2{font:bold 28px sans-serif;margin:40px 0 10px}.card{display:flex;gap:16px;margin:16px 0;padding:16px;border-radius:12px;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.15)}
.img{flex:0 0 260px;height:160px;border-radius:8px}table{border-collapse:collapse;width:100%}td{border:1px solid #ccc;padding:4px 8px;font:14px sans-serif}</style>
<script src="report.js"></script>
<body><h1>Scroll benchmark page</h1><div id="c"></div>
<script>
let s = 1; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua minimalist desk alliance browser stream frame latency'.split(' ');
const para = (n) => Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(' ') + '.';
let h = '';
for (let i = 0; i < 220; i++) {
  h += '<h2>Section ' + (i + 1) + '</h2><p>' + para(90) + '</p>';
  const a = Math.floor(rnd() * 360), b = Math.floor(rnd() * 360);
  h += '<div class="card"><div class="img" style="background:linear-gradient(' + a + 'deg,hsl(' + a + ',70%,55%),hsl(' + b + ',70%,45%))"></div><p>' + para(60) + '</p></div>';
  if (i % 5 === 0) { h += '<table>'; for (let r = 0; r < 8; r++) { h += '<tr>' + Array.from({ length: 6 }, () => '<td>' + (rnd() * 1e5).toFixed(2) + '</td>').join('') + '</tr>'; } h += '</table>'; }
}
document.getElementById('c').innerHTML = h;
</script></body>`;

// The static text article, and the capture's last fallback when every public page refuses a cloud address.
const ARTICLE_HTML = `<!doctype html><meta charset="utf-8"><title>article</title>
<style>body{margin:0 auto;max-width:860px;font:17px/1.55 Georgia,serif;color:#202122;background:#fff;padding:24px}
h1{font:600 30px sans-serif}h2{font:600 21px sans-serif;margin:28px 0 8px}.small{font:12px/1.4 sans-serif;color:#444}
table{border-collapse:collapse;width:100%}td{border:1px solid #ddd;padding:2px 5px;font:11px/1.3 sans-serif}</style>
<script src="report.js"></script>
<body><h1>A static article</h1><div id="c"></div>
<script>
let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
const words = 'the type on a page is set in lines of even colour and the eye reads the shape of each word before its letters so spacing weight and contrast all matter more than they seem to at first glance'.split(' ');
const para = (n) => Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(' ') + '.';
let h = '';
for (let i = 0; i < 12; i++) {
  h += '<h2>Section ' + (i + 1) + '</h2><p>' + para(120) + '</p><p class="small">' + para(70) + '</p>';
  if (i % 3 === 0) { h += '<table>'; for (let r = 0; r < 8; r++) { h += '<tr>' + Array.from({ length: 8 }, () => '<td>' + (rnd() * 1e4).toFixed(1) + '</td>').join('') + '</tr>'; } h += '</table>'; }
}
document.getElementById('c').innerHTML = h;
</script></body>`;

// Public-domain lines (the Iroha poem and pangrams). Boxes in place of these letters mean the image has no font for them.
const NONLATIN_HTML = `<!doctype html><meta charset="utf-8"><title>non-Latin fixture</title>
<style>body{margin:0 auto;max-width:860px;font:17px/1.7 sans-serif;color:#202122;background:#fff;padding:24px}.small{font-size:12px;line-height:1.5}</style>
<body><h1>非ラテン文字の確認</h1>
<p>いろはにほへと ちりぬるを わかよたれそ つねならむ うゐのおくやま けふこえて あさきゆめみし ゑひもせす。いろはにほへと ちりぬるを わかよたれそ つねならむ。</p>
<p class="small">いろはにほへと ちりぬるを わかよたれそ つねならむ うゐのおくやま けふこえて あさきゆめみし ゑひもせす。いろはにほへと ちりぬるを わかよたれそ つねならむ うゐのおくやま けふこえて。</p>
<p class="small">天地玄黄 宇宙洪荒 日月盈昃 辰宿列张 寒来暑往 秋收冬藏 闰余成岁 律吕调阳 云腾致雨 露结为霜 金生丽水 玉出昆冈 剑号巨阙 珠称夜光 果珍李柰 菜重芥姜。</p>
<p class="small" dir="rtl">نص حكيم له سر قاطع وذو شأن عظيم مكتوب على ثوب أخضر ومغلف بجلد أزرق. نص حكيم له سر قاطع وذو شأن عظيم مكتوب على ثوب أخضر ومغلف بجلد أزرق.</p>
<p class="small">Съешь же ещё этих мягких французских булок, да выпей чаю. Съешь же ещё этих мягких французских булок, да выпей чаю. Съешь же ещё этих мягких французских булок.</p>
<p class="small">Ξεσκεπάζω την ψυχοφθόρα βδελυγμία. Ξεσκεπάζω την ψυχοφθόρα βδελυγμία. Ξεσκεπάζω την ψυχοφθόρα βδελυγμία. Ξεσκεπάζω την ψυχοφθόρα βδελυγμία.</p>
</body>`;

// Same square as streamlib.ts' LATENCY_HTML and real-stack/pages/latency-wc.html. ?load=1 is its animated 520x292 canvas,
// ?load=video the clip at the size real-stack played its video beside the square.
const LATENCY_HTML = `<!doctype html><meta charset="utf-8"><title>latency</title>
<style>html,body{margin:0;height:100%;background:#808080;overflow:hidden}
#sq{position:absolute;left:50%;top:50%;width:800px;height:800px;margin:-400px 0 0 -400px;background:#000}
#v,#m{position:absolute;left:0;top:0;width:520px;height:292px;display:none}</style>
<script src="report.js"></script>
<body><div id="sq"></div><canvas id="v" width="520" height="292"></canvas><video id="m" muted loop playsinline></video>
<script>
let white = false, n = 0;
addEventListener('keydown', (e) => { white = !white; n++; window.__extra.kd = n; document.getElementById('sq').style.background = white ? '#fff' : '#000'; e.preventDefault(); }, true);
const load = new URLSearchParams(location.search).get('load');
if (load === 'video') {
  const m = document.getElementById('m'); m.src = 'media/clip.mp4'; m.style.display = 'block'; m.play().catch(() => {}); window.__extra.load = 'video';
} else if (load) {
  const c = document.getElementById('v'), x = c.getContext('2d'); c.style.display = 'block';
  requestAnimationFrame(function draw(t) {
    for (let i = 0; i < 24; i++) {
      const a = t / 500 + i, cx = 260 + 240 * Math.sin(a * 1.3), cy = 146 + 130 * Math.cos(a * 0.7);
      const g = x.createRadialGradient(cx, cy, 2, cx, cy, 90);
      g.addColorStop(0, 'hsl(' + ((t / 8 + i * 40) % 360) + ',90%,60%)'); g.addColorStop(1, 'hsl(' + ((t / 5 + i * 70) % 360) + ',80%,25%)');
      x.fillStyle = g; x.fillRect(cx - 90, cy - 90, 180, 180);
    }
    requestAnimationFrame(draw);
  });
  window.__extra.load = 'canvas';
}
</script></body>`;

// Motion with nothing to download: the canvas above, over the whole screen, so every frame changes everywhere.
const MOTION_HTML = `<!doctype html><meta charset="utf-8"><title>motion</title>
<style>html,body{margin:0;height:100%;background:#222;overflow:hidden}canvas{display:block}</style>
<script src="report.js"></script>
<body><canvas id="c"></canvas>
<script>
const c = document.getElementById('c'), x = c.getContext('2d');
c.width = innerWidth; c.height = innerHeight;
requestAnimationFrame(function draw(t) {
  const W = c.width, H = c.height;
  for (let i = 0; i < 24; i++) {
    const a = t / 500 + i, cx = W / 2 + (W / 2 - 40) * Math.sin(a * 1.3), cy = H / 2 + (H / 2 - 40) * Math.cos(a * 0.7);
    const g = x.createRadialGradient(cx, cy, 2, cx, cy, 200);
    g.addColorStop(0, 'hsl(' + ((t / 8 + i * 40) % 360) + ',90%,60%)'); g.addColorStop(1, 'hsl(' + ((t / 5 + i * 70) % 360) + ',80%,25%)');
    x.fillStyle = g; x.fillRect(cx - 200, cy - 200, 400, 400);
  }
  requestAnimationFrame(draw);
});
</script></body>`;

// real-stack/pages/bbb.html with the numbers in the title: frames presented (vp), callbacks (vf), decoded (vq), dropped (vd).
const VIDEO_HTML = `<!doctype html><meta charset="utf-8"><title>video</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}video{width:100vw;height:100vh;object-fit:contain;display:block}</style>
<script src="report.js"></script>
<body><video id="v" autoplay muted loop playsinline src="media/clip.mp4"></video>
<script>
const v = document.getElementById('v');
let vf = 0, vp = 0;
const cb = (now, m) => { vf++; vp = m.presentedFrames; v.requestVideoFrameCallback(cb); };
v.requestVideoFrameCallback(cb);
v.play().catch(() => {});
window.__before = () => {
  const q = v.getVideoPlaybackQuality();
  Object.assign(window.__extra, { vf, vp, vq: q.totalVideoFrames, vd: q.droppedVideoFrames, vw: v.videoWidth, vh: v.videoHeight, vpause: v.paused ? 1 : 0, verr: v.error ? v.error.code : 0 });
};
</script></body>`;

// A text input, and the same flip as latency.html in the middle of the screen, so a key's trip reads the same way. Enter empties
// the input. Published once a second only: a title per key would itself be load.
const TYPING_HTML = `<!doctype html><meta charset="utf-8"><title>typing</title>
<style>html,body{margin:0;height:100%;background:#808080;overflow:hidden}
#sq{position:absolute;left:50%;top:50%;width:400px;height:400px;margin:-200px 0 0 -200px;background:#000}
#t{position:absolute;left:50%;top:40px;width:640px;height:40px;margin-left:-320px;font:22px monospace}</style>
<script src="report.js"></script>
<body><div id="sq"></div><input id="t" autocomplete="off" spellcheck="false">
<script>
let white = false, n = 0;
const t = document.getElementById('t');
addEventListener('keydown', (e) => {
  white = !white; n++; document.getElementById('sq').style.background = white ? '#fff' : '#000';
  if (e.key === 'Enter') { t.value = ''; e.preventDefault(); }
}, true);
window.__before = () => {
  const r = t.getBoundingClientRect();
  Object.assign(window.__extra, { kd: n, ix: Math.round(r.left + r.width / 2), iy: Math.round(r.top + r.height / 2), fo: document.activeElement === t ? 1 : 0, v: t.value.slice(-80) });
};
t.addEventListener('focus', () => window.__publish());
</script></body>`;

// Proves input follows the screen. Targets by percent, so this page doesn't assume a size, and it says where they ended up.
const TARGETS_HTML = `<!doctype html><meta charset="utf-8"><title>targets</title>
<style>html,body{margin:0;height:100%;background:#eef;overflow:hidden}.t{position:fixed;width:80px;height:60px;border:0;background:#264;color:#fff}</style>
<script src="report.js"></script>
<body>
<button class="t" id="tl" style="left:2%;top:4%">tl</button><button class="t" id="tr" style="right:2%;top:4%">tr</button>
<button class="t" id="bl" style="left:2%;bottom:4%">bl</button><button class="t" id="br" style="right:2%;bottom:4%">br</button>
<button class="t" id="mid" style="left:50%;top:50%;margin:-30px 0 0 -40px">mid</button>
<script>
const c = {};
let l = null;
addEventListener('click', (e) => { const id = e.target.id || e.target.tagName; c[id] = (c[id] || 0) + 1; l = [id, e.clientX, e.clientY]; window.__publish(); }, true);
// A title holds 256 characters: the sizes always, the targets until the first click, then what was hit.
window.__before = () => {
  Object.assign(window.__extra, { sw: screen.width, sh: screen.height, iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio });
  if (l) { delete window.__extra.tg; Object.assign(window.__extra, { c, l }); return; }
  const tg = {};
  for (const b of document.querySelectorAll('.t')) { const r = b.getBoundingClientRect(); tg[b.id] = [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; }
  window.__extra.tg = tg;
};
</script></body>`;

// python3 http.server has no Range, and a video that can't seek won't loop cleanly.
const SERVE_PY = String.raw`
import http.server, os, re, sys
PORT = int(sys.argv[1]); ROOT = sys.argv[2]
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass
    def end_headers(self):
        self.send_header('Accept-Ranges', 'bytes'); self.send_header('Cache-Control', 'no-store'); super().end_headers()
    def do_GET(self):
        p = self.translate_path(self.path); r = self.headers.get('Range'); m = re.match(r'bytes=(\d+)-(\d*)$', r or '')
        if m and os.path.isfile(p):
            size = os.path.getsize(p); a = int(m[1]); b = min(int(m[2]) if m[2] else size - 1, size - 1)
            if a < size:
                self.send_response(206); self.send_header('Content-Type', self.guess_type(p)); self.send_header('Content-Range', 'bytes %d-%d/%d' % (a, b, size)); self.send_header('Content-Length', str(b - a + 1)); self.end_headers()
                with open(p, 'rb') as f:
                    f.seek(a); left = b - a + 1
                    while left:
                        d = f.read(min(left, 1 << 20))
                        if not d: break
                        self.wfile.write(d); left -= len(d)
                return
        super().do_GET()
class S(http.server.ThreadingHTTPServer):
    daemon_threads = True
    def handle_error(self, *a): pass  # a video element drops connections as it seeks
S(('127.0.0.1', PORT), H).serve_forever()
`;

// Runtime.evaluate in the tab on screen, as root over SSM (nftables lets uid 0 reach 9222). The socket code is browser-session.spec.ts'.
const CDP_PY = String.raw`
import base64, json, os, socket, struct, sys, urllib.request
CDP = 'http://127.0.0.1:9222'
def tabs(): return [t for t in json.loads(urllib.request.urlopen(CDP + '/json/list', timeout=10).read()) if t['type'] == 'page']
def call(t, expr):
    host, path = t['webSocketDebuggerUrl'].split('ws://', 1)[1].split('/', 1); h, p = host.split(':')
    s = socket.create_connection((h, int(p)), timeout=20)
    s.sendall(('GET /%s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n' % (path, host, base64.b64encode(os.urandom(16)).decode())).encode())
    b = b''
    while b'\r\n\r\n' not in b: b += s.recv(4096)
    rest = b.split(b'\r\n\r\n', 1)[1]
    def rd(n):
        nonlocal rest
        while len(rest) < n:
            d = s.recv(65536)
            if not d: raise EOFError
            rest += d
        o, rest = rest[:n], rest[n:]; return o
    msg = json.dumps({'id': 1, 'method': 'Runtime.evaluate', 'params': {'expression': expr, 'returnByValue': True}}).encode(); mask = os.urandom(4)
    s.sendall(b'\x81' + (bytes([0x80 | len(msg)]) if len(msg) < 126 else bytes([0x80 | 126]) + struct.pack('>H', len(msg))) + mask + bytes(c ^ mask[i % 4] for i, c in enumerate(msg)))
    buf = b''
    while True:
        a, l = rd(2); n = l & 0x7f
        if n == 126: n = struct.unpack('>H', rd(2))[0]
        elif n == 127: n = struct.unpack('>Q', rd(8))[0]
        pl = rd(n)
        if a & 0xf in (0, 1):
            buf += pl
            if a & 0x80:
                m = json.loads(buf); buf = b''
                if m.get('id') == 1: s.close(); return m.get('result', {}).get('result', {}).get('value')
expr = base64.b64decode(sys.argv[1]).decode()
for t in tabs():
    if call(t, 'document.visibilityState') == 'visible':
        print(json.dumps({'tab': {'url': t['url'], 'title': t['title']}, 'value': call(t, expr)})); break
else:
    print(json.dumps({'tab': None, 'value': None}))
`;

// On the desk, in DIR. `film.py get <download> <mp4>`: what W3_VIDEO fetched, or the one mp4 in it if it's a zip (the Blender mirrors carry the
// film only so, and the image has no unzip). `film.py cut <film> <out> <from s> <for s>`: no re-encode, no audio. `film.py facts <mp4>`: what the
// file's own header says, and a hash of its video bytes alone, because mp4mux stamps the time into its header and the two desks' files differ there.
const FILM_PY = String.raw`
import hashlib, json, os, shutil, struct, subprocess, sys, time, zipfile
def split(src, seconds, prefix, want):
    # splitmuxsink ends a part at the last keyframe under the limit, as ffmpeg's -ss starts at the last keyframe before it. gst-launch doesn't
    # exit at the end of this film (seen on a desk), so it stops once part want is closed, which is when the next part exists.
    p = subprocess.Popen(['gst-launch-1.0', '-q', '-e', 'filesrc', 'location=' + src, '!', 'qtdemux', 'name=d', 'd.video_0', '!', 'h264parse', '!', 'splitmuxsink', 'location=%s%%02d.mp4' % prefix, 'max-size-time=%d' % (seconds * 10**9), 'muxer-factory=mp4mux'])
    t0 = time.time(); after = '%s%02d.mp4' % (prefix, want + 1)
    while not os.path.exists(after) and p.poll() is None and time.time() - t0 < 300: time.sleep(0.2)
    done = os.path.exists(after)
    p.terminate(); p.wait()
    if not done: sys.exit('no part %d of %s after %d s' % (want, src, time.time() - t0))
    return '%s%02d.mp4' % (prefix, want)
def boxes(f):
    while True:
        h = f.read(8)
        if len(h) < 8: return
        n, kind = struct.unpack('>I4s', h); head = 8
        if n == 1: n = struct.unpack('>Q', f.read(8))[0]; head = 16
        yield kind, n - head
def facts(path):
    sha = hashlib.sha256(); moov = None
    with open(path, 'rb') as f:
        for kind, n in boxes(f):
            if kind == b'moov': moov = f.read(n)
            elif kind == b'mdat':
                left = n
                while left:
                    d = f.read(min(left, 1 << 20)); sha.update(d); left -= len(d)
                    if not d: sys.exit('short mdat')
            else: f.seek(n, 1)
    if moov is None: sys.exit('no moov box: this part was not closed')
    m = moov.find(b'mvhd'); ver = moov[m + 4]
    scale, dur = struct.unpack('>IQ', moov[m + 24:m + 36]) if ver else struct.unpack('>II', moov[m + 16:m + 24])
    s = moov.find(b'stsz'); frames = struct.unpack('>I', moov[s + 12:s + 16])[0]
    return {'seconds': round(dur / scale, 3), 'frames': frames, 'fps': round(frames * scale / dur, 2), 'videoTracks': moov.count(b'vide'), 'audioTracks': moov.count(b'soun'), 'videoBytesSha256': sha.hexdigest()}
mode = sys.argv[1]
if mode == 'get':
    src, dst = sys.argv[2:4]
    if zipfile.is_zipfile(src):
        z = zipfile.ZipFile(src); names = [n for n in z.namelist() if n.lower().endswith('.mp4') and not n.startswith('__MACOSX')]
        if len(names) != 1: sys.exit('expected one mp4 in the zip, found %r' % names)
        with z.open(names[0]) as f, open(dst, 'wb') as g: shutil.copyfileobj(f, g, 1 << 20)
    else: os.replace(src, dst)
elif mode == 'cut':
    film, out, start, secs = sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
    tail = split(film, start, 'a', 1)
    began = facts('a00.mp4')['seconds']
    os.replace(split(tail, secs, 'b', 0), out)
    print('began at %.3f s' % began)
else:
    print(json.dumps(facts(sys.argv[2])))
`;

export const FILES: Record<string, string> = { 'report.js': REPORT_JS, 'scroll.html': SCROLL_HTML, 'article.html': ARTICLE_HTML, 'nonlatin.html': NONLATIN_HTML, 'latency.html': LATENCY_HTML, 'motion.html': MOTION_HTML, 'video.html': VIDEO_HTML, 'typing.html': TYPING_HTML, 'targets.html': TARGETS_HTML, 'serve.py': SERVE_PY, 'cdp.py': CDP_PY, 'film.py': FILM_PY };

// A run that's killed (a tool's time limit, Ctrl-C) never reaches its `finally`, and leaves its own tab on one of these pages and the
// server up. Seen on the temporary desk: video.html looping the clip for most of an hour, more than half a core, under the next run. So each
// run first closes any tab still on this server, which only W3 opens, and says how many.
const CLOSE_LEFTOVERS = `curl -s -m 5 http://127.0.0.1:9222/json/list | python3 -I -c 'import json, sys, urllib.request
n = 0
for t in json.load(sys.stdin):
    if t.get("type") == "page" and t.get("url", "").startswith("http://127.0.0.1:${PORT}/"):
        urllib.request.urlopen("http://127.0.0.1:9222/json/close/" + t["id"], timeout=5).read(); n += 1
print("LEFTOVER_TABS=%d" % n)' || echo LEFTOVER_TABS=0`;

/** Returns how many tabs a cut-off run had left on these pages, now closed. */
export async function deployPages(desk: TestDesk): Promise<number> {
  const left = Number(/LEFTOVER_TABS=(\d+)/.exec(await desk.run(CLOSE_LEFTOVERS))?.[1] ?? 0);
  await desk.run(`set -e; systemctl stop ${UNIT} 2>/dev/null || true; systemctl reset-failed ${UNIT} 2>/dev/null || true; rm -rf ${DIR}; install -d -m 755 ${DIR} ${DIR}/media; echo ok`);
  // In a few commands, so no one of them nears Run Command's size limit.
  let batch = '';
  const flush = async () => { if (batch) await desk.run(`set -e\n${batch}echo ok`); batch = ''; };
  for (const [name, body] of Object.entries(FILES)) {
    batch += `echo ${Buffer.from(body).toString('base64')} | base64 -d > ${DIR}/${name}\n`;
    if (batch.length > 16_000) await flush();
  }
  await flush();
  const out = await desk.run(`set -e; chmod 644 ${DIR}/*.*; systemd-run --quiet --collect --unit=${UNIT} --uid=65534 --gid=65534 /usr/bin/python3 -I ${DIR}/serve.py ${PORT} ${DIR}; sleep 1; curl -s -m 3 -o /dev/null -w 'HTTP=%{http_code}' http://127.0.0.1:${PORT}/targets.html`);
  if (!out.includes('HTTP=200')) throw new Error(`the page server on the desk did not answer: ${out.slice(0, 200)}`);
  return left;
}

export async function removePages(desk: TestDesk): Promise<void> {
  await desk.run(`systemctl stop ${UNIT} 2>/dev/null || true; systemctl reset-failed ${UNIT} 2>/dev/null || true; rm -rf ${DIR}; echo removed`);
}

export interface Clip { kind: 'generated' | 'url' | 'failed' | 'off'; source?: string; sha256?: string; bytes?: number; tookS?: number; error?: string; cut?: string; facts?: { seconds: number; frames: number; fps: number; videoTracks: number; audioTracks: number; videoBytesSha256: string } }

/**
 * A 1080p60 H.264 clip for the video page. `W3_VIDEO=<https url of an mp4, or a zip holding one>` plays real footage, cut as the real-stack
 * report cut Big Buck Bunny: 60 s from the last keyframe at or before 2:00, with no audio and no re-encode. Failing that it's a failed clip,
 * not another one. `gen` makes a synthetic clip with the desk's own GStreamer instead: harder to encode than real footage, and it has never run.
 */
export async function makeClip(desk: TestDesk, video: string): Promise<Clip> {
  if (video === 'off') return { kind: 'off' };
  const out = `${DIR}/media/clip.mp4`;
  const env = `HOME=${DIR} GST_REGISTRY_1_0=${DIR}/registry.bin`;
  const gst = `videotestsrc pattern=zone-plate kx2=8 ky2=5 kt=1 num-buffers=600 ! video/x-raw,width=1920,height=1080,framerate=60/1,format=I420 ! x264enc bitrate=8000 speed-preset=superfast threads=2 key-int-max=120 bframes=0 ! h264parse ! mp4mux faststart=true ! filesink location=${out}`;
  const get = video === 'gen'
    ? `${env} gst-launch-1.0 -q -e ${gst}`
    : `curl -fsSL --max-time 900 --max-filesize 2000000000 -o film.dl '${video}' && python3 -I film.py get film.dl film.mp4 && ${env} python3 -I film.py cut film.mp4 ${out} 120 60 && rm -f a0*.mp4 b0*.mp4 film.mp4 film.dl`;
  const t0 = Date.now();
  try {
    const r = await desk.run(`set -e; cd ${DIR}; if ! { ${get}; } > clip.log 2>&1; then tail -5 clip.log >&2; exit 1; fi; chmod 644 ${out}; stat -c %s ${out}; sha256sum ${out} | cut -d' ' -f1; python3 -I film.py facts ${out} || echo null; tail -1 clip.log`, 900);
    const [bytes, sha256, facts, cut] = r.trim().split('\n');
    return { kind: video === 'gen' ? 'generated' : 'url', source: video === 'gen' ? gst : video, bytes: Number(bytes), sha256, tookS: Math.round((Date.now() - t0) / 1000), cut, facts: JSON.parse(facts ?? 'null') ?? undefined };
  } catch (e) {
    return { kind: 'failed', source: video === 'gen' ? gst : video, error: String(e).slice(0, 300) };
  }
}

// On ma-desk-0.2.2, the 9222 rule rejects the kernel's closing packets, so each finished connection sits in LAST-ACK on Chromium's side
// for about 100 s (image/RELEASES.md, fixed in 0.2.3). A capture opens a few a second; at 1600x900 a connect timed out twice with 20 of
// them waiting. So a connection that fails is tried again after they've had time to clear. Every call here only reads, or scrolls to
// the same words again.
export async function cdpEval<T>(desk: TestDesk, expression: string): Promise<{ tab: { url: string; title: string } | null; value: T | null }> {
  let out = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 30_000));
    out = await desk.run(`python3 -I ${DIR}/cdp.py ${Buffer.from(expression).toString('base64')} 2>&1 | tail -3`, 60);
    try { return JSON.parse(out.trim().split('\n').pop()!); } catch { /* try again */ }
  }
  throw new Error(`CDP on the desk, 4 tries: ${out.slice(0, 200)}`);
}

// ---- Read from a real page, in the tab on screen ----
export interface PageInfo { title: string; url: string; textStart: string; textLength: number; lang: string; iw: number; ih: number; dpr: number; sw: number; sh: number; scrollHeight: number; readyState: string }
const pageInfo = (): PageInfo => {
  const t = (document.body && document.body.innerText) || '';
  return { title: document.title, url: location.href, textStart: t.replace(/\s+/g, ' ').slice(0, 400), textLength: t.length, lang: document.documentElement.lang, iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio, sw: screen.width, sh: screen.height, scrollHeight: document.documentElement.scrollHeight, readyState: document.readyState };
};

export interface Anchor { anchor: string; x: number; y: number; w: number; h: number; bx: number; fontPx: number; fontFamily: string; color: string; tag: string; scrollY: number }
/**
 * A run of text, moved to the middle of the screen, and where it now is. `want` finds the same words again on the other desk;
 * with none, it picks them: `small` the first of the smallest text at 9 px or more, `body` the first at the size with the most text.
 * Scrolling the tab is the only change this makes to a page.
 */
const anchorOf = (want: string | null, mode: string, scroll: boolean): Anchor | null => {
  const own = (el: Element) => [...el.childNodes].filter((n) => n.nodeType === 3 && (n.nodeValue ?? '').trim().length >= 24);
  const seen = (el: Element) => { const r = el.getBoundingClientRect(), c = getComputedStyle(el); return r.width > 0 && r.height > 0 && c.visibility !== 'hidden' && c.display !== 'none'; };
  const size = (el: Element) => parseFloat(getComputedStyle(el).fontSize);
  let node: Node | null = null;
  if (want) {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) if ((walk.currentNode.nodeValue ?? '').includes(want) && walk.currentNode.parentElement && seen(walk.currentNode.parentElement)) { node = walk.currentNode; break; }
  } else {
    const els = [...document.body.querySelectorAll('p,li,td,dd,dt,span,a,div,pre,blockquote,figcaption,small,cite')].filter((e) => own(e).length && seen(e));
    let pick: Element | undefined;
    if (mode === 'small') pick = els.filter((e) => size(e) >= 9).sort((a, b) => size(a) - size(b))[0];
    else {
      const chars = new Map<number, number>();
      for (const e of els) chars.set(size(e), (chars.get(size(e)) ?? 0) + (own(e)[0].nodeValue ?? '').length);
      const best = [...chars].sort((a, b) => b[1] - a[1])[0]?.[0];
      pick = els.find((e) => size(e) === best);
    }
    if (pick) node = own(pick)[0];
  }
  if (!node || !node.parentElement) return null;
  const text = node.nodeValue ?? '';
  const lead = text.length - text.trimStart().length;
  const anchor = want ?? text.slice(lead, lead + 32);
  const at = text.indexOf(anchor);
  if (scroll) node.parentElement.scrollIntoView({ block: 'center', behavior: 'instant' });
  const range = document.createRange();
  range.setStart(node, at); range.setEnd(node, at + anchor.length);
  const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
  const c = getComputedStyle(node.parentElement);
  // Where the words' block starts: small words often end a line (a link's site name), and a crop that starts at them is mostly empty.
  const bx = (node.parentElement.closest('p,li,td,th,dd,dt,pre,blockquote,figcaption,h1,h2,h3,h4,h5,h6') ?? node.parentElement).getBoundingClientRect().left;
  return { anchor, x: r.left, y: r.top, w: r.width, h: r.height, bx: Math.min(bx, r.left), fontPx: parseFloat(c.fontSize), fontFamily: c.fontFamily.slice(0, 120), color: c.color, tag: node.parentElement.tagName, scrollY };
};
/** `scroll` moves the words to the middle of the screen first; without it, this only reads where they are now. */
export const callAnchor = (want: string | null, mode: string, scroll = true) => `(${anchorOf.toString()})(${JSON.stringify(want)},${JSON.stringify(mode)},${scroll})`;
export const callInfo = `(${pageInfo.toString()})()`;

const WALL = /just a moment|attention required|are you (a )?human|verify you are human|captcha|access denied|request blocked|not a bot|unusual traffic|403 forbidden|429 too many|too many requests|enable javascript|enable cookies/i;
export function whyNotUsable(i: PageInfo | null): string | null {
  if (!i) return 'no tab on screen';
  if (!/^https?:/.test(i.url)) return `did not load: ${i.url.slice(0, 80)}`;
  if (WALL.test(i.title) || WALL.test(i.textStart)) return `looks like a bot wall or a refusal: "${i.title.slice(0, 80)}"`;
  if (i.textLength < 400) return `almost no text (${i.textLength} characters)`;
  return null;
}
