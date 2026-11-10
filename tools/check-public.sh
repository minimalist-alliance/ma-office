#!/usr/bin/env bash
# tools/check-public.sh: stops personal information and secrets from reaching this public repository.
#
#   tools/check-public.sh              scan the working tree: tracked files plus untracked ones that aren't ignored
#   tools/check-public.sh --rev REV    scan one commit: its tree, its message, its author and committer
#   tools/check-public.sh --help
#
# As a pre-push hook it scans every commit being pushed (tree, message and identities):
#   ln -sf ../../tools/check-public.sh .git/hooks/pre-push
#
# It fails (exit 1) on:
#   identity    a private name, email, login or host name (see "Private identities" below), in content or paths
#   home-path   /home/<user>, /Users/<user> or C:\Users\<user>, other than generic system users
#   private-ip  RFC 1918 addresses (10/8, 172.16/12, 192.168/16) other than whole-range CIDRs such as 10.0.0.0/8
#   public-ip   routable IPv4 addresses other than documentation ranges and well-known public DNS resolvers
#   aws-account 12-digit numbers (cloud account IDs), other than documented placeholders
#   aws-id      instance, volume, image, snapshot and network IDs (i-, vol-, ami-, snap-, sg-, subnet-, vpc-, eni-)
#   desk-id     desk IDs (d- and 12 letters or digits)
#   key         private key blocks and cloud, Stripe, GitHub, Slack, Google, npm, xAI, OpenAI and Anthropic key shapes,
#               JWTs, credentials in URLs and literal passwords or secrets
#   email       any email address except support@..., noreply@... and ...@example.* (or *.example)
#   image-meta  images with GPS or camera EXIF/XMP data, and camera originals (HEIC, RAW, MOV) it can't check
#   business    private business numbers: a dollar figure beside "per member", "a guild", "margin", "profit" and the
#               like (or in a Markdown table whose header names members with costs, prices or $), a share of a
#               membership price, a spending cap or dial in dollars, and pointers to the private cost model
#
# Binary files are scanned as printable strings; tarballs and zips are opened and each member is scanned.
# Matched values are never printed: output is path:line: rule. Exit 0 is clean, 1 is a hit, 2 is a usage or
# configuration error.
#
# Private identities. The names and addresses to refuse are never written in this repository. They are read at run
# time from:
#   - the git history of a private repository: git config checkpublic.identityRepo <path> (or CHECK_PUBLIC_IDENTITY_REPO).
#     Every author and committer whose email isn't a noreply, support or example address counts, with their name.
#   - a private list, one term per line: git config checkpublic.termsFile <path> (or CHECK_PUBLIC_TERMS).
#   - this machine: the login, its full name, the host name, and the global git identity unless it's a noreply one.
# A configured source that can't be read is an error (exit 2), so a hook never passes by accident.
#
# Reviewed exceptions live in tools/check-public.allow: rule<TAB>path-glob<TAB>reason. Identity hits can't be allowed.
# Images need Python's Pillow; without it, images are reported as unchecked and the scan fails.
set -euo pipefail

IFS= read -r -d '' PY <<'PYEOF' || true
import fnmatch, getpass, io, os, pwd, re, socket, subprocess, sys

ARGV0 = os.environ.get('CHECK_PUBLIC_ARGV0', 'check-public.sh')
HOOK = os.path.basename(ARGV0) == 'pre-push'


def die(msg, code=2):
    print('check-public: ' + msg, file=sys.stderr)
    sys.exit(code)


