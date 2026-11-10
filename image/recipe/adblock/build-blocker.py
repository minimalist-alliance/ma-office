#!/usr/bin/python3 -I
"""build-blocker.py: the desk Browser's ad and tracker blocker, built from uBlock Origin Lite's pinned release (ADR 0076).

  build-blocker.py build <out-dir> [--zip <path>]   the CRX, its update manifest and its id, from blocker.pin
  build-blocker.py diff <old.zip> <new.zip>         what a pin change would change in the rules, for the reviewed diff

The release is fetched from blocker.pin's URL (or read from --zip) and must match the pin's sha256. Of it, only the rules
of the lists uBOL turns on by default are used, and of those only the block and allow rules: no redirect (a rewrite), no
modifyHeaders (one of uBOL's removes Set-Cookie), and none of its scripts, scriptlets or cosmetic filters. The extension
is this directory's worker.js and managed_storage.json around them, with only the declarativeNetRequest and storage
permissions and no host permissions, so Chromium itself keeps it off every page, cookie, storage and header.

It's signed with a key made here and destroyed here, so each build has its own id: a new image reinstalls it, which loses
nothing (it keeps nothing of the member's). Out: ma-blocker.crx, update.xml (served as file:// to Chromium, which updates
only from there: a new version is a new image), blocker-id, blocker.json (what went in)."""
import base64, collections, hashlib, io, json, os, re, shutil, struct, subprocess, sys, tempfile, time, urllib.error, urllib.request, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SHARE = '/usr/share/ma/adblock'
KEEP = ('block', 'allow')
SITE_ALLOW = 'ma-site-allow'   # our own ruleset: site-allow.json, as allow rules above every block rule (below)
ALLOW_PRIORITY = 100000        # uBOL's own rules sit at 10, 30 and 40; the member's per-site switch (worker.js) at 1,000,000
FIXED_TIME = (2026, 1, 1, 0, 0, 0)


def pin():
    out = {}
    for line in open(os.path.join(HERE, 'blocker.pin')):
        line = line.strip()
        if line and not line.startswith('#'):
            k, v = line.split('=', 1)
            out[k] = v
    return out


def fetch(url, tries=5):
    """The release, over https, retried: GitHub's download answers 5xx now and then (a test bake failed on a 504). Whatever
    comes back is checked against the pin's sha256 by the caller, so a retry can't change what is accepted."""
    for i in range(1, tries + 1):
        try:
            return urllib.request.urlopen(url, timeout=120).read()
        except (urllib.error.URLError, OSError) as e:
            if i == tries:
                sys.exit(f'build-blocker: {url}: {e} after {tries} tries')
            print(f'build-blocker: {url}: {e}; try {i + 1} of {tries} in {5 * i} s', file=sys.stderr)
            time.sleep(5 * i)


def release(p, path=None):
    data = open(path, 'rb').read() if path else fetch(p['url'])
    got = hashlib.sha256(data).hexdigest()
    if got != p['sha256']:
        sys.exit(f"build-blocker: the release's sha256 is {got}, the pin says {p['sha256']}: refusing")
    return zipfile.ZipFile(io.BytesIO(data))


def default_rules(z):
    """{ruleset id: [rules kept]}, and counts of what was dropped, for the lists uBOL enables by default."""
    m = json.loads(z.read('manifest.json'))
    kept, dropped = {}, collections.Counter()
    for r in m['declarative_net_request']['rule_resources']:
        if not r.get('enabled'):
            continue
        rules = json.loads(z.read(r['path'].lstrip('/')))
        kept[r['id']] = [x for x in rules if x.get('action', {}).get('type') in KEEP]
        dropped.update(x.get('action', {}).get('type') for x in rules if x.get('action', {}).get('type') not in KEEP)
    return m, kept, dropped


