"""templates.py: a shared host's template generations (ADR 0077 sections 1, 2 and 4). Host root; imported by desk-host-template
(the command), report.py, desk-host-check and desk-host-link. Python 3 standard library only, plus openssl and zstd.

- A generation is /srv/desk-host/templates/<gen>/ on the slot store, <gen> = g<n> numbered per host-image version; the bake's
  template is g1. Each sealed one is bound read-only. Its .complete, written last, says gen=, chromium= (its chromium package's
  version), manifest= (the SHA-256 of its manifest) and host-version=. Its manifest lives on the host's own root,
  /var/lib/desk-host/templates/<gen>.json, so no write to the store can change both a file and its manifest.
- /var/lib/desk-host/templates/state.json: current, previous, candidate (sealed, not yet trusted here) and halted (never used
  for a new root again), each with its Chromium, seal time and target; maxGen, so an old artifact can't be replayed.
- fetch(): ADR 0077 1.4. Store admission, the signed header (P-256 keys baked in /etc/desk-host/template-keys, and on a TEST
  host only /var/lib/desk-host/test/template-keys), the other three files hashed as they arrive, a checked unpack that hashes
  each file as it writes it, the walk against the manifest, desk-host-check template, Chromium only forward, the seal. Nothing
  from the artifact runs: no apt, no dpkg, no maintainer script.
- choose(): ADR 0077 section 2. The generation a slot should be on, from its profile's Last Version (mounts.py peek).
- The update cgroup desk-host-upd (section 4) and the host's one turn for a copy (an unpack, a re-root, a prepare).

The artifact (ADR 0077 1.1; the builder's side is tools/template/): header.json (format ma-host-template/1, gen, hostImage,
created, urgent, chromium, base, files: {manifest.json, plan.txt, template.tar.zst: {size, sha256}}), header.sig (ECDSA P-256
SHA-256 over header.json's exact bytes, DER or base64 DER), manifest.json (canonical JSON, below), plan.txt, template.tar.zst.
"""
import base64
import binascii
import ctypes
import errno
import fcntl
import hashlib
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

E = os.environ.get
DH = E("DESK_HOST_STORE", "/srv/desk-host")
TPL = E("DESK_HOST_TEMPLATES", f"{DH}/templates")
OLD_T = f"{DH}/template"                                   # the single template of a bake before this (0.1.10 and earlier)
VAR = E("DESK_HOST_TEMPLATES_VAR", "/var/lib/desk-host/templates")
DL = E("DESK_HOST_TEMPLATES_DL", "/var/lib/desk-host/dl")
REC = E("DESK_HOST_RECORDS", "/var/lib/desk-host/slots")
RUN = E("DESK_HOST_RUN", "/run/desk-host")
LIB = E("DESK_HOST_LIB", "/usr/local/lib/desk-host")
KEYS = E("DESK_HOST_TEMPLATE_KEYS", "/etc/desk-host/template-keys")
KEYS_DROPIN = KEYS + ".d"                                   # never allowed (template-sig)
TEST_KEYS = E("DESK_HOST_TEMPLATE_TEST_KEYS", "/var/lib/desk-host/test/template-keys")
PINS = E("DESK_HOST_TEMPLATE_PINS", f"{LIB}/template-keys.sha256")
UPD = E("DESK_HOST_UPD_CGROUP", "/sys/fs/cgroup/desk-host-upd")
PRE = E("DESK_HOST_PRE_CGROUP", "/sys/fs/cgroup/desk-host-pre")
HOST_APT = E("DESK_HOST_APT_STATE", "/var/lib/desk-host/host-apt.json")
OPENSSL = "/usr/bin/openssl"
ZSTD = "/usr/bin/zstd"
FORMAT = "ma-host-template/1"
MANIFEST_FORMAT = "ma-host-template-manifest/1"
FILES = ("manifest.json", "plan.txt", "template.tar.zst")
GEN = re.compile(r"\Ag([1-9][0-9]{0,5})\Z")
SHA256 = re.compile(r"\A[0-9a-f]{64}\Z")
UTC = re.compile(r"\A(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?Z\Z")
DEB_VERSION = re.compile(r"\A(?:[0-9]+:)?[0-9][A-Za-z0-9.+~-]{0,127}\Z")
CHROMIUM_VERSION = re.compile(r"\A[0-9]+(\.[0-9]+){1,3}\Z")   # desk-browser-start's own pattern
MAX_HEADER = 4096
MAX_SIG = 512
MAX_MANIFEST = 64 << 20
MAX_PLAN = 4 << 20
MAX_KEY = 4096
GROWTH = int(E("DESK_HOST_TEMPLATE_GROWTH", str(300 * 10 ** 6)))   # ADR 0077 section 4: a generation may be 0.3 GB bigger than g1
URL_MARGIN_S = 600                                          # presigned URLs with less left than this are asked for again
CHUNK = 1 << 20
UPD_MEMORY = 192 << 20                                      # memory.max (ADR 0077 section 4; an estimate)
UPD_SHARE = 0.1                                             # io.max: 0.1 of the EBS baseline's bytes each way
UPD_IOPS = 300
STARTUP_S = 120                                             # a candidate's start check: the desk alive this long after runc start
TRIAL_WAIT_S = 3600                                         # a stop's re-root takes the candidate only after this (an idle restart at once)


class Refused(Exception):
    """An artifact refused on its signature, its bytes or its header: PU-5's 'refused', never retried."""


class Failed(Exception):
    """A step that failed for any other reason; the fetch can be tried again."""


def log(msg):
    print(f"desk-host-template: {msg}", file=sys.stderr, flush=True)


def utc(t=None):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() if t is None else t))


def parse_utc(s):
    if not isinstance(s, str):
        return None
    m = UTC.match(s)
    if not m:
        return None
    import calendar
    try:
        return calendar.timegm(tuple(int(x) for x in m.groups()[:6]) + (0, 0, 0)) + (float(m.group(7)) if m.group(7) else 0.0)
    except (ValueError, OverflowError):
        return None


def gen_n(gen):
    m = GEN.match(gen or "") if isinstance(gen, str) else None
    return int(m.group(1)) if m else None


def gen_dir(gen):
    if gen_n(gen) is None:
        raise ValueError(f"not a generation: {gen!r}")
    return f"{TPL}/{gen}"


def canonical(obj):
    """The one serialization of a manifest or a state: sorted keys, no spaces, ASCII, a newline."""
    return (json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode()


def strict_json(data, what):
    """JSON with no repeated key and no NaN (desk-batch's rule): a signed document two parsers read differently is worse than none."""
    def pairs(items):
        d = {}
        for k, v in items:
            if k in d:
                raise Refused(f"{what}: key {k!r} appears twice")
            d[k] = v
        return d

    def constant(c):
        raise Refused(f"{what}: {c} isn't JSON")
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)
    except (UnicodeDecodeError, ValueError, RecursionError) as e:
        raise Refused(f"{what} isn't JSON: {type(e).__name__}") from None


def write_atomic(path, data, mode=0o644):
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=d)
    try:
        os.write(fd, data)
        os.fchmod(fd, mode)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, path)


def rb(path):
    with open(path, "rb") as f:
        return f.read()


def rjson(path):
    with open(path, "rb") as f:
        return json.loads(f.read())


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        while True:
            b = os.read(fd, CHUNK)
            if not b:
                break
            h.update(b)
    finally:
        os.close(fd)
    return h.hexdigest()


# ---------------------------------------------------------------- openat2 (no link followed, nothing above the tree)
_libc = ctypes.CDLL(None, use_errno=True)
SYS_OPENAT2 = 437
RESOLVE_NO_XDEV, RESOLVE_NO_MAGICLINKS, RESOLVE_NO_SYMLINKS, RESOLVE_BENEATH = 0x01, 0x02, 0x04, 0x08
RESOLVE_STRICT = RESOLVE_NO_XDEV | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS | RESOLVE_BENEATH


class _OpenHow(ctypes.Structure):
    _fields_ = [("flags", ctypes.c_uint64), ("mode", ctypes.c_uint64), ("resolve", ctypes.c_uint64)]


def openat2(dirfd, path, flags, mode=0, resolve=RESOLVE_STRICT):
    how = _OpenHow(flags | os.O_CLOEXEC, mode, resolve)
    fd = _libc.syscall(SYS_OPENAT2, dirfd, os.fsencode(path), ctypes.byref(how), ctypes.sizeof(how))
    if fd < 0:
        e = ctypes.get_errno()
        raise OSError(e, f"openat2({path!r}): {errno.errorcode.get(e, e)}")
    return fd


# ---------------------------------------------------------------- versions
def upstream(v):
    """A Debian version's upstream part, as desk-browser-start compares it: no epoch, nothing from the first '-'."""
    v = (v or "").strip()
    v = v.split(":", 1)[1] if ":" in v else v
    return v.split("-", 1)[0]


def vkey(v):
    """A Chromium version as a tuple of numbers, or None if it isn't one (desk-browser-start's pattern)."""
    u = upstream(v)
    if not CHROMIUM_VERSION.match(u):
        return None
    return tuple(int(x) for x in u.split("."))