def git(*args, cwd=None, check=True, binary=False):
    p = subprocess.run(['git', *args], cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and p.returncode != 0:
        die('git %s failed: %s' % (' '.join(args[:2]), p.stderr.decode(errors='replace').strip()))
    return p.stdout if binary else p.stdout.decode(errors='replace')


ROOT = git('rev-parse', '--show-toplevel').strip()
os.chdir(ROOT)

# ------------------------------------------------------------------ arguments

rev = None
args = sys.argv[1:]
if HOOK:
    args = []
while args:
    a = args.pop(0)
    if a in ('-h', '--help'):
        print(open(os.path.join(ROOT, 'tools', 'check-public.sh')).read().split('set -euo')[0])
        sys.exit(0)
    elif a == '--rev' and args:
        rev = args.pop(0)
    else:
        die('unknown argument (see --help)')

# ------------------------------------------------------------------ allowed addresses and generic users

ALLOWED_LOCAL = {'support', 'noreply'}
UNIT_SUFFIXES = {'service', 'socket', 'timer', 'target', 'mount', 'automount', 'slice', 'path', 'scope', 'device', 'swap'}
GENERIC_USERS = {'admin', 'ubuntu', 'debian', 'ec2-user', 'user', 'runner', 'node', 'root', 'desk', 'neko',
                 'linuxbrew', 'vscode', 'me', 'you', 'username', 'someone', 'jdoe'}


def email_allowed(addr):
    local, _, domain = addr.lower().rpartition('@')
    if local in ALLOWED_LOCAL:
        return True
    labels = domain.split('.')
    if 'example' in labels:  # example.com, example.org, mail.example.com, desk.example
        return True
    return False


def meta_email_allowed(addr):
    return email_allowed(addr) or addr.lower().endswith('@users.noreply.github.com')

# ------------------------------------------------------------------ private identities, read at run time

terms = []  # (rule, term, kind) kind: 'name' (left boundary) or 'plain'
sources = []


def add_name(name):
    name = (name or '').strip()
    if not name or name.lower() in ('minimalist alliance',):
        return
    if ' ' in name:
        terms.append(('identity', name, 'plain'))
    for tok in re.findall(r'[A-Za-z]{3,}', name):
        terms.append(('identity', tok, 'name'))


def add_plain(t):
    t = (t or '').strip()
    if len(t) >= 4:
        terms.append(('identity', t, 'plain'))


def add_email(e):
    e = (e or '').strip()
    if not e or meta_email_allowed(e):
        return
    add_plain(e)
    add_plain(e.split('@')[0])


def config(key, env):
    v = os.environ.get(env) or git('config', '--get', key, check=False).strip()
    return os.path.expanduser(v) if v else ''


repo = config('checkpublic.identityRepo', 'CHECK_PUBLIC_IDENTITY_REPO')
if repo:
    if not os.path.isdir(repo):
        die('identity repository %s is configured but not found' % 'checkpublic.identityRepo')
    out = git('-C', repo, 'log', '--all', '--format=%an%x09%ae%x09%cn%x09%ce', check=False)
    if not out.strip():
        die('identity repository has no readable history')
    seen = set()
    for line in out.splitlines():
        f = line.split('\t')
        for name, mail in ((f[0], f[1]), (f[2], f[3])) if len(f) == 4 else ():
            if (name, mail) in seen:
                continue
            seen.add((name, mail))
            if not meta_email_allowed(mail):
                add_name(name)
                add_email(mail)
    sources.append('identity repository')

tfile = config('checkpublic.termsFile', 'CHECK_PUBLIC_TERMS')
if tfile:
    try:
        for line in open(tfile, encoding='utf-8'):
            line = line.strip()
            if line and not line.startswith('#'):
                add_plain(line)
    except OSError:
        die('terms file is configured but unreadable')
    sources.append('terms file')

try:
    login = getpass.getuser()
except Exception:
    login = ''
if login and login.lower() not in GENERIC_USERS:
    add_plain(login)
    try:
        add_name(pwd.getpwnam(login).pw_gecos.split(',')[0])
    except KeyError:
        pass
host = socket.gethostname().split('.')[0]
if host and host.lower() not in ('localhost', 'ubuntu', 'debian', 'runner') and len(host) >= 4:
    add_plain(host)
gname = git('config', '--global', '--get', 'user.name', check=False).strip()
global_email = git('config', '--global', '--get', 'user.email', check=False).strip()
if global_email and not meta_email_allowed(global_email):
    add_name(gname)
    add_email(global_email)
sources.append('this machine')

# Dedupe, longest first. Words that are too common to be a name on their own are skipped as single tokens.
COMMON = {'the', 'and', 'desk', 'office', 'user', 'admin', 'owner', 'team'}
uniq = {}
for rule, t, kind in terms:
    if kind == 'name' and t.lower() in COMMON:
        continue
    k = (t.lower(), kind)
    uniq.setdefault(k, (rule, t, kind))
terms = sorted(uniq.values(), key=lambda x: -len(x[1]))
TERM_RES = [(rule, re.compile(re.escape(t), re.I), kind) for rule, t, kind in terms]


def identity_hits(s):
    hits = set()
    for rule, rx, kind in TERM_RES:
        for m in rx.finditer(s):
            if kind == 'name':
                i = m.start()
                prev = s[i - 1] if i > 0 else ''
                if prev.isalpha() and not (prev.islower() and s[i].isupper()):
                    continue  # inside another word; camelCase still counts
            hits.add(rule)
            break
    return hits

# ------------------------------------------------------------------ text rules

HOME = re.compile(r'(?:/home/|/Users/|[Cc]:\\\\?Users\\\\?)([A-Za-z0-9._-]+)')
IPV4 = re.compile(r'(?<![\d.])((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})(?!\.?\d)(/\d{1,2})?')
ACCOUNT = re.compile(r'(?<![0-9A-Za-z.])(\d{12})(?![0-9A-Za-z])')
AWSID = re.compile(r'\b(i|vol|ami|snap|eni|sg|subnet|vpc|igw|rtb|eipalloc|nat|lt|fs)-([0-9a-f]{8}|[0-9a-f]{17})\b')
DESKID = re.compile(r'(?<![A-Za-z0-9_-])d-([a-z0-9]{12})(?![A-Za-z0-9_-])')
EMAIL = re.compile(r'(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})(?![A-Za-z0-9-])')
PEM_PRIVATE = re.compile(r'-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----')
KEYS = [
    re.compile(r'\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|APKA)[0-9A-Z]{16}\b'),
    re.compile(r'(?i)aws.{0,20}secret.{0,20}[=:]\s*["\']?[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])'),
    re.compile(r'\bxai-[A-Za-z0-9]{20,}'),
    re.compile(r'\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}'),
    re.compile(r'\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{10,}'),
    re.compile(r'\bwhsec_[0-9A-Za-z]{20,}'),
    re.compile(r'\bgh[pousr]_[A-Za-z0-9]{30,}'),
    re.compile(r'\bgithub_pat_[A-Za-z0-9_]{40,}'),
    re.compile(r'\bxox[abprs]-[A-Za-z0-9-]{10,}'),
    re.compile(r'\bAIza[0-9A-Za-z_-]{35}\b'),
    re.compile(r'\bnpm_[A-Za-z0-9]{36}\b'),
    re.compile(r'\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'),
    re.compile(r'\bhooks\.slack\.com/services/T[A-Za-z0-9]+/B[A-Za-z0-9]+/[A-Za-z0-9]+'),
]
URLCRED = re.compile(r'\b[a-z][a-z0-9+.-]*://([^/\s:@"\'<>]+):([^/\s@"\'<>]+)@[^\s/]')
SECRET_ASSIGN = re.compile(
    r'(?i)\b(?:password|passwd|pwd|passphrase|secret|client_secret|api[_-]?key|access[_-]?key|auth[_-]?token|token)'
    r'["\']?\s*[:=]\s*["\']([^"\'\s]{8,})["\']')
PLACEHOLDER = re.compile(r'(?i)example|placeholder|changeme|change-me|xxxx|dummy|fake|redacted|sample|not-a-|your[-_]|'
                         r'^\*+$|^\.+$|\$\{|\{\{|<[a-z_-]+>|test|local-dev|dev-only|insecure|not-the|not-real|stand-in|'
                         r'revoked|canary|another|abcdefgh|0123456789|00000|[-_]$')

DOC_NETS = [((192, 0, 2), 24), ((198, 51, 100), 24), ((203, 0, 113), 24), ((192, 0, 0), 24)]
RESOLVERS = {'1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9', '149.112.112.112', '208.67.222.222'}
ACCOUNT_PLACEHOLDERS = {'000000000000', '123456789012', '111122223333', '999999999999', '111111111111',
                        '210987654321', '444455556666', '123412341234'}
# Publishers of official public images, named in docs and image filters: Debian, Canonical, Amazon.
PUBLIC_OWNERS = {'136693071363', '099720109477', '137112412989'}


SEQUENCES = ('01234567', '12345678', '0123abcd', 'abcdef', 'fedcba', '76543210', '0a1b2c3d', 'deadbeef', 'abc1234')


def is_placeholder_hex(h):
    """Made-up IDs: few distinct characters, or a plain sequence. Real IDs are random hex."""
    return len(set(h)) <= 3 or any(q in h for q in SEQUENCES)


DESK_WORDS = ('test', 'example', 'abcdef', 'zyxwvu', 'verify', 'fake', 'mock', 'demo', 'sample', 'placeholder')


def is_placeholder_desk(v):
    """Made-up desk IDs: few distinct characters, a run of four, or a word no random ID holds."""
    return len(set(v)) <= 3 or re.search(r'(.)\1\1\1', v) is not None or any(w in v for w in DESK_WORDS)


def ip_rule(ip, cidr):
    o = [int(x) for x in ip.split('.')]
    if o[0] == 10 or (o[0] == 172 and 16 <= o[1] <= 31) or (o[0] == 192 and o[1] == 168):
        if cidr:
            bits = int(cidr[1:])
            n = (o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]
            if bits <= 32 and n & ((1 << (32 - bits)) - 1) == 0 and bits <= 24:
                return None  # a whole range, such as 10.0.0.0/8 or 172.31.0.0/16
        return 'private-ip'
    if o[0] in (0, 127) or o[0] >= 224 or (o[0] == 169 and o[1] == 254) or (o[0] == 100 and 64 <= o[1] <= 127):
        return None
    if o[0] == 255 or ip.startswith('255.'):
        return None
    for net, _ in DOC_NETS:
        if tuple(o[:3]) == net:
            return None
    if ip in RESOLVERS:
        return None
    if o == [1, 2, 3, 4] or o[1:] == [0, 0, 0]:
        return None
    if o[0] == 198 and o[1] in (18, 19):
        return None  # 198.18.0.0/15, for benchmarks
    return 'public-ip'


# Private business numbers (margins, cost per member or per guild, internal spending caps, the private cost model).
# Engineering figures stay public: list prices, fps, CPU, memory, members per host. A dollar figure is a hit when a
# member, guild or margin word is within BIZ_WINDOW characters of it.
MONEY = re.compile(r'(?<![\w$\\])\$\s?\d[\d,]*(?:\.\d+)?')
BIZ = re.compile(r'(?i)\b(?:per|a|each|every)\s+(?:paying\s+)?(?:member|founder|officer|guild|seat|subscriber)s?\b'
                 r'(?!\s+(?:tab|desk|window|session)s?\b)'
                 r'|\b(?:the\s+)?(?:typical|heavy|average|light)\s+(?:member|user)s?\b|\$\d[\d,.]*\s+members?\b'
                 r'|\bmargins?\b|\bprofits?\b|\bbreak-?even\b|\bunit economics\b|\bcogs\b'
                 r'|\b(?:for|at|with)\s+\d[\d,]*\s+members\b|\bthe\s+(?:founder|officer)\s+at\b')
BIZ_WINDOW = 50
PRICE_SHARE = re.compile(r'(?i)\b\d{1,3}(?:\.\d+)?%\s+of\s+(?:the\s+)?(?:\$\d|(?:officer|founder|alliance|member)(?:\'s)?\s+'
                         r'(?:\$|price|fee|subscription))')
COST_MODEL = re.compile(r'(?i)\bcost[- ]model(?:\.md)?\s*(?:\u00a7|section)|\bcost-model\.md\b')
SPEND_CAP = re.compile(r'(?i)\b(?:spend|spending|budget)\s+(?:is\s+)?(?:capped|cap|limit(?:ed)?)\s+(?:at\s+)?\$\d'
                       r'|\$\d[\d,.]*\s*(?:/\s*mo(?:nth)?\s+)?(?:dial|budget|spending cap|spend cap|limit\b)'
                       r'|\$\d[\d,.]*[- ]a[- ](?:day|month)[- ](?:[a-z]+[- ])?(?:guard|cap)\b')
BIZ_TABLE = re.compile(r'(?i)\bmembers?\b.*(?:\$|\bcosts?\b|\bprices?\b|\btotal\b)|(?:\$|\bcosts?\b|\bprices?\b)[^|]*\|.*\bmembers?\b')


def business_hit(line):
    if COST_MODEL.search(line) or PRICE_SHARE.search(line) or SPEND_CAP.search(line):
        return True
    for m in MONEY.finditer(line):
        if BIZ.search(line[max(0, m.start() - BIZ_WINDOW):m.end() + BIZ_WINDOW]):
            return True
    return False


def text_hits(line):
    hits = set(identity_hits(line))
    if '$' in line or '%' in line or 'cost' in line.lower():
        if business_hit(line):
            hits.add('business')
    for m in HOME.finditer(line):
        u = m.group(1)
        if u.lower() in GENERIC_USERS or u.startswith(('$', '<', '{', '%', '.')) or len(u) <= 2:
            continue
        if re.search(r'://[^\s/]+$', line[:m.start()]):
            continue  # a URL's path, such as https://docs.example.com/home/...
        hits.add('home-path')
    if '.' in line:
        for m in IPV4.finditer(line):
            before, after = line[:m.start()], line[m.end():]
            if after.startswith('.in-addr.arpa') or re.search(r'(?i)(section[- ]|§\s?|rfc\s?\d+\s)$', before):
                continue
            if re.search(r'\d:$', before) or re.match(r'-\d', after):
                continue  # a Debian package version such as 1:157.0.1.2-1
            r = ip_rule(m.group(1), m.group(2))
            if r:
                hits.add(r)
    for m in ACCOUNT.finditer(line):
        n = m.group(1)
        if n in ACCOUNT_PLACEHOLDERS or n in PUBLIC_OWNERS or re.match(r'\d0{6,}$', n):
            continue
        if re.match(r'20[2-3]\d(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])([01]\d|2[0-3])[0-5]\d$', n):
            continue  # a date and time
        if re.search(r'[0-9a-fA-F]{4}-$', line[:m.start()]):
            continue  # the last group of a UUID
        hits.add('aws-account')
    for m in AWSID.finditer(line):
        if not is_placeholder_hex(m.group(2)):
            hits.add('aws-id')
    for m in DESKID.finditer(line):
        if not is_placeholder_desk(m.group(1)):
            hits.add('desk-id')
    for m in EMAIL.finditer(line):
        e = m.group(1)
        if email_allowed(e) or e.lower() == 'git@github.com':
            continue
        if e.rsplit('.', 1)[1].lower() in UNIT_SUFFIXES:
            continue  # a systemd unit instance, such as desk-data@0.service
        if re.search(r'://[^\s/@]*:$', line[:m.start()]):
            continue  # user info in a URL (https://user:pw@host), which the key rule judges
        hits.add('email')
    if PEM_PRIVATE.search(line):
        hits.add('key')
    for rx in KEYS:
        for m in rx.finditer(line):
            body = re.sub(r'^(?:sk|rk|pk)_(?:live|test)_', '', m.group(0))  # a Stripe test key is still a secret
            if 'EXAMPLE' not in body and not PLACEHOLDER.search(body):
                hits.add('key')
    for m in URLCRED.finditer(line):
        user, pw = m.group(1), m.group(2)
        if not (PLACEHOLDER.search(pw) or pw.startswith(('$', '%')) or len(pw) < 6 or pw in ('password', 'pass', 'secret')):
            hits.add('key')
    for m in SECRET_ASSIGN.finditer(line):
        v = m.group(1)
        if PLACEHOLDER.search(v) or v.startswith(('$', '%', 'process.env', 'os.environ', 'env.')):
            continue
        if not (re.search(r'[A-Za-z]', v) and re.search(r'\d', v)):
            continue  # a word or a number, not a generated secret
        hits.add('key')
    return hits

# ------------------------------------------------------------------ images

IMAGE_EXT = {'.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.gif'}
ORIGINAL_EXT = {'.heic', '.heif', '.avif', '.dng', '.cr2', '.cr3', '.nef', '.arw', '.orf', '.rw2', '.raf', '.mov'}
CAMERA_TAGS = {271: 'Make', 272: 'Model', 42033: 'BodySerialNumber', 42034: 'LensSpecification', 42035: 'LensMake',
               42036: 'LensModel', 42037: 'LensSerialNumber', 0xA430: 'CameraOwnerName'}
XMP_BAD = re.compile(rb'exif:GPS|GPSLatitude|GPSLongitude|tiff:Make|tiff:Model|aux:SerialNumber|aux:Lens|exifEX:LensModel')
try:
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
except Exception:
    Image = None


def image_hits(path, data):
    ext = os.path.splitext(path)[1].lower()
    if ext in ORIGINAL_EXT:
        return {'image-meta'}
    if ext not in IMAGE_EXT:
        return set()
    if XMP_BAD.search(data):
        return {'image-meta'}
    if Image is None:
        return {'image-unchecked'}
    try:
        im = Image.open(io.BytesIO(data))
        ex = im.getexif()
    except Exception:
        return set()
    if 0x8825 in ex:
        try:
            if len(ex.get_ifd(0x8825)) > 0:
                return {'image-meta'}
        except Exception:
            return {'image-meta'}
    if any(t in ex for t in CAMERA_TAGS):
        return {'image-meta'}
    try:
        sub = ex.get_ifd(0x8769)
        if any(t in sub for t in CAMERA_TAGS):
            return {'image-meta'}
    except Exception:
        pass
    return set()

# ------------------------------------------------------------------ allowlist

ALLOW = []
allow_path = os.path.join(ROOT, 'tools', 'check-public.allow')
if os.path.exists(allow_path):
    for n, line in enumerate(open(allow_path, encoding='utf-8'), 1):
        line = line.rstrip('\n')
        if not line.strip() or line.startswith('#'):
            continue
        f = line.split('\t')
        if len(f) < 3 or not f[2].strip():
            die('tools/check-public.allow:%d: needs rule<TAB>path-glob<TAB>reason' % n)
        if f[0] == 'identity':
            die('tools/check-public.allow:%d: identity hits cannot be allowed' % n)
        ALLOW.append((f[0], f[1]))


def allowed(rule, path):
    return any(r == rule and fnmatch.fnmatchcase(path, g) for r, g in ALLOW)

# ------------------------------------------------------------------ scanning

found = []  # (where, rule)


def report(where, rules, path=None):
    for r in sorted(rules):
        if path is not None and r != 'identity' and allowed(r, path):
            continue
        found.append((where, r))


PRINTABLE = re.compile(rb'[\x20-\x7e]{6,}')
SELF = 'tools/check-public.sh'


ARCHIVE_EXT = ('.tgz', '.tar.gz', '.tar', '.zip', '.jar')


def scan_archive(path, data):
    """Scans each member of a tarball or zip, as path!member. A broken archive is a hit: it can't be checked."""
    import tarfile, zipfile
    try:
        if path.lower().endswith(('.zip', '.jar')):
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                for name in z.namelist():
                    if not name.endswith('/'):
                        scan_blob(path + '!' + name, z.read(name))
        else:
            with tarfile.open(fileobj=io.BytesIO(data)) as t:
                for m in t.getmembers():
                    if m.isfile():
                        scan_blob(path + '!' + m.name, t.extractfile(m).read())
    except Exception:
        report(path + ':0', {'archive-unreadable'}, path)


def scan_blob(path, data):
    if path.lower().endswith(ARCHIVE_EXT):
        scan_archive(path, data)
    report(path + ':0', identity_hits(path) | ({'home-path'} if HOME.search(path) else set()), path)
    report(path + ':0', image_hits(path, data), path)
    if path == SELF:  # its own patterns would match; only identities are checked here
        text = data.decode('utf-8', errors='replace')
        for n, line in enumerate(text.splitlines(), 1):
            report('%s:%d' % (path, n), identity_hits(line))
        return
    binary = b'\0' in data[:8192]
    if binary:
        rules = set()
        for m in PRINTABLE.finditer(data[:64 * 1024 * 1024]):
            s = m.group(0).decode('ascii')
            h = text_hits(s) & {'identity', 'home-path', 'email', 'key', 'private-ip'}
            rules |= h
        report(path + ':0', rules, path)
        return
    text = data.decode('utf-8', errors='replace')
    biz_table = prev_row = False
    for n, line in enumerate(text.splitlines(), 1):
        h = text_hits(line)
        row = line.lstrip().startswith('|')
        if row and not prev_row:  # a Markdown table's header: does it price members?
            biz_table = bool(BIZ_TABLE.search(line) or BIZ.search(line))
        prev_row = row
        if row and biz_table and MONEY.search(line):
            h.add('business')
        if h:
            report('%s:%d' % (path, n), h, path)


def scan_worktree():
    out = git('ls-files', '-z', '--cached', '--others', '--exclude-standard')
    paths = sorted(set(p for p in out.split('\0') if p))
    count = 0
    for p in paths:
        if os.path.islink(p) or not os.path.isfile(p):
            continue
        with open(p, 'rb') as fh:
            scan_blob(p, fh.read())
        count += 1
    return count


def scan_tree(commit):
    listing = git('ls-tree', '-r', '-z', '--full-tree', commit)
    entries = []
    for e in listing.split('\0'):
        if not e:
            continue
        meta, path = e.split('\t', 1)
        mode, typ, sha = meta.split()
        if typ == 'blob' and mode != '120000':
            entries.append((path, sha))
    if not entries:
        return 0
    p = subprocess.Popen(['git', 'cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    for path, sha in entries:
        p.stdin.write((sha + '\n').encode())
        p.stdin.flush()
        header = p.stdout.readline().split()
        size = int(header[2])
        data = p.stdout.read(size)
        p.stdout.read(1)
        scan_blob(path, data)
    p.stdin.close()
    p.wait()
    return len(entries)


def scan_commit_meta(commit):
    fmt = git('show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce%x00%B', commit)
    an, ae, cn, ce, body = (fmt.split('\0') + ['', '', '', '', ''])[:5]
    short = commit[:12]
    rules = identity_hits(an + ' ' + ae + ' ' + cn + ' ' + ce)
    for e in (ae, ce):
        if not meta_email_allowed(e):
            rules.add('email')
    report('commit %s:author' % short, rules)
    for n, line in enumerate(body.splitlines(), 1):
        h = text_hits(line)
        if h:
            report('commit %s:message:%d' % (short, n), h)


scanned = 0
if HOOK:
    zero = '0' * 40
    commits = set()
    tips = []
    for line in sys.stdin:
        f = line.split()
        if len(f) != 4 or f[1].strip('0') == '':
            continue
        local_sha, remote_sha = f[1], f[3]
        tips.append(local_sha)
        rng = [local_sha, '--not', '--remotes'] if remote_sha.strip('0') == '' else ['%s..%s' % (remote_sha, local_sha)]
        commits.update(git('rev-list', *rng).split())
    for c in sorted(commits):
        scan_commit_meta(c)
        scanned += scan_tree(c)
    label = '%d commit(s) being pushed' % len(commits)
elif rev:
    c = git('rev-parse', '--verify', rev + '^{commit}').strip()
    scan_commit_meta(c)
    scanned = scan_tree(c)
    label = 'commit ' + c[:12]
else:
    scanned = scan_worktree()
    label = 'the working tree'
    em = git('config', '--get', 'user.email', check=False).strip()
    if em and not meta_email_allowed(em):
        report('git config user.email', {'email'} | identity_hits(em))

seen = set()
for where, rule in found:
    if (where, rule) in seen:
        continue
    seen.add((where, rule))
    print('%s: %s' % (where, rule))
by = {}
for _, r in seen:
    by[r] = by.get(r, 0) + 1
summary = ', '.join('%s %d' % kv for kv in sorted(by.items())) or 'no hits'
print('check-public: %s, %d file(s) scanned, %d identity term(s) from %s: %s' % (
    label, scanned, len(terms), ' + '.join(sources), summary), file=sys.stderr)
sys.exit(1 if seen else 0)
PYEOF

export CHECK_PUBLIC_ARGV0="$0"
exec python3 -I -c "$PY" "$@"