def site_allow_rules(path=None):
    """site-allow.json as declarativeNetRequest `allow` rules, nothing else. Each entry is one narrow exception: the pages of
    `sites` (and nobody else's) may make requests that match `urlFilter`, an exact host and path, so a page's own test of
    whether it is being blocked is answered, without letting the rest of that host through. Anything looser is refused here.
    Entries: {"sites": [hosts], "urlFilter": "||host/path", "why": "..."}; "why" is for the reviewer and doesn't ship."""
    path = path or os.path.join(HERE, 'site-allow.json')
    entries = json.load(open(path))
    host = re.compile(r'^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$')
    out = []
    for i, e in enumerate(entries, 1):
        if set(e) != {'sites', 'urlFilter', 'why'} or not e['why'].strip():
            sys.exit(f'build-blocker: {path} entry {i} needs exactly sites, urlFilter and why')
        if not e['sites'] or not all(isinstance(h, str) and host.match(h) for h in e['sites']):
            sys.exit(f'build-blocker: {path} entry {i}: sites are plain host names')
        m = re.fullmatch(r'\|\|([a-z0-9.-]+)(/[A-Za-z0-9._~/-]+)', e['urlFilter'])
        if not m or not host.match(m.group(1)) or m.group(2) == '/':
            sys.exit(f'build-blocker: {path} entry {i}: urlFilter is ||host/path, an exact request, with no wildcard')
        out.append({'id': i, 'priority': ALLOW_PRIORITY, 'action': {'type': 'allow'},
                    'condition': {'urlFilter': e['urlFilter'], 'initiatorDomains': sorted(e['sites'])}})
    return out


def varint(n):
    out = b''
    while True:
        b = n & 0x7F
        n >>= 7
        out += bytes([b | (0x80 if n else 0)])
        if not n:
            return out


def field(num, data):
    return varint((num << 3) | 2) + varint(len(data)) + data


def deterministic_zip(src):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in os.walk(src):
            dirs.sort()
            for f in sorted(files):
                p = os.path.join(root, f)
                info = zipfile.ZipInfo(os.path.relpath(p, src), FIXED_TIME)
                info.external_attr = 0o644 << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(info, open(p, 'rb').read())
    return buf.getvalue()


def crx3(archive, tmp):
    """A CRX3 of archive, signed with a fresh RSA key that's removed before this returns. (crx bytes, extension id)"""
    key = os.path.join(tmp, 'key.pem')
    old = os.umask(0o077)
    try:
        subprocess.run(['openssl', 'genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', key],
                       check=True, capture_output=True)
        pub = subprocess.run(['openssl', 'pkey', '-in', key, '-pubout', '-outform', 'DER'], check=True,
                             capture_output=True).stdout
        crx_id = hashlib.sha256(pub).digest()[:16]
        signed_data = field(1, crx_id)
        msg = os.path.join(tmp, 'msg')
        open(msg, 'wb').write(b'CRX3 SignedData\x00' + struct.pack('<I', len(signed_data)) + signed_data + archive)
        sig = subprocess.run(['openssl', 'dgst', '-sha256', '-sign', key, msg], check=True, capture_output=True).stdout
    finally:
        os.umask(old)
        for f in (key, os.path.join(tmp, 'msg')):
            if os.path.exists(f):
                with open(f, 'r+b') as h:
                    h.write(b'\0' * os.path.getsize(f))
                os.unlink(f)
    header = field(2, field(1, pub) + field(2, sig)) + field(10000, signed_data)
    ext_id = ''.join(chr(ord('a') + int(c, 16)) for c in crx_id.hex())
    return b'Cr24' + struct.pack('<II', 3, len(header)) + header + archive, ext_id, base64.b64encode(pub).decode()