def chromium_of(tree):
    """The chromium package's version in a tree's own dpkg database (installed), or None."""
    try:
        fd = os.open(os.path.join(tree, "var/lib/dpkg/status"), os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        return None
    with os.fdopen(fd, "rb") as f:
        data = f.read(64 << 20)
    for stanza in data.decode("utf-8", "replace").split("\n\n"):
        fields = {}
        for line in stanza.splitlines():
            if line[:1] not in (" ", "\t") and ":" in line:
                k, v = line.split(":", 1)
                fields[k.strip()] = v.strip()
        if fields.get("Package") == "chromium" and fields.get("Status", "").endswith(" installed"):
            v = fields.get("Version", "")
            return v if DEB_VERSION.match(v) else None
    return None


# ---------------------------------------------------------------- the manifest
def walk_tree(tree):
    """(rel, lstat) for every path under tree, '.' first then sorted depth first by name; no link followed, one filesystem,
    the top's .complete left out. A generator: a 47,000-path tree is never held whole (desk-host-upd's 192 MiB)."""
    top = os.lstat(tree)
    yield ".", top

    def rec(d, rel):
        with os.scandir(d) as it:
            ents = sorted(((e.name, e.path, e.stat(follow_symlinks=False)) for e in it), key=lambda x: x[0])
        for name, path, st in ents:
            if rel == "." and name == ".complete":
                continue
            r = name if rel == "." else f"{rel}/{name}"
            yield r, st
            if stat.S_ISDIR(st.st_mode) and st.st_dev == top.st_dev:
                yield from rec(path, r)
    yield from rec(tree, ".")


def _cap(path):
    try:
        return base64.b64encode(os.getxattr(path, "security.capability", follow_symlinks=False)).decode()
    except OSError:
        return None


def entry_of(path, rel, st, sha=None):
    m = st.st_mode
    e = {"path": rel, "mode": stat.S_IMODE(m), "uid": st.st_uid, "gid": st.st_gid}
    if stat.S_ISDIR(m):
        e["type"] = "dir"
    elif stat.S_ISREG(m):
        e["type"] = "file"
        e["size"] = st.st_size
        e["sha256"] = sha if sha is not None else sha256_file(path)
        c = _cap(path)
        if c:
            e["cap"] = c
    elif stat.S_ISLNK(m):
        e["type"] = "link"
        e["mode"] = 0o777
        e["target"] = os.fsdecode(os.readlink(path))
    else:
        raise Failed(f"{rel}: a {stat.filemode(m)[0]} file, which a template never has")
    return e


def manifest_of(tree):
    """The manifest of a tree (the bake's g1, a migrated g1, a test's own): every path's type, mode, owner, size, a regular file's
    SHA-256, a link's target, security.capability where a file has one. Canonical JSON bytes."""
    entries = [entry_of(os.path.join(tree, rel) if rel != "." else tree, rel, st) for rel, st in walk_tree(tree)]
    return canonical({"format": MANIFEST_FORMAT, "entries": entries})


class Entry:
    """One manifest entry, compact (a 47,000-path manifest in about a fifth of what dicts take, for desk-host-upd's 192 MiB)."""
    __slots__ = ("path", "type", "mode", "uid", "gid", "size", "sha256", "target", "cap")
    KEYS = __slots__

    def __init__(self, d):
        for k in self.KEYS:
            object.__setattr__(self, k, d.get(k))

    def __getitem__(self, k):
        if k not in self.KEYS:
            raise KeyError(k)
        return getattr(self, k)

    def get(self, k, default=None):
        v = getattr(self, k, None) if k in self.KEYS else None
        return default if v is None else v

    def __contains__(self, k):
        return k in self.KEYS and getattr(self, k) is not None

    def __eq__(self, o):
        return isinstance(o, (Entry, dict)) and all(self.get(k) == o.get(k) for k in self.KEYS)


def parse_manifest(data, refused=Refused):
    """{path: entry} from a manifest's bytes, every entry checked for shape, as compact Entry objects made while it's parsed (no
    entry's dict is kept). Raises Refused (an artifact's) or Failed (the host's)."""
    if len(data) > MAX_MANIFEST:
        raise refused(f"the manifest is over {MAX_MANIFEST} bytes")

    def pairs(items):
        d = {}
        for k, v in items:
            if k in d:
                raise refused(f"manifest: key {k!r} appears twice")
            d[k] = v
        return Entry(d) if "path" in d and set(d) <= set(Entry.KEYS) else d

    def constant(c):
        raise refused(f"manifest: {c} isn't JSON")
    try:
        m = json.loads(data.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)
    except (UnicodeDecodeError, ValueError, RecursionError) as e:
        raise refused(f"the manifest isn't JSON: {type(e).__name__}") from None
    if not isinstance(m, dict) or m.get("format") != MANIFEST_FORMAT or not isinstance(m.get("entries"), list):
        raise refused(f"the manifest isn't {MANIFEST_FORMAT}")
    out = {}
    for e in m["entries"]:
        if not isinstance(e, Entry):
            raise refused("a manifest entry isn't an object of the manifest's keys")
        p = e.get("path")
        if not isinstance(p, str) or not good_name(p):
            raise refused(f"a manifest path isn't a plain relative path: {p!r}")
        t = e.get("type")
        ints = all(type(e.get(k)) is int and e.get(k) >= 0 for k in ("mode", "uid", "gid"))
        ok = ints and e["mode"] <= 0o7777 and t in ("dir", "file", "link") and isinstance(p, str)
        if t == "file":
            ok = ok and type(e.get("size")) is int and e["size"] >= 0 and isinstance(e.get("sha256"), str) and SHA256.match(e["sha256"]) is not None
            ok = ok and (e.get("cap") is None or isinstance(e.get("cap"), str))
        if t == "link":
            ok = ok and isinstance(e.get("target"), str) and 0 < len(e["target"]) <= 4096 and "\0" not in e["target"]
        if not ok:
            raise refused(f"manifest entry {p!r} is malformed")
        if p in out:
            raise refused(f"manifest path {p!r} appears twice")
        out[p] = e
    if "." not in out or out["."]["type"] != "dir":
        raise refused("the manifest has no top directory")
    return out


def manifest_total(entries):
    return sum(e.get("size", 0) for e in entries.values())


def manifest_bytes_total(data):
    """The sum of a manifest's file sizes, from its bytes, without parsing it (g1's, for the store's allowance)."""
    return sum(int(x) for x in re.findall(rb'"size":(\d+)', data))


def manifest_shas(data):
    """{path: sha256} of a manifest's files, from its bytes, small (preread's changed list)."""
    out = {}
    for m in re.finditer(rb'\{[^{}]*\}', data):
        o = m.group(0)
        p = re.search(rb'"path":"((?:[^"\\]|\\.)*)"', o)
        h = re.search(rb'"sha256":"([0-9a-f]{64})"', o)
        if p and h:
            out[json.loads(b'"' + p.group(1) + b'"')] = h.group(1).decode()
    return out


def good_name(p):
    """A path a tree may hold: '.', or a relative path with no empty, '.' or '..' part and no NUL."""
    if p == ".":
        return True
    if not p or p.startswith("/") or "\0" in p or p.endswith("/"):
        return False
    return all(part not in ("", ".", "..") for part in p.split("/"))


def link_escapes(rel, target):
    """True when a symlink at rel would point above the tree: a relative target that climbs past the top. An absolute target
    resolves inside the tree, which is the root of everything that uses it (a slot's copy, the template sandboxes)."""
    if target.startswith("/"):
        return False
    depth = len(rel.split("/")) - 1   # directories above the link, inside the tree
    for part in target.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            depth -= 1
            if depth < 0:
                return True
        else:
            depth += 1
    return False


# ---------------------------------------------------------------- .complete and the state
def read_complete(path):
    out = {}
    try:
        with open(path) as f:
            for line in f.read(65536).splitlines():
                if "=" in line:
                    k, v = line.split("=", 1)
                    out.setdefault(k.strip(), v.strip())
    except OSError:
        return None
    return out


def complete_bytes(fields):
    order = ("host-template", "host-version", "gen", "chromium", "manifest")
    keys = [k for k in order if k in fields] + sorted(k for k in fields if k not in order)
    return "".join(f"{k}={fields[k]}\n" for k in keys).encode()


def write_complete(tree, fields):
    write_atomic(os.path.join(tree, ".complete"), complete_bytes(fields), 0o644)


def state_path():
    return f"{VAR}/state.json"


def empty_state():
    return {"current": None, "previous": None, "candidate": None, "halted": [], "maxGen": 0}


def load_state():
    try:
        with open(state_path(), "rb") as f:
            st = json.loads(f.read())
    except FileNotFoundError:
        return empty_state()
    for k, v in empty_state().items():
        st.setdefault(k, v)
    return st


def save_state(st):
    os.makedirs(VAR, mode=0o755, exist_ok=True)
    write_atomic(state_path(), canonical(st), 0o644)


class StateLock:
    """One read-modify-write of state.json at a time on the host."""

    def __enter__(self):
        os.makedirs(VAR, mode=0o755, exist_ok=True)
        self.fd = os.open(f"{VAR}/.lock", os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600)
        fcntl.flock(self.fd, fcntl.LOCK_EX)
        return self

    def __exit__(self, *a):
        os.close(self.fd)


def update_state(fn):
    with StateLock():
        st = load_state()
        r = fn(st)
        save_state(st)
        return r


def sealed(gen):
    """A generation sealed on this host: its .complete says its gen, and its manifest's hash is the one on the host's root."""
    c = read_complete(f"{gen_dir(gen)}/.complete")
    if not c or c.get("gen") != gen or not SHA256.match(c.get("manifest", "")):
        return False
    try:
        return sha256_file(f"{VAR}/{gen}.json") == c["manifest"]
    except OSError:
        return False


def gens_on_store():
    try:
        return sorted((g for g in os.listdir(TPL) if gen_n(g) is not None), key=gen_n)
    except FileNotFoundError:
        return []


def halted_gens(st):
    return {h["gen"]: h for h in st.get("halted") or []}


def current_gen(st=None):
    st = st or load_state()
    return (st.get("current") or {}).get("gen")


def entry(st, gen):
    for k in ("current", "previous", "candidate"):
        if (st.get(k) or {}).get("gen") == gen:
            return st[k]
    return halted_gens(st).get(gen)


def chromium_for(st, gen):
    e = entry(st, gen)
    return e.get("chromium") if e else None


def host_version():
    """This host's image version, as g1's .complete records it (host-version=)."""
    c = read_complete(f"{TPL}/g1/.complete") or read_complete(f"{OLD_T}/.complete") or {}
    return c.get("host-version")


def g1_manifest_sha():
    try:
        return sha256_file(f"{VAR}/g1.json")
    except OSError:
        return None


# ---------------------------------------------------------------- the records (desk-host's)
def record(k):
    try:
        with open(f"{REC}/{k}.json") as f:
            r = json.load(f)
        return r if isinstance(r, dict) else None
    except (OSError, ValueError):
        return None


def records():
    out = {}
    try:
        names = os.listdir(REC)
    except FileNotFoundError:
        return out
    for n in names:
        m = re.fullmatch(r"(\d+)\.json", n)
        if m:
            r = record(int(m.group(1)))
            if r is not None:
                out[int(m.group(1))] = r
    return out


def running_slots():
    out = set()
    try:
        r = subprocess.run(["runc", "list", "-q"], capture_output=True, text=True, timeout=20)
        for c in r.stdout.split():
            m = re.fullmatch(r"dh-desk-(\d+)", c)
            if m:
                out.add(int(m.group(1)))
    except (OSError, subprocess.SubprocessError):
        pass
    return out


def gens_in_use(st=None):
    """Generations a slot's record names, or a running sandbox roots in."""
    used = {r.get("template") for r in records().values()}
    try:
        for c in subprocess.run(["runc", "list", "-q"], capture_output=True, text=True, timeout=20).stdout.split():
            if c.startswith("dh-svc-"):
                s = subprocess.run(["runc", "state", c], capture_output=True, text=True, timeout=10)
                b = json.loads(s.stdout).get("bundle", "") if s.returncode == 0 else ""
                try:
                    root = json.load(open(os.path.join(b, "config.json")))["root"]["path"]
                except (OSError, ValueError, KeyError):
                    continue
                m = re.fullmatch(re.escape(TPL) + r"/(g[0-9]+)", root.rstrip("/"))
                if m:
                    used.add(m.group(1))
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    return {g for g in used if g}


# ---------------------------------------------------------------- the choice (ADR 0077 section 2)
def choose(st, slot_gen, last_version, purpose="reroot", trial_ok=False):
    """(gen, reason, chromium_behind) the slot should be on.
    purpose: 'reroot' (at a stop or an idle restart) or 'new' (a desk whose record doesn't name it, at a start).
    last_version: the profile's Last Version, None for no profile (no constraint), or 'unreadable' (keep where it is).
    trial_ok: the candidate may be this slot's (one slot at a time, at a stop or an idle restart only)."""
    cur = st.get("current") or {}
    halted = halted_gens(st)
    if not cur.get("gen"):
        return slot_gen, "no current generation", False
    if last_version == "unreadable":
        return (slot_gen if purpose == "reroot" and slot_gen else cur["gen"]), "Last Version unreadable: kept", False
    lv = vkey(last_version) if last_version else None

    def fits(e):
        ck = vkey(e.get("chromium")) if e else None
        return lv is None or (ck is not None and ck >= lv)
    cand = st.get("candidate") or {}
    if trial_ok and purpose == "reroot" and cand.get("gen") and cand["gen"] not in halted and fits(cand):
        return cand["gen"], "the candidate's trial", False
    if fits(cur):
        return cur["gen"], "current", False
    # the current one is older than the profile: stay on the slot's own (a rolled-back generation it already ran), or any newer
    if slot_gen and slot_gen in {cur.get("gen"), (st.get("previous") or {}).get("gen"), cand.get("gen")} | set(halted):
        own = entry(st, slot_gen)
        if own and fits(own) and (slot_gen not in halted or halted[slot_gen].get("reason") == "rollback"):
            return slot_gen, "its own: Last Version is newer than current's Chromium", False
    for k in ("previous", "candidate"):
        e = st.get(k) or {}
        if e.get("gen") and e["gen"] not in halted and fits(e):
            return e["gen"], f"{k}: the only one new enough", False
    return cur["gen"], "no generation here is new enough", True


# ---------------------------------------------------------------- keys and the signature
def safe_dir(path):
    try:
        st = os.lstat(path)
    except OSError:
        return False
    return stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and not st.st_mode & 0o022


def is_p256(path):
    try:
        r = subprocess.run([OPENSSL, "pkey", "-pubin", "-in", path, "-noout", "-text"], capture_output=True, text=True,
                           timeout=10, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return r.returncode == 0 and ("prime256v1" in r.stdout or "P-256" in r.stdout)


def key_dirs():
    dirs = [KEYS]
    if test_mode():
        dirs.append(TEST_KEYS)
    return dirs


def test_mode():
    if E("DESK_HOST_TEMPLATES_TEST") == "1" and os.geteuid() != 0:
        return True   # the unit tests' temporary trees, never as root
    return os.path.exists("/etc/desk-host/test.conf") and os.path.isdir("/var/lib/desk-host/test")


def trusted_keys(dirs=None, owner=None):
    """*.pem in the key directories that pass every check: root's alone (or the unit tests' own user), P-256. With none, every artifact is refused."""
    if owner is None:
        owner = os.geteuid() if (os.geteuid() != 0 and test_mode()) else 0
    keys = []
    for d in dirs if dirs is not None else key_dirs():
        try:
            st = os.lstat(d)
        except OSError:
            continue
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != owner or st.st_mode & 0o022:
            log(f"skipping {d}: not a directory only its owner can write")
            continue
        for name in sorted(os.listdir(d)):
            p = os.path.join(d, name)
            try:
                s = os.lstat(p)
            except OSError:
                continue
            if not name.endswith(".pem") or not stat.S_ISREG(s.st_mode) or s.st_uid != owner or s.st_mode & 0o022 or s.st_size > MAX_KEY:
                continue
            if is_p256(p):
                keys.append(p)
    return keys


def decode_signature(sig):
    """DER as KMS gives it, or that in base64 (desk-batch's rule)."""
    if sig[:1] != b"\x30":
        try:
            sig = base64.b64decode(sig.strip(), validate=True)
        except (binascii.Error, ValueError):
            raise Refused("the signature is neither DER nor base64") from None
    if not 8 <= len(sig) <= 80 or sig[:1] != b"\x30":
        raise Refused("the signature isn't a DER ECDSA signature")
    return sig


def verify_signature(data, sig, keys):
    """The key that verifies sig over data's exact bytes, or Refused. Called before anything reads the header."""
    if not keys:
        raise Refused("no template key is trusted here: every artifact is refused")
    sig = decode_signature(sig)
    with tempfile.TemporaryDirectory(prefix="desk-host-tsig-") as t:
        mp, sp = os.path.join(t, "h"), os.path.join(t, "s")
        with open(mp, "wb") as f:
            f.write(data)
        with open(sp, "wb") as f:
            f.write(sig)
        for k in keys:
            try:
                r = subprocess.run([OPENSSL, "dgst", "-sha256", "-verify", k, "-signature", sp, mp], capture_output=True,
                                   timeout=10, stdin=subprocess.DEVNULL)
            except (OSError, subprocess.TimeoutExpired):
                continue
            if r.returncode == 0:
                return k
    raise Refused("the signature doesn't verify with any trusted template key")


def check_header(data, order_sha, st, my_version, base_sha):
    """The signed header's fields (ADR 0077 1.4 step 3). Unknown fields are ignored: anything a host must read bumps the format."""
    if len(data) > MAX_HEADER:
        raise Refused(f"the header is over {MAX_HEADER} bytes")
    if sha256_bytes(data) != order_sha:
        raise Refused("the header's SHA-256 isn't the order's")
    h = strict_json(data, "header")
    if not isinstance(h, dict) or h.get("format") != FORMAT:
        raise Refused(f"the header's format isn't {FORMAT}")
    n = gen_n(h.get("gen"))
    if n is None:
        raise Refused("the header's gen isn't g<n>")
    if not isinstance(h.get("hostImage"), str) or h["hostImage"] != my_version:
        raise Refused(f"the artifact is for host image {h.get('hostImage')!r}, this host is {my_version!r}")
    if n <= max(st.get("maxGen") or 0, max((gen_n(g) or 0 for g in gens_on_store()), default=0)):
        raise Refused(f"{h['gen']} isn't above every generation this host has had (g{st.get('maxGen') or 0})")
    if parse_utc(h.get("created")) is None or type(h.get("urgent")) is not bool:
        raise Refused("the header's created or urgent is malformed")
    if not isinstance(h.get("chromium"), str) or not DEB_VERSION.match(h["chromium"]) or vkey(h["chromium"]) is None:
        raise Refused("the header's chromium isn't a version")
    if not isinstance(h.get("base"), str) or not SHA256.match(h["base"]):
        raise Refused("the header's base isn't a SHA-256")
    if base_sha is not None and h["base"] != base_sha:
        raise Refused("the header's base isn't this host's g1 manifest")
    files = h.get("files")
    if not isinstance(files, dict) or set(files) != set(FILES):
        raise Refused(f"the header's files aren't exactly {', '.join(FILES)}")
    for name in FILES:
        f = files[name]
        if not isinstance(f, dict) or type(f.get("size")) is not int or f["size"] < 0 or not isinstance(f.get("sha256"), str) or not SHA256.match(f["sha256"]):
            raise Refused(f"the header's {name} entry is malformed")
    if files["manifest.json"]["size"] > MAX_MANIFEST or files["plan.txt"]["size"] > MAX_PLAN:
        raise Refused("the manifest or the plan is too big")
    return h


# ---------------------------------------------------------------- pacing writes under io.max (a lab finding, 2026-11-11)
# desk-host-upd's io.max throttles a write after its pages are under writeback, and the memory cgroup can't reclaim pages that
# wait there: a writer faster than 15.6 MB/s filled the 192 MiB with them and was OOM-killed at 176 MB (the first lab fetch).
# So every writer here waits for each PACE bytes to reach the disk before it writes more: at most PACE in flight.
PACE = int(E("DESK_HOST_UPD_PACE", str(16 << 20)))


class Pacer:
    def __init__(self, fd=None, fs_fd=None):
        self.fd, self.fs_fd, self.n = fd, fs_fd, 0

    def wrote(self, n, fd=None):
        self.n += n
        if self.n >= PACE:
            self.flush(fd)

    def flush(self, fd=None):
        if self.fs_fd is not None:
            _libc.syncfs(self.fs_fd)   # the tree's whole filesystem: one journal commit for many small files
        else:
            os.fdatasync(fd if fd is not None else self.fd)
            try:
                os.posix_fadvise(fd if fd is not None else self.fd, 0, 0, os.POSIX_FADV_DONTNEED)
            except OSError:
                pass
        self.n = 0


def copy_tree(src, dst):
    """A generation's tree copied into dst (a new, empty directory) as tar -p --numeric-owner copies it (modes, set-id bits, owners,
    links and hard links; .complete left out), paced (Pacer), never following a link. A re-root's copy, in desk-host-upd."""
    srcfd = os.open(src, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    dstfd = os.open(dst, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    fsfd = os.open(dst, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    pace = Pacer(fs_fd=fsfd)
    inodes = {}
    dirs = []
    n = 0
    try:
        for rel, st in walk_tree(src):
            if rel == ".":
                dirs.append((".", st))
                continue
            m = st.st_mode
            parent = os.path.dirname(rel) or "."
            pfd = dstfd if parent == "." else openat2(dstfd, parent, os.O_PATH | os.O_DIRECTORY)
            name = os.path.basename(rel)
            try:
                if stat.S_ISDIR(m):
                    os.mkdir(name, 0o700, dir_fd=pfd)
                    dirs.append((rel, st))
                elif stat.S_ISLNK(m):
                    os.symlink(os.readlink(os.path.join(src, rel)), name, dir_fd=pfd)
                    os.chown(name, st.st_uid, st.st_gid, dir_fd=pfd, follow_symlinks=False)
                elif stat.S_ISREG(m):
                    if st.st_nlink > 1 and (st.st_dev, st.st_ino) in inodes:
                        first = inodes[(st.st_dev, st.st_ino)]
                        ffd = dstfd if os.path.dirname(first) == "" else openat2(dstfd, os.path.dirname(first), os.O_PATH | os.O_DIRECTORY)
                        os.link(os.path.basename(first), name, src_dir_fd=ffd, dst_dir_fd=pfd, follow_symlinks=False)
                        if ffd != dstfd:
                            os.close(ffd)
                        continue
                    inodes[(st.st_dev, st.st_ino)] = rel
                    ifd = openat2(srcfd, rel, os.O_RDONLY)
                    ofd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=pfd)
                    try:
                        while True:
                            b = os.read(ifd, CHUNK)
                            if not b:
                                break
                            os.write(ofd, b)
                            pace.wrote(len(b))
                        os.fchown(ofd, st.st_uid, st.st_gid)
                        os.fchmod(ofd, stat.S_IMODE(m))
                    finally:
                        os.close(ifd)
                        os.close(ofd)
                else:
                    raise Failed(f"{rel}: a special file in a generation")
                n += 1
            finally:
                if pfd != dstfd:
                    os.close(pfd)
        for rel, st in reversed(dirs):   # directories last, deepest first: their modes and owners once nothing more goes in
            fd = dstfd if rel == "." else openat2(dstfd, rel, os.O_PATH | os.O_DIRECTORY)
            try:
                os.chown(f"/proc/self/fd/{fd}", st.st_uid, st.st_gid)
                os.chmod(f"/proc/self/fd/{fd}", stat.S_IMODE(st.st_mode))
            finally:
                if fd != dstfd:
                    os.close(fd)
        pace.flush()
    finally:
        os.close(srcfd)
        os.close(dstfd)
        os.close(fsfd)
    return n


# ---------------------------------------------------------------- downloads
def url_ok(u):
    if not isinstance(u, str) or len(u) > 8192 or any(ord(c) <= 32 or ord(c) == 127 for c in u):
        return False
    if u.startswith("https://"):
        return True
    return test_mode() and re.match(r"\Ahttp://127\.0\.0\.1:\d{2,5}/", u) is not None


def download(url, path, limit, want_size=None, want_sha=None, opener=None):
    """url to path (a new file), hashed as it arrives; refused past limit, or when size or SHA-256 isn't the expected one."""
    opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}))
    h = hashlib.sha256()
    n = 0
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    pace = Pacer(fd=fd)
    try:
        with opener.open(urllib.request.Request(url), timeout=60) as r:
            while True:
                b = r.read(CHUNK)
                if not b:
                    break
                n += len(b)
                if n > limit:
                    raise Refused(f"{os.path.basename(path)} is over {limit} bytes")
                h.update(b)
                os.write(fd, b)
                pace.wrote(len(b))
        os.fsync(fd)
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        if isinstance(e, urllib.error.HTTPError) and e.code == 403:
            raise Failed(f"download of {os.path.basename(path)}: HTTP 403 (expired URL?)") from None
        raise Failed(f"download of {os.path.basename(path)}: {type(e).__name__}: {getattr(e, 'reason', e)}") from None
    finally:
        os.close(fd)
    if want_size is not None and n != want_size:
        raise Refused(f"{os.path.basename(path)} is {n} bytes, the header says {want_size}")
    if want_sha is not None and h.hexdigest() != want_sha:
        raise Refused(f"{os.path.basename(path)} doesn't hash to the header's SHA-256")
    return n, h.hexdigest()


# ---------------------------------------------------------------- the checked unpack
def _parent_fd(rootfd, rel, cache):
    parent = os.path.dirname(rel) or "."
    if parent in cache:
        return cache[parent]
    if len(cache) > 64:
        for v in cache.values():
            if v != rootfd:
                os.close(v)
        cache.clear()
    fd = rootfd if parent == "." else openat2(rootfd, parent, os.O_PATH | os.O_DIRECTORY)
    cache[parent] = fd
    return fd


def _norm(name):
    n = name[2:] if name.startswith("./") else name
    n = n.rstrip("/") if n not in ("", ".", "./") else "."
    return "." if n in ("", ".") else n


def unpack(archive, dest, manifest, stop_check=None):
    """zstd -dc archive | tar members into dest (a new, empty directory), checked one by one against the manifest; returns
    {path: sha256} for every regular file, hashed as written. Refuses (Refused) a member outside the tree, a link that points
    out of it, a device file or any other special file, a member the manifest doesn't list or lists as another type, one
    seen twice, set-id bits. Nothing is followed and nothing is read back."""
    hashes = {}
    seen = set()
    rootfd = os.open(dest, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    fsfd = os.open(dest, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    pace = Pacer(fs_fd=fsfd)
    cache = {".": rootfd}
    p = subprocess.Popen([ZSTD, "-d", "-c", "-q", "--no-progress", "--memory=32MB", archive], stdout=subprocess.PIPE,
                         stdin=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        with tarfile.open(fileobj=p.stdout, mode="r|") as tf:
            for m in tf:
                if stop_check:
                    stop_check()
                rel = _norm(m.name)
                if not good_name(rel):
                    raise Refused(f"member {m.name!r} isn't a plain path inside the tree")
                if rel in seen:
                    raise Refused(f"member {rel!r} appears twice")
                seen.add(rel)
                e = manifest.get(rel)
                if e is None:
                    raise Refused(f"member {rel!r} isn't in the manifest")
                if m.ischr() or m.isblk() or m.isfifo() or m.isdev():
                    raise Refused(f"member {rel!r} is a device or special file")
                kind = "dir" if m.isdir() else "link" if m.issym() else "hard" if m.islnk() else "file" if m.isreg() else None
                if kind is None:
                    raise Refused(f"member {rel!r} is of a type a template never has")
                if (kind if kind != "hard" else "file") != e["type"]:
                    raise Refused(f"member {rel!r} is a {kind}, the manifest says {e['type']}")
                mode = m.mode & 0o7777
                if mode & 0o6000:
                    raise Refused(f"member {rel!r} has set-id bits")
                uid, gid = m.uid, m.gid
                if rel == ".":
                    os.chown(dest, uid, gid)
                    os.chmod(dest, mode)
                    continue
                pfd = _parent_fd(rootfd, rel, cache)
                name = os.path.basename(rel)
                if kind == "dir":
                    os.mkdir(name, 0o700, dir_fd=pfd)
                    os.chown(name, uid, gid, dir_fd=pfd, follow_symlinks=False)
                    os.chmod(name, mode, dir_fd=pfd, follow_symlinks=False)
                elif kind == "link":
                    if link_escapes(rel, m.linkname) or "\0" in m.linkname:
                        raise Refused(f"link {rel!r} points out of the tree ({m.linkname!r})")
                    os.symlink(m.linkname, name, dir_fd=pfd)
                    os.chown(name, uid, gid, dir_fd=pfd, follow_symlinks=False)
                elif kind == "hard":
                    t = _norm(m.linkname)
                    if not good_name(t) or t == "." or t not in hashes:
                        raise Refused(f"hard link {rel!r} names {m.linkname!r}, not a file already in the tree")
                    tfd = _parent_fd(rootfd, t, cache)
                    pfd = _parent_fd(rootfd, rel, cache)
                    os.link(os.path.basename(t), name, src_dir_fd=tfd, dst_dir_fd=pfd, follow_symlinks=False)
                    hashes[rel] = hashes[t]
                else:
                    h = hashlib.sha256()
                    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=pfd)
                    try:
                        src = tf.extractfile(m)
                        left = m.size
                        while left > 0:
                            b = src.read(min(CHUNK, left))
                            if not b:
                                raise Refused(f"member {rel!r} is cut short")
                            h.update(b)
                            os.write(fd, b)
                            pace.wrote(len(b))
                            left -= len(b)
                        os.fchown(fd, uid, gid)
                        os.fchmod(fd, mode)
                        cap = m.pax_headers.get("SCHILY.xattr.security.capability")
                        if cap is not None:
                            os.setxattr(fd, "security.capability", cap.encode("utf-8", "surrogateescape"))
                    finally:
                        os.close(fd)
                    hashes[rel] = h.hexdigest()
        # what follows the tar's end (its record padding) must be zeros, and is read to zstd's end so it never sees a closed pipe
        tail = 0
        while True:
            b = p.stdout.read(CHUNK)
            if not b:
                break
            tail += len(b)
            if b.strip(b"\0") or tail > 16 * CHUNK:
                raise Refused("the archive has data after the tar's end")
        pace.flush()
    except tarfile.TarError as e:
        raise Refused(f"the archive isn't a tar stream: {e}") from None
    finally:
        os.close(fsfd)
        for v in cache.values():
            try:
                os.close(v)
            except OSError:
                pass
        try:
            p.stdout.close()
        except OSError:
            pass
        rc = p.wait()
        err = p.stderr.read(400).decode(errors="replace").strip()
        p.stderr.close()
    if rc != 0:
        raise Refused(f"zstd refused the archive (exit {rc}: {err})")
    return hashes


def walk_check(tree, manifest, hashes=None, sealed_at=None):
    """Every path in the tree is in the manifest with its type, mode, owner, size, link target and capability, and every manifest
    entry is in the tree; and each file's content: from hashes when given (an unpack's, never read back), or, with sealed_at, a
    file whose ctime moved after the seal is hashed again (any write moves it), so a check stays fast and a byte put back passes.
    [] when it all holds, else the problems (at most 20)."""
    probs = []
    seen = set()
    for rel, st in walk_tree(tree):
        seen.add(rel)
        e = manifest.get(rel)
        if e is None:
            probs.append(f"{rel}: not in the manifest")
        else:
            m = st.st_mode
            t = "dir" if stat.S_ISDIR(m) else "file" if stat.S_ISREG(m) else "link" if stat.S_ISLNK(m) else "special"
            if t != e["type"]:
                probs.append(f"{rel}: a {t}, the manifest says {e['type']}")
            elif (st.st_uid, st.st_gid) != (e["uid"], e["gid"]):
                probs.append(f"{rel}: owner {st.st_uid}:{st.st_gid}, the manifest says {e['uid']}:{e['gid']}")
            elif t != "link" and stat.S_IMODE(m) != e["mode"]:
                probs.append(f"{rel}: mode {stat.S_IMODE(m):o}, the manifest says {e['mode']:o}")
            elif t == "file" and st.st_size != e["size"]:
                probs.append(f"{rel}: {st.st_size} bytes, the manifest says {e['size']}")
            elif t == "file" and hashes is not None and hashes.get(rel) != e["sha256"]:
                probs.append(f"{rel}: its content isn't the manifest's")
            elif t == "link" and os.fsdecode(os.readlink(os.path.join(tree, rel))) != e["target"]:
                probs.append(f"{rel}: its target isn't the manifest's")
            elif t == "file" and _cap(os.path.join(tree, rel)) != e.get("cap"):
                probs.append(f"{rel}: security.capability isn't the manifest's")
            elif t == "file" and sealed_at is not None and st.st_ctime > sealed_at + 2 and sha256_file(os.path.join(tree, rel)) != e["sha256"]:
                probs.append(f"{rel}: its content changed after the seal (ctime {utc(st.st_ctime)})")
        if len(probs) >= 20:
            return probs
    missing = [p for p in manifest if p not in seen]
    probs += [f"{p}: in the manifest, not in the tree" for p in missing[:20 - len(probs)]]
    return probs


# ---------------------------------------------------------------- room (ADR 0077 section 4)
def _quotactl_dev():
    for line in open("/proc/self/mounts"):
        f = line.split()
        if len(f) > 2 and f[1] == DH:
            return f[0]
    return None


class _DqBlk(ctypes.Structure):
    _fields_ = [("bhard", ctypes.c_uint64), ("bsoft", ctypes.c_uint64), ("curspace", ctypes.c_uint64), ("ihard", ctypes.c_uint64),
                ("isoft", ctypes.c_uint64), ("curinodes", ctypes.c_uint64), ("btime", ctypes.c_uint64), ("itime", ctypes.c_uint64),
                ("valid", ctypes.c_uint32)]


def project_quota(proj, dev=None):
    """(hard limit bytes, used bytes, hard limit inodes, used inodes) of a project on the store, or None."""
    dev = dev or _quotactl_dev()
    if not dev:
        return None
    q = _DqBlk()
    cmd = (0x800007 << 8) | 2   # QCMD(Q_GETQUOTA, PRJQUOTA)
    if _libc.quotactl(cmd, dev.encode(), proj, ctypes.byref(q)) != 0:
        return None
    return q.bhard * 1024, q.curspace, q.ihard, q.curinodes


def store_headroom():
    """What the slots' quotas still let them write on the store: the room the store keeps for them."""
    total = 0
    for k in records():
        q = project_quota(1000 + k)
        if q and q[0]:
            total += max(0, q[0] - q[1])
    return total


def tree_bytes(path, once=False):
    """The blocks under path; once: each inode once, as a copy that keeps hard links (tar, cp -a) takes them."""
    n, seen = 0, set()
    for dp, dns, fns in os.walk(path):
        for x in dns + fns:
            try:
                st = os.lstat(os.path.join(dp, x))
            except OSError:
                continue
            if once:
                if (st.st_dev, st.st_ino) in seen:
                    continue
                seen.add((st.st_dev, st.st_ino))
            n += st.st_blocks * 512
    return n


def sizes():
    """The current generation's size and one prepare's (its root and the release copies), measured once and kept."""
    p = f"{VAR}/sizes.json"
    cur = current_gen()
    try:
        s = rjson(p)
        if s.get("gen") == cur:
            return s
    except (OSError, ValueError):
        pass
    t = tree_bytes(gen_dir(cur)) if cur else 0
    r = sum(tree_bytes(os.path.realpath(f"{DH}/releases/{c}/current")) for c in ("deskd", "desk-agent", "desk-notebook", "desk-rtc", "desk-stream")
            if os.path.isdir(f"{DH}/releases/{c}/current"))
    s = {"gen": cur, "template": t, "releases": r, "at": utc()}
    try:
        write_atomic(p, canonical(s))
    except OSError:
        pass
    return s


def store_admission(new_bytes=None, third=False):
    """None when a new generation fits: the template and one prepare on the store, on top of the slots' room; else why not."""
    if E("DESK_HOST_TEMPLATES_NO_ROOM_CHECK") == "1" and test_mode():
        return None
    s = sizes()
    need = (new_bytes or s["template"] + GROWTH) * (2 if third else 1) + s["template"] + s["releases"]
    v = os.statvfs(DH)
    free = v.f_bavail * v.f_frsize
    room = free - store_headroom()
    if room < need:
        return f"the store has {room / 1e9:.1f} GB beyond the slots' room, a new generation and a prepare need {need / 1e9:.1f} GB"
    return None


def releases_once():
    """What a prepare's release copies take (cp -a of each component's current, so each inode once per component), kept in RUN by
    the releases' real paths. sizes()'s "releases" counts every name: deskd's and desk-agent's hard links made it 3.5 GB for 1.1 GB."""
    paths = [os.path.realpath(f"{DH}/releases/{c}/current") for c in ("deskd", "desk-agent", "desk-notebook", "desk-rtc", "desk-stream")
             if os.path.isdir(f"{DH}/releases/{c}/current")]
    p = f"{RUN}/prepare-releases.json"
    try:
        c = rjson(p)
        if c.get("key") == paths:
            return c["bytes"]
    except (OSError, ValueError, KeyError, AttributeError):
        pass
    n = sum(tree_bytes(x, once=True) for x in paths)
    try:
        write_atomic(p, canonical({"key": paths, "bytes": n}), 0o600)
    except OSError:
        pass
    return n


def prepare_room(k, gen=None, spare_mb=512):
    """(ok, why) for slot k's prepare from gen (desk-host prep_turn, in the host's copy turn): ok when the store holds one more root (the
    generation's tree and the release copies, measured once and kept) beside what the other recorded slots' desks may still write (their
    quotas' room) and the spare. Platform's reclaim wave (2026-11-11) filled two hosts' stores with prepares that never asked."""
    s = sizes()
    gen = gen or s["gen"]
    need = (s["template"] if gen == s["gen"] else tree_bytes(gen_dir(gen), once=True)) + releases_once()
    spare = int(spare_mb) * 2 ** 20
    kept = 0
    for j in records():
        if j != k:
            q = project_quota(1000 + j)
            if q and q[0]:
                kept += max(0, q[0] - q[1])
    v = os.statvfs(DH)
    free = v.f_bavail * v.f_frsize
    return free - kept >= need + spare, (f"the store has {free / 1e9:.2f} GB free, {kept / 1e9:.2f} GB of it what the other slots' desks may "
                                         f"still write (their quotas); a root needs {need / 1e9:.2f} GB and {spare / 1e9:.2f} GB spare")


def root_admission(download_bytes):
    os.makedirs(DL, mode=0o700, exist_ok=True)
    v = os.statvfs(DL)
    free = v.f_bavail * v.f_frsize
    need = download_bytes + (1 << 30)   # and 1 GiB for the host itself
    if free < need:
        return f"the host's root has {free / 1e9:.1f} GB free, the download needs {need / 1e9:.1f} GB"
    return None


# ---------------------------------------------------------------- the copy turn and the update cgroup
COPY_LOCK = f"{RUN}/lock/copy"
COPY_HOLDER = f"{RUN}/copy.holder"


class CopyTurn:
    """The host's one turn for a copy onto the store (an unpack, a re-root, a slot's prepare), so the store keeps room for one
    prepare in flight. A background holder writes its process group; a foreground prepare (desk-host's, a member waiting)
    takes the turn from it (SIGTERM to that group), and the dropped work is tried again later."""

    def __init__(self, background=True):
        self.bg = background

    def __enter__(self):
        os.makedirs(os.path.dirname(COPY_LOCK), mode=0o700, exist_ok=True)
        self.fd = os.open(COPY_LOCK, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600)
        fcntl.flock(self.fd, fcntl.LOCK_EX)
        write_atomic(COPY_HOLDER, f"{os.getpgrp() if self.bg else 'fg'}\n".encode(), 0o600)
        return self

    def __exit__(self, *a):
        try:
            os.unlink(COPY_HOLDER)
        except OSError:
            pass
        os.close(self.fd)


def baseline_bps():
    """The instance's EBS baseline in bytes per second (classes.py's table)."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("desk_host_classes", f"{LIB}/classes.py")
    cl = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cl)
    it = E("PREREAD_ITYPE") or _itype()
    mbps, _iops = cl.BASELINE.get(it, cl.BASELINE_DEFAULT)
    return mbps * 1e6, cl


def _itype():
    try:
        t = urllib.request.urlopen(urllib.request.Request("http://169.254.169.254/latest/api/token", method="PUT",
                                                          headers={"X-aws-ec2-metadata-token-ttl-seconds": "60"}), timeout=3).read().decode()
        return urllib.request.urlopen(urllib.request.Request("http://169.254.169.254/latest/meta-data/instance-type",
                                                             headers={"X-aws-ec2-metadata-token": t}), timeout=3).read().decode()
    except OSError:
        return "unknown"


def disk_of(mountpoint):
    """MAJ:MIN of the whole disk under a mount point (io.max takes disks, not partitions)."""
    r = subprocess.run(["findmnt", "-no", "SOURCE", mountpoint], capture_output=True, text=True)
    src = r.stdout.strip().splitlines()[0] if r.stdout.strip() else ""
    if not src.startswith("/dev/"):
        return None
    r = subprocess.run(["lsblk", "-ndo", "PKNAME", src], capture_output=True, text=True)
    disk = "/dev/" + r.stdout.strip() if r.stdout.strip() else src
    r = subprocess.run(["lsblk", "-ndo", "MAJ:MIN", disk], capture_output=True, text=True)
    return r.stdout.strip() or None


def upd_limits():
    """{file: value} desk-host-upd must hold (ADR 0077 section 4)."""
    bps, _cl = baseline_bps()
    b = int(bps * UPD_SHARE)
    io = []
    for mp in (DH, "/"):
        d = disk_of(mp)
        if d and d not in [x.split()[0] for x in io]:
            io.append(f"{d} rbps={b} wbps={b} riops={UPD_IOPS} wiops={UPD_IOPS}")
    return {"cpu.idle": "1", "cpu.max": "100000 100000", "memory.max": str(UPD_MEMORY), "io.max": io}


def ensure_upd():
    """desk-host-upd beside desk-host-pre, outside desk-host and every desk: cpu.idle, one CPU, 192 MiB, io.max on the store and
    the host's root. Made at boot (desk-host-boot) and before each launch."""
    os.makedirs(UPD, exist_ok=True)
    lim = upd_limits()
    for f in ("cpu.idle", "cpu.max", "memory.max"):
        with open(f"{UPD}/{f}", "w") as fh:
            fh.write(lim[f])
    for line in lim["io.max"]:
        with open(f"{UPD}/io.max", "w") as fh:
            fh.write(line)
    with open(f"{UPD}/memory.swap.max", "w") as fh:
        fh.write("0")
    return lim


def upd_launch(argv, detach=False):
    """Run argv in desk-host-upd, in its own process group (the copy turn's SIGTERM reaches its whole tree). The launcher stays
    where it was (a unit's cgroup) and waits, so systemd's unit ends when the work does; detach returns at once."""
    ensure_upd()
    r, w = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(r)
        try:
            os.setsid()
            with open(f"{UPD}/cgroup.procs", "w") as fh:
                fh.write(str(os.getpid()))
            os.write(w, b"1")
            os.close(w)
            os.execv(argv[0], argv)
        except OSError as e:
            os.write(2, f"desk-host-template upd: {e}\n".encode())
        os._exit(127)
    os.close(w)
    ok = os.read(r, 1)
    os.close(r)
    if not ok:
        return 127
    if detach:
        return 0
    signal.signal(signal.SIGTERM, lambda *a: os.killpg(pid, signal.SIGTERM))
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status)


def upd_kill():
    """Every process in desk-host-upd stopped (a reboot drops a fetch or a re-root in flight; it starts again from scratch)."""
    try:
        with open(f"{UPD}/cgroup.freeze", "w") as fh:
            fh.write("0")
        with open(f"{UPD}/cgroup.kill", "w") as fh:
            fh.write("1")
    except OSError:
        pass


# ---------------------------------------------------------------- holds (update.holdUntil, ADR 0077 section 5)
def set_hold(k, seconds=900):
    d = f"{RUN}/hold"
    os.makedirs(d, mode=0o700, exist_ok=True)
    write_atomic(f"{d}/{k}", f"{utc(time.time() + seconds)}\n".encode(), 0o600)


def clear_hold(k):
    try:
        os.unlink(f"{RUN}/hold/{k}")
    except OSError:
        pass


def hold_until(k):
    try:
        t = open(f"{RUN}/hold/{k}").read().strip()
    except OSError:
        return None
    pt = parse_utc(t)
    return t if pt and pt > time.time() else None


# ---------------------------------------------------------------- fetch status (PU-1's fetch)
def fetch_status(**kw):
    p = f"{VAR}/fetch.json"
    try:
        cur = rjson(p)
    except (OSError, ValueError):
        cur = {}
    cur.update(kw)
    cur["at"] = utc()
    os.makedirs(VAR, mode=0o755, exist_ok=True)
    write_atomic(p, canonical(cur))
    return cur


def read_fetch_status():
    try:
        return rjson(f"{VAR}/fetch.json")
    except (OSError, ValueError):
        return None


# ---------------------------------------------------------------- binds
def bind_ro(path):
    """path bound read-only over itself, nosuid, nodev (as the template always was)."""
    for line in open("/proc/self/mounts"):
        f = line.split()
        if len(f) > 3 and f[1] == path and "ro" in f[3].split(","):
            return
    subprocess.run(["mount", "--bind", path, path], check=True)
    subprocess.run(["mount", "-o", "remount,bind,ro,nosuid,nodev", path], check=True)


def unbind(path):
    while subprocess.run(["mountpoint", "-q", path]).returncode == 0:
        if subprocess.run(["umount", path]).returncode != 0:
            subprocess.run(["umount", "-l", path])
            break


def rm_tree(path):
    """A tree removed without following links (rm -rf --one-file-system), after its bind if any."""
    if os.path.lexists(path):
        unbind(path)
        subprocess.run(["rm", "-rf", "--one-file-system", "--", path], check=False)


# ---------------------------------------------------------------- the seal (ADR 0077 1.4 step 7), shared with the bake and the migration
def changed_vs_g1(manifest, g1=None):
    """Paths whose content isn't g1's (or that g1 doesn't have), for preread.py: their traced byte ranges are stale."""
    if g1 is None:
        try:
            g1 = manifest_shas(rb(f"{VAR}/g1.json"))
        except OSError:
            return []
    return sorted(p for p, e in manifest.items() if e["type"] == "file" and g1.get(p) != e["sha256"])


def seal(tree, gen, manifest_bytes, extra, final_dir=None, bind=True):
    """The tree becomes generation gen: root's top, the manifest on the host's root, .complete written last, renamed to
    templates/<gen> and bound read-only. Returns the .complete's fields."""
    os.makedirs(VAR, mode=0o755, exist_ok=True)
    if os.geteuid() == 0:
        os.chown(tree, 0, 0)
    write_atomic(f"{VAR}/{gen}.json", manifest_bytes, 0o644)
    fields = dict(extra)
    fields.update({"gen": gen, "chromium": chromium_of(tree) or "none", "manifest": sha256_bytes(manifest_bytes)})
    fields.setdefault("host-template", utc())
    if gen != "g1":
        man = parse_manifest(manifest_bytes, refused=Failed)
        write_atomic(f"{VAR}/{gen}.changed", ("\n".join(changed_vs_g1(man)) + "\n").encode(), 0o644)
    write_complete(tree, fields)
    final = final_dir or gen_dir(gen)
    if os.path.abspath(tree) != os.path.abspath(final):
        os.rename(tree, final)
    if bind and os.geteuid() == 0:
        bind_ro(final)
    return fields


# ---------------------------------------------------------------- fetch (ADR 0077 1.4)
def fetch(order, stop_check=None):
    """One template_target order: fetch, check and seal, failing closed at every step (nothing sealed, the current generation
    and every slot untouched, the download removed). The fetch status says each step; Refused for a signature, hash or header
    refusal, Failed otherwise."""
    gen, target = order["gen"], order.get("targetId")
    st = load_state()
    build = f"{TPL}/.build-{gen}"
    dl = f"{DL}/{gen}"
    step = "admission"

    def status(state, **kw):
        fetch_status(target=target, gen=gen, state=state, step=step, error=kw.get("error"))

    def at(s_, state=None):   # each step in the report's fetch as it starts
        nonlocal step
        step = s_
        fetch_status(target=target, gen=gen, state=state or (read_fetch_status() or {}).get("state"), step=s_, error=None)

    def urls_left():
        exp = parse_utc(order.get("expiresAt"))
        if exp is not None and exp - time.time() < URL_MARGIN_S:
            raise UrlsWanted()

    t0 = time.monotonic()
    timing = {}
    try:
        status("downloading")
        if gen_n(gen) is None:
            raise Refused(f"the order's gen {gen!r} isn't g<n>")
        if gen_n(gen) <= max(st.get("maxGen") or 0, max((gen_n(g) or 0 for g in gens_on_store()), default=0)):
            raise Refused(f"{gen} isn't above every generation this host has had")
        for u in ("header", "signature", "manifest", "plan", "archive"):
            if not url_ok((order.get("urls") or {}).get(u)):
                raise Refused(f"the order's {u} URL isn't one a host fetches")
        # 1. store admission (a third generation only with room for one more)
        third = sum(1 for k in ("current", "previous", "candidate") if (st.get(k) or {}).get("gen")) >= 2
        why = store_admission(third=third)
        if why:
            raise Failed(f"no room: {why}")
        # 2. the header and its signature, to the host's root
        at("header")
        rm_tree(dl)
        os.makedirs(dl, mode=0o700)
        urls_left()
        download(order["urls"]["header"], f"{dl}/header.json", MAX_HEADER)
        download(order["urls"]["signature"], f"{dl}/header.sig", MAX_SIG)
        # 3. the signature first, over the header's exact bytes, then the header's fields
        at("signature", "verifying")
        hdr = rb(f"{dl}/header.json")
        key = verify_signature(hdr, rb(f"{dl}/header.sig"), trusted_keys())
        at("header-fields")
        h = check_header(hdr, order.get("sha256"), st, host_version(), g1_manifest_sha())
        if h["gen"] != gen or h["hostImage"] != order.get("hostImage"):
            raise Refused("the header's gen or host image isn't the order's")
        files = h["files"]
        why = root_admission(sum(f["size"] for f in files.values()))
        if why:
            raise Failed(f"no room: {why}")
        # 4. the manifest, the plan and the archive, each hashed as it arrives
        at("download", "downloading")
        for name, key_ in (("manifest.json", "manifest"), ("plan.txt", "plan"), ("template.tar.zst", "archive")):
            urls_left()
            download(order["urls"][key_], f"{dl}/{name}", files[name]["size"], files[name]["size"], files[name]["sha256"])
        timing["download_s"] = round(time.monotonic() - t0, 1)
        man_bytes = rb(f"{dl}/manifest.json")
        man = parse_manifest(man_bytes)
        try:
            g1_total = manifest_bytes_total(rb(f"{VAR}/g1.json"))
        except OSError:
            g1_total = None
        if g1_total is not None and manifest_total(man) > g1_total + GROWTH:
            raise Refused(f"the generation is {(manifest_total(man) - g1_total) / 1e9:.2f} GB bigger than g1, past the store's allowance")
        why = store_admission(new_bytes=manifest_total(man) + 4096 * len(man), third=third)
        if why:
            raise Failed(f"no room: {why}")
        # 5. the checked unpack, in the host's one copy turn
        at("unpack", "unpacking")
        t1 = time.monotonic()
        with CopyTurn(background=True):
            rm_tree(build)
            os.mkdir(build, 0o700)
            hashes = unpack(f"{dl}/template.tar.zst", build, man, stop_check)
        timing["unpack_s"] = round(time.monotonic() - t1, 1)
        # 6. the walk, desk-host-check template, Chromium forward
        at("walk", "checking")
        t2 = time.monotonic()
        probs = walk_check(build, man, hashes)
        if probs:
            raise Refused(f"the tree isn't the manifest's: {'; '.join(probs[:3])}")
        at("template-check")
        r = subprocess.run([E("DESK_HOST_TEMPLATE_CHECK", f"{LIB}/desk-host-check"), "--only", "template", "--tree", build, "--building"],
                           capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            raise Failed(f"desk-host-check template: {r.stdout.strip()[:300]}")
        at("chromium")
        ch = chromium_of(build)
        cur = st.get("current") or {}
        if ch is None or vkey(ch) is None or upstream(ch) != upstream(h["chromium"]):
            raise Refused(f"the tree's chromium ({ch}) isn't the header's ({h['chromium']})")
        if cur.get("chromium") and vkey(ch) < vkey(cur["chromium"]):
            raise Refused(f"Chromium {upstream(ch)} is older than the current generation's {upstream(cur['chromium'])}")
        timing["check_s"] = round(time.monotonic() - t2, 1)
        # 7. the seal
        at("seal")
        fields = seal(build, gen, man_bytes, {"host-version": host_version()})

        def mark(s):
            s["candidate"] = {"gen": gen, "chromium": fields["chromium"], "sealedAt": fields["host-template"], "target": target,
                              "urgent": bool(order.get("urgent") or h["urgent"]), "trialSlot": None, "trialStartedAt": None,
                              "trialPassedAt": None, "promoteOrdered": False}
            s["maxGen"] = max(s.get("maxGen") or 0, gen_n(gen))
        update_state(mark)
        write_atomic(f"{VAR}/{gen}.plan", rb(f"{dl}/plan.txt"), 0o644)
        rm_tree(dl)
        timing["total_s"] = round(time.monotonic() - t0, 1)
        fetch_status(target=target, gen=gen, state="sealed", step=None, error=None, key=os.path.basename(key), timing=timing)
        log(f"{gen} sealed as the candidate (key {os.path.basename(key)}; {timing})")
        return fields
    except UrlsWanted:
        rm_tree(build)
        rm_tree(dl)
        status("urlsWanted", error="the order's URLs expire in under 10 minutes")
        raise
    except Refused as e:
        rm_tree(build)
        rm_tree(dl)
        status("refused", error=str(e)[:400])
        log(f"{gen}: REFUSED at {step}: {e}")
        raise
    except (Failed, OSError, subprocess.SubprocessError, ValueError) as e:
        rm_tree(build)
        rm_tree(dl)
        status("failed", error=f"{type(e).__name__}: {e}"[:400])
        log(f"{gen}: failed at {step}: {e}")
        raise Failed(str(e)) from None


class UrlsWanted(Exception):
    pass


# ---------------------------------------------------------------- promote, rollback, halt, gc
def promote(gen):
    """The candidate becomes current once a slot passed its start checks and Platform said template_promote. Returns what happened."""
    def f(st):
        c = st.get("candidate") or {}
        if (st.get("current") or {}).get("gen") == gen:
            return "already current"
        if c.get("gen") != gen:
            return "not the candidate"
        c["promoteOrdered"] = True
        if not c.get("trialPassedAt"):
            return "promote ordered; waiting for a slot to pass its start checks"
        prev = st.get("previous")
        if prev and prev.get("gen"):
            st.setdefault("retired", []).append(prev["gen"])
        st["previous"] = st["current"]
        st["current"] = {k: c[k] for k in ("gen", "chromium", "sealedAt", "target", "urgent") if k in c}
        st["current"]["currentSince"] = utc()
        st["candidate"] = None
        return "promoted"
    return update_state(f)


def trial(gen, k, what):
    """A candidate's trial on slot k: 'start' (it started there), 'passed' (its start checks held), 'failed' (halted)."""
    def f(st):
        c = st.get("candidate") or {}
        if c.get("gen") != gen:
            return "not the candidate"
        if what == "start":
            c["trialSlot"], c["trialStartedAt"] = k, utc()
            return "trial started"
        if what == "passed":
            c["trialPassedAt"] = utc()
            if c.get("promoteOrdered"):
                prev = st.get("previous")
                if prev and prev.get("gen"):
                    st.setdefault("retired", []).append(prev["gen"])
                st["previous"] = st["current"]
                st["current"] = {x: c[x] for x in ("gen", "chromium", "sealedAt", "target", "urgent") if x in c}
                st["current"]["currentSince"] = utc()
                st["candidate"] = None
                return "passed and promoted"
            return "passed"
        return None
    if what == "failed":
        return halt(gen, "start_failed")
    return update_state(f)


def halt(gen, reason):
    """gen never used for a new root again on this host (a candidate's failed start, or Platform's template_rollback)."""
    def f(st):
        cur = (st.get("current") or {}).get("gen")
        h = halted_gens(st)
        if gen in h:
            return "already halted"
        e = entry(st, gen)
        if e is None:
            return "unknown generation"
        st.setdefault("halted", []).append({"gen": gen, "chromium": e.get("chromium"), "at": utc(), "reason": reason})
        if (st.get("candidate") or {}).get("gen") == gen:
            st["candidate"] = None
        elif cur == gen:
            prev = st.get("previous")
            if not prev or not prev.get("gen") or prev["gen"] in h:
                st["halted"].pop()
                return "refused: no previous generation to go back to"
            st["current"] = dict(prev, currentSince=utc())
            st["previous"] = None
        elif (st.get("previous") or {}).get("gen") == gen:
            st["previous"] = None
        return f"halted ({reason})"
    return update_state(f)


def gc():
    """A generation nothing needs any more (not current, previous or candidate, no slot's record names it, no sandbox roots in it)
    is deleted without following links, its manifest with it. g1 stays while it's current or previous."""
    st = load_state()
    keep = {(st.get(k) or {}).get("gen") for k in ("current", "previous", "candidate")} | gens_in_use(st)
    gone = []
    for g in gens_on_store():
        if g in keep:
            continue
        rm_tree(gen_dir(g))
        for ext in (".json", ".changed", ".plan"):
            try:
                os.unlink(f"{VAR}/{g}{ext}")
            except OSError:
                pass
        gone.append(g)
    if gone:
        def f(s):
            s["halted"] = [h for h in s.get("halted") or [] if h["gen"] not in gone or h["gen"] in keep]
            s["retired"] = [g for g in s.get("retired") or [] if g not in gone]
        update_state(f)
    for d in os.listdir(TPL) if os.path.isdir(TPL) else []:
        if d.startswith(".build-") and not _fetch_running():
            rm_tree(f"{TPL}/{d}")
    return gone


def _fetch_running():
    fs = read_fetch_status() or {}
    return fs.get("state") in ("downloading", "verifying", "unpacking", "checking") and time.time() - (parse_utc(fs.get("at")) or 0) < 7200


# ---------------------------------------------------------------- the migration and the boot
def migrate():
    """A host from a bake before generations (0.1.10 and earlier): its template becomes g1, with its manifest on the host's root,
    the four .complete fields, state.json, and slot records naming g1. Runs at desk-host-boot, before any slot."""
    if os.path.isdir(TPL) and os.path.isdir(f"{TPL}/g1"):
        return None
    if not os.path.isfile(f"{OLD_T}/.complete"):
        return None
    old = read_complete(f"{OLD_T}/.complete") or {}
    old_id = (open(f"{OLD_T}/.complete").read().splitlines() or [""])[0]
    unbind(OLD_T)
    os.makedirs(TPL, mode=0o711, exist_ok=True)
    os.chmod(TPL, 0o711)
    os.rename(OLD_T, f"{TPL}/g1")
    t = f"{TPL}/g1"
    try:
        os.unlink(f"{t}/.complete")
    except OSError:
        pass
    man = manifest_of(t)
    fields = seal(t, "g1", man, {k: v for k, v in old.items() if k in ("host-template", "host-version")})

    def f(st):
        st["current"] = {"gen": "g1", "chromium": fields["chromium"], "sealedAt": fields["host-template"], "target": None,
                         "currentSince": utc(), "migrated": utc()}
        st["maxGen"] = max(st.get("maxGen") or 0, 1)
    update_state(f)
    n = 0
    for k, r in records().items():
        if r.get("template") == old_id:
            r["template"] = "g1"
            write_atomic(f"{REC}/{k}.json", json.dumps(r).encode(), 0o600)
            n += 1
    return f"the template became g1 ({len(man)} bytes of manifest, chromium {fields['chromium']}); {n} record(s) now name g1"


def boot():
    """desk-host-boot's part: the migration, nothing left of a fetch or a re-root a reboot cut off, every sealed generation bound
    read-only, desk-host-upd made and thawed."""
    out = []
    m = migrate()
    if m:
        out.append(m)
    os.makedirs(TPL, mode=0o711, exist_ok=True)
    os.makedirs(VAR, mode=0o755, exist_ok=True)
    for d in os.listdir(TPL):
        if d.startswith(".build-"):
            rm_tree(f"{TPL}/{d}")
            out.append(f"removed {d}")
    if os.path.isdir(DL):
        for d in os.listdir(DL):
            rm_tree(f"{DL}/{d}")
    fs = read_fetch_status()
    if fs and fs.get("state") in ("downloading", "verifying", "unpacking", "checking"):
        fetch_status(state="failed", error="cut off by a reboot; tried again from scratch")
    bound = []
    for g in gens_on_store():
        if sealed(g):
            bind_ro(gen_dir(g))
            bound.append(g)
        else:
            out.append(f"{g} isn't sealed: not bound, not used")
    try:
        ensure_upd()
        with open(f"{UPD}/cgroup.freeze", "w") as fh:
            fh.write("0")
    except OSError as e:
        out.append(f"desk-host-upd: {e}")
    st = load_state()
    out.append(f"generations {' '.join(bound) or 'none'} bound read-only; current {current_gen(st)}")
    return out


# ---------------------------------------------------------------- the report's part (PU-1)
def report_host():
    st = load_state()

    def e(x, extra=()):
        return {k: x.get(k) for k in ("gen", "chromium", "sealedAt", "target", *extra) if k in ("gen", "chromium", "sealedAt", "target") or x.get(k) is not None} \
            if x and x.get("gen") else None
    out = {"templates": {"current": e(st.get("current"), ("currentSince", "urgent")), "previous": e(st.get("previous")),
                         "candidate": e(st.get("candidate"), ("urgent", "trialSlot", "trialPassedAt", "promoteOrdered")),
                         "halted": [{"gen": h["gen"], "reason": h.get("reason"), "at": h.get("at")} for h in st.get("halted") or []]}}
    fs = read_fetch_status()
    if fs:
        out["fetch"] = {k: fs.get(k) for k in ("target", "gen", "state", "at", "step", "error")}
    try:
        ha = rjson(HOST_APT)
        out["hostApt"] = {k: ha.get(k) for k in ("lastOk", "lastResult", "rebootPending")}
    except (OSError, ValueError):
        out["hostApt"] = {"lastOk": None, "lastResult": None, "rebootPending": reboot_pending()}
    else:
        out["hostApt"]["rebootPending"] = reboot_pending()
    return out


def report_slot(k, rec, st=None):
    """The slot's PU-1 fields: its generation, that generation's Chromium, the last Last Version read, behind, chromiumBehind,
    update.holdUntil."""
    st = st or load_state()
    gen = (rec or {}).get("template") if rec and gen_n((rec or {}).get("template")) else None
    target = current_gen(st)
    return {"template": gen, "chromium": chromium_for(st, gen) if gen else None, "lastVersion": (rec or {}).get("lastVersion"),
            "behind": bool(gen and target and gen != target and gen != (st.get("candidate") or {}).get("gen")
                           and not (rec or {}).get("chromiumBehind") and not _kept_on_rolled_back(st, gen, rec)),
            "chromiumBehind": bool((rec or {}).get("chromiumBehind")), "update": {"holdUntil": hold_until(k)}}


def _kept_on_rolled_back(st, gen, rec):
    """A slot left on a newer generation because its profile already ran that Chromium (1.6): not behind, by the rule."""
    cur = st.get("current") or {}
    lv = vkey((rec or {}).get("lastVersion")) if (rec or {}).get("lastVersion") else None
    ck = vkey(cur.get("chromium")) if cur.get("chromium") else None
    return lv is not None and ck is not None and lv > ck


def reboot_pending():
    """{since, kernel} when the host's own packages want a reboot (/run/reboot-required, or a newer kernel installed than runs)."""
    since = None
    try:
        since = utc(os.stat("/run/reboot-required").st_mtime)
    except OSError:
        pass
    running = os.uname().release
    newest = None
    try:
        ks = [f[len("vmlinuz-"):] for f in os.listdir("/boot") if f.startswith("vmlinuz-")]
        if ks:
            def key(v):
                return [int(x) if x.isdigit() else x for x in re.split(r"[.+~-]", v)]
            newest = sorted(ks, key=key)[-1]
            if newest != running:
                since = since or utc(os.stat(f"/boot/vmlinuz-{newest}").st_mtime)
    except OSError:
        pass
    if since is None:
        return None
    return {"since": since, "kernel": newest if newest and newest != running else None}


# ---------------------------------------------------------------- the candidate's trial (ADR 0077 1.6)
def candidate_trial_ok(st, k, at_stop=False):
    """Slot k may move onto the candidate: there is one, not halted, and no other slot is on its trial. At an idle restart at
    once; at a stop only once the candidate has waited TRIAL_WAIT_S for an idle restart (at once when urgent)."""
    c = st.get("candidate") or {}
    if not c.get("gen") or c["gen"] in halted_gens(st):
        return False
    if c.get("trialSlot") not in (None, k):
        return False
    if at_stop and not c.get("urgent"):
        t = parse_utc(c.get("sealedAt"))
        if t is None or time.time() - t < TRIAL_WAIT_S:
            return False
    return True


# ---------------------------------------------------------------- the freeze while a pre-read runs (section 4)
FREEZE_LOCK = f"{RUN}/lock/upd-freeze"
FREEZE_PIDS = f"{RUN}/upd-freeze.pids"


def upd_freeze(on, pid=None):
    """desk-host-upd frozen while any pre-read runs: each pre-read registers itself and the last one out thaws it."""
    pid = pid or os.getpid()
    os.makedirs(os.path.dirname(FREEZE_LOCK), mode=0o700, exist_ok=True)
    fd = os.open(FREEZE_LOCK, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            pids = {int(x) for x in open(FREEZE_PIDS).read().split() if x.isdigit()}
        except OSError:
            pids = set()
        pids = {p for p in pids if os.path.exists(f"/proc/{p}")}
        (pids.add if on else pids.discard)(pid)
        write_atomic(FREEZE_PIDS, ("\n".join(str(p) for p in sorted(pids)) + "\n").encode(), 0o600)
        try:
            with open(f"{UPD}/cgroup.freeze", "w") as fh:
                fh.write("1" if pids else "0")
        except OSError:
            pass
        return bool(pids)
    finally:
        os.close(fd)


# ---------------------------------------------------------------- the host's own apt (ADR 0077 section 3)
POLICY_RC = "/usr/sbin/policy-rc.d"
HOLDS = ("nftables", "apparmor")
APT_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "DEBIAN_FRONTEND": "noninteractive", "LANG": "C.UTF-8"}
APT_EVERY_S = 20 * 3600   # the timer is daily; a run within 20 h of the last does nothing


def host_apt(force=False):
    """apt-get update and unattended-upgrade with 51desk-host-unattended (the security archive only, never a reboot), policy-rc.d
    exiting 101 for the whole run so no service restarts under the desks, nftables and apparmor held; then the host's quick
    checks again. A new kernel or /run/reboot-required is rebootPending, and nothing else applies until the reboot."""
    try:
        st = rjson(HOST_APT)
    except (OSError, ValueError):
        st = {}
    now = time.time()
    rp = reboot_pending()
    if not force and (parse_utc(st.get("lastRunAt")) or 0) > now - APT_EVERY_S:
        log("host apt: ran in the last 20 h; nothing to do")
        return 0
    if rp and not force:
        st.update({"lastRunAt": utc(), "lastResult": "skipped: a reboot is pending, nothing else applies until it", "rebootPending": rp})
        write_atomic(HOST_APT, canonical(st))
        log("host apt: a reboot is pending; nothing applied")
        return 0
    steps, ok = [], True
    had_policy = os.path.lexists(POLICY_RC)
    if had_policy:
        os.rename(POLICY_RC, POLICY_RC + ".desk-host-saved")
    write_atomic(POLICY_RC, b"#!/bin/sh\n# desk-host-apt (ADR 0077 section 3): no service starts or restarts under the desks during the host's own apt\nexit 101\n", 0o755)
    try:
        r = subprocess.run(["apt-mark", "hold", *HOLDS], capture_output=True, text=True, env=APT_ENV, timeout=120)
        steps.append(f"hold {r.returncode}")
        ok &= r.returncode == 0
        for argv, t in ((["apt-get", "-q", "-o", "DPkg::Lock::Timeout=120", "update"], 900), (["unattended-upgrade", "-v"], 3600),
                        (["apt-get", "-q", "clean"], 300)):
            r = subprocess.run(argv, capture_output=True, text=True, env=APT_ENV, timeout=t)
            steps.append(f"{argv[0]} {argv[-1] if argv[0] == 'apt-get' else ''} {r.returncode}".replace("  ", " "))
            if r.returncode != 0:
                ok = False
                steps.append((r.stderr or r.stdout).strip().splitlines()[-1][:200] if (r.stderr or r.stdout).strip() else "")
                if argv[0] != "apt-get" or argv[-1] != "clean":
                    break
    except (OSError, subprocess.SubprocessError) as e:
        ok = False
        steps.append(f"{type(e).__name__}: {e}"[:200])
    finally:
        os.unlink(POLICY_RC)
        if had_policy:
            os.rename(POLICY_RC + ".desk-host-saved", POLICY_RC)
    chk = subprocess.run([f"{LIB}/desk-host-check", "--quick"], capture_output=True, text=True, timeout=300)
    fails = [l for l in chk.stdout.splitlines() if l.startswith("FAIL")]
    if chk.returncode != 0:
        ok = False
        steps.append(f"the host's quick checks FAIL after it: {'; '.join(fails)[:300]}")
    st.update({"lastRunAt": utc(), "lastResult": "ok" if ok else "failed: " + "; ".join(s for s in steps if s)[:400],
               "rebootPending": reboot_pending(), "steps": steps, "checks": "pass" if chk.returncode == 0 else "fail"})
    if ok:
        st["lastOk"] = utc()
    os.makedirs(os.path.dirname(HOST_APT), exist_ok=True)
    write_atomic(HOST_APT, canonical(st))
    log(f"host apt: {st['lastResult']}; reboot pending: {st['rebootPending']}")
    return 0 if ok else 1


def trial_check(k, now=None):
    """The candidate's start checks on slot k (ADR 0077 1.6): every sandbox running and the desk's container alive STARTUP_S after
    its start. Returns 'passed', 'failed' (the candidate is then halted), 'waiting' or a reason it doesn't apply."""
    st = load_state()
    c = st.get("candidate") or {}
    rec = record(k) or {}
    if not c.get("gen") or rec.get("template") != c["gen"]:
        return "not on the candidate"
    if c.get("trialPassedAt"):
        return "passed already"
    try:
        started = os.stat(f"{RUN}/slotstate/{k}.json").st_mtime
    except OSError:
        return "not started"
    states = {}
    for name in [f"dh-desk-{k}"] + [f"dh-svc-{k}-{s}" for s in ("desk-rtc", "deskd", "desk-agent", "desk-notebook", "desk-stream", "desk-data")]:
        r = subprocess.run(["runc", "state", name], capture_output=True, text=True, timeout=20)
        try:
            states[name] = json.loads(r.stdout).get("status") if r.returncode == 0 else None
        except ValueError:
            states[name] = None
    if states[f"dh-desk-{k}"] is None:
        return "stopped by the host before its checks: no verdict"
    if any(v not in ("running", "paused") for v in states.values()):
        trial(c["gen"], k, "failed")
        return "failed: " + ", ".join(f"{n} {v}" for n, v in states.items() if v not in ("running", "paused"))
    if (now or time.time()) - started < STARTUP_S:
        return "waiting"
    return "passed" if trial(c["gen"], k, "passed") else "passed"


def start_failed(k):
    """A start on the candidate that failed (desk-host up's exit): the candidate is halted on this host. True when it was."""
    st = load_state()
    c = st.get("candidate") or {}
    rec = record(k) or {}
    if c.get("gen") and rec.get("template") == c["gen"]:
        halt(c["gen"], "start_failed")
        return True
    return False