def build(out, zip_path=None):
    p = pin()
    z = release(p, zip_path)
    um, kept, dropped = default_rules(z)
    if um['version'] != p['version']:
        sys.exit(f"build-blocker: the release says version {um['version']}, the pin {p['version']}")
    tmp = tempfile.mkdtemp(prefix='ma-blocker-')
    try:
        ext = os.path.join(tmp, 'ext')
        os.makedirs(os.path.join(ext, 'rules'))
        kept[SITE_ALLOW] = site_allow_rules()
        for rid, rules in kept.items():
            json.dump(rules, open(os.path.join(ext, 'rules', rid + '.json'), 'w'), separators=(',', ':'))
        for f in ('worker.js', 'managed_storage.json'):
            shutil.copy(os.path.join(HERE, f), os.path.join(ext, f))
        open(os.path.join(ext, 'NOTICE.txt'), 'w').write(
            'The rules in rules/ are the block and allow rules of uBlock Origin Lite %s (GPLv3, https://github.com/uBlockOrigin/uBOL-home), '
            'built from its lists (uBlock filters, EasyList, EasyPrivacy, Peter Lowe\'s, uBlock badware, URLhaus; each under its own licence) '
            'by Minimalist Alliance, ma-desk image/recipe/adblock/build-blocker.py. Release %s, sha256 %s.\n' % (p['version'], p['url'], p['sha256']))
        manifest = {
            'manifest_version': 3,
            'name': 'Minimalist Alliance blocker',
            'version': p['version'],
            'description': "Blocks ads and trackers on the desk's Browser: network rules only.",
            'minimum_chrome_version': um.get('minimum_chrome_version', '120'),
            'permissions': ['declarativeNetRequest', 'storage'],
            'background': {'service_worker': 'worker.js'},
            'storage': {'managed_schema': 'managed_storage.json'},
            'declarative_net_request': {'rule_resources': [
                {'id': rid, 'enabled': True, 'path': 'rules/%s.json' % rid} for rid in kept]},
        }
        json.dump(manifest, open(os.path.join(ext, 'manifest.json'), 'w'), indent=1, sort_keys=True)
        archive = deterministic_zip(ext)
        crx, ext_id, pub = crx3(archive, tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(out, exist_ok=True)
    open(os.path.join(out, 'ma-blocker.crx'), 'wb').write(crx)
    open(os.path.join(out, 'update.xml'), 'w').write(
        "<?xml version='1.0' encoding='UTF-8'?>\n<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n"
        "  <app appid='%s'>\n    <updatecheck codebase='file://%s/ma-blocker.crx' version='%s' />\n  </app>\n</gupdate>\n"
        % (ext_id, SHARE, p['version']))
    open(os.path.join(out, 'blocker-id'), 'w').write(ext_id + '\n')
    info = {'id': ext_id, 'version': p['version'], 'release_sha256': p['sha256'],
            'crx_sha256': hashlib.sha256(crx).hexdigest(), 'public_key': pub,
            'rules': {rid: len(r) for rid, r in kept.items()}, 'dropped': dict(dropped), 'site_allow': kept[SITE_ALLOW]}
    json.dump(info, open(os.path.join(out, 'blocker.json'), 'w'), indent=1, sort_keys=True)
    print(json.dumps(info))


def diff(old, new):
    _, a, _ = default_rules(zipfile.ZipFile(old))
    _, b, _ = default_rules(zipfile.ZipFile(new))
    for rid in sorted(set(a) | set(b)):
        sa = {json.dumps({k: v for k, v in r.items() if k != 'id'}, sort_keys=True) for r in a.get(rid, [])}
        sb = {json.dumps({k: v for k, v in r.items() if k != 'id'}, sort_keys=True) for r in b.get(rid, [])}
        print(f'{rid}: {len(sa)} -> {len(sb)} rules, {len(sb - sa)} added, {len(sa - sb)} removed')
        for r in sorted(sb - sa)[:200]:
            print('  + ' + r[:300])
        for r in sorted(sa - sb)[:200]:
            print('  - ' + r[:300])


if __name__ == '__main__':
    a = sys.argv[1:]
    if a[:1] == ['build'] and len(a) in (2, 4) and (len(a) == 2 or a[2] == '--zip'):
        build(a[1], a[3] if len(a) == 4 else None)
    elif a[:1] == ['diff'] and len(a) == 3:
        diff(a[1], a[2])
    else:
        sys.exit(__doc__)
