"""batchsig.py: a shared host's check of a desk batch's manifest and signature (ADR 0078 sections 1.1 to 1.3). Host root; imported by
batches.py, desk-host-release and desk-host-check.

These are desk-batch's own checks (image/recipe/files/usr/local/lib/ma/desk-batch: strict_json, check_manifest, decode_signature,
safe_dir, is_p256, trusted_keys, verify_signature, read_limited and baseline's reading), COPIED, not imported: desk-batch belongs to
the desk image and isn't on a host's root. image/tests/test_batch_parity.py runs the same vectors through both, so the two can't
drift. Only the paths differ: a host trusts /etc/desk-host/batch-keys (exactly the keys the host recipe pins, batch-keys.sha256;
no drop-in directory, which desk-batch's /etc/ma/batch-keys.d is for a desk's admin) and, on a TEST host only,
/var/lib/desk-host/test/batch-keys; its baseline is /etc/desk-host/batch-baseline.
"""
import base64
import binascii
import calendar
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time

E = os.environ.get
KEY_DIR = E("DESK_HOST_BATCH_KEYS", "/etc/desk-host/batch-keys")
KEY_DROPIN = KEY_DIR + ".d"                                                    # never allowed (batch-sig)
TEST_KEY_DIR = E("DESK_HOST_BATCH_TEST_KEYS", "/var/lib/desk-host/test/batch-keys")
PINS = E("DESK_HOST_BATCH_PINS", "/usr/local/lib/desk-host/batch-keys.sha256")
BASELINE = E("DESK_HOST_BATCH_BASELINE", "/etc/desk-host/batch-baseline")
KEY_OWNER = os.geteuid() if (E("DESK_HOST_BATCH_TEST") == "1" and os.geteuid() != 0) else 0   # the unit tests' own keys, never as root
OPENSSL = "/usr/bin/openssl"

FORMAT = "ma-desk-batch/1"
MAX_MANIFEST = 64 * 1024
MAX_SIGNATURE = 512
MAX_COMPONENTS = 16
MAX_NOTE = 2000
MAX_KEY = 4096
MAX_SEQ = 2 ** 53
NAME = re.compile(r"\A[a-z][a-z0-9-]{0,40}\Z")         # ma-update's component names
RESERVED = {"bin", "etc"}                                # /opt/ma's own directories, never a component
VERSION = re.compile(r"\A[A-Za-z0-9._+-]{1,64}\Z")       # ma-update's versions
SHA256 = re.compile(r"\A[0-9a-f]{64}\Z")
BATCH_ID = re.compile(r"\A[A-Za-z0-9._-]{1,64}\Z")
UTC = re.compile(r"\A(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?Z\Z")
ARCHES = {"aarch64": "arm64", "x86_64": "amd64"}
DEFAULT_ARCH = "arm64"


class Refused(Exception):
    def __init__(self, code, text):
        super().__init__(text)
        self.code, self.text = code, text


def log(msg):
    print(f"desk-host-batch: {msg}", file=sys.stderr, flush=True)


def parse_utc(s):
    """Seconds since the epoch for an exact UTC time such as 2026-11-09T18:00:00Z, else None."""
    if not isinstance(s, str):
        return None
    m = UTC.match(s)
    if not m:
        return None
    try:
        t = time.strptime(s[:19], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return None
    return calendar.timegm(t) + (float(m.group(7)) if m.group(7) else 0.0)


def read_limited(path, limit, owner=None):
    """A regular file's bytes, refusing links, other owners and anything over limit. Raises OSError or Refused."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise Refused("bad_request", f"{path} isn't a regular file")
        if owner is not None and st.st_uid != owner:
            raise Refused("bad_request", f"{path} isn't owned by uid {owner}")
        if st.st_size > limit:
            raise Refused("bad_request", f"{path} is over {limit} bytes")
        data = os.read(fd, limit + 1)
        if len(data) > limit:
            raise Refused("bad_request", f"{path} is over {limit} bytes")
        return data
    finally:
        os.close(fd)


def strict_json(data, what):
    """JSON with no repeated keys and no NaN, since a signed document two parsers read differently is worse than none."""
    def pairs(items):
        d = {}
        for k, v in items:
            if k in d:
                raise Refused("bad_request", f"{what}: key {k!r} appears twice")
            d[k] = v
        return d

    def constant(c):
        raise Refused("bad_request", f"{what}: {c} isn't JSON")
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)
    except (UnicodeDecodeError, ValueError, RecursionError) as e:
        raise Refused("bad_request", f"{what} isn't JSON: {type(e).__name__}") from None


def check_manifest(data):
    """The manifest's fields, checked. Unknown fields are ignored: anything a desk must understand bumps the format."""
    if len(data) > MAX_MANIFEST:
        raise Refused("bad_request", f"manifest over {MAX_MANIFEST} bytes")
    m = strict_json(data, "manifest")
    if not isinstance(m, dict):
        raise Refused("bad_request", "manifest isn't an object")
    if m.get("format") != FORMAT:
        raise Refused("bad_request", f"manifest format {m.get('format')!r} isn't {FORMAT}")
    seq = m.get("seq")
    if type(seq) is not int or not 1 <= seq <= MAX_SEQ:
        raise Refused("bad_request", "seq must be a whole number from 1")
    if not isinstance(m.get("id"), str) or not BATCH_ID.match(m["id"]):
        raise Refused("bad_request", "bad id")
    if parse_utc(m.get("created")) is None:
        raise Refused("bad_request", "created must be a UTC time like 2026-11-09T18:00:00Z")
    if type(m.get("urgent")) is not bool:
        raise Refused("bad_request", "urgent must be true or false")
    image = m.get("image")
    if image is not None and (not isinstance(image, str) or not VERSION.match(image)):
        raise Refused("bad_request", "bad image version")
    arch = m.get("arch", DEFAULT_ARCH)
    if arch not in ARCHES.values():
        raise Refused("bad_request", f"arch must be one of {', '.join(sorted(ARCHES.values()))}")
    note = m.get("note", "")
    if not isinstance(note, str) or len(note) > MAX_NOTE or any(ord(c) < 32 and c != "\n" or ord(c) == 127 for c in note):
        raise Refused("bad_request", f"note must be plain text, at most {MAX_NOTE} characters")
    comps = m.get("components")
    if not isinstance(comps, list) or not 1 <= len(comps) <= MAX_COMPONENTS:
        raise Refused("bad_request", f"components must list 1 to {MAX_COMPONENTS}")
    seen, out = set(), []
    for c in comps:
        if not isinstance(c, dict):
            raise Refused("bad_request", "a component isn't an object")
        name, ver, sha = c.get("name"), c.get("version"), c.get("sha256")
        if not isinstance(name, str) or not NAME.match(name) or name in RESERVED:
            raise Refused("bad_request", "bad component name")
        if name in seen:
            raise Refused("bad_request", f"{name} is named twice")
        if not isinstance(ver, str) or not VERSION.match(ver):
            raise Refused("bad_request", f"{name}: bad version")
        if not isinstance(sha, str) or not SHA256.match(sha):
            raise Refused("bad_request", f"{name}: bad sha256")
        seen.add(name)
        out.append({"name": name, "version": ver, "sha256": sha})
    return {"seq": seq, "id": m["id"], "created": m["created"], "urgent": m["urgent"], "image": image, "arch": arch,
            "note": note, "components": out}


def machine_arch():
    m = os.uname().machine
    return ARCHES.get(m, m)


def decode_signature(sig):
    """DER as the key service gives it, or that in base64."""
    sig = sig.strip() if sig[:1] != b"\x30" else sig
    if sig[:1] != b"\x30":
        try:
            sig = base64.b64decode(sig, validate=True)
        except (binascii.Error, ValueError):
            raise Refused("bad_request", "signature is neither DER nor base64") from None
    if not 8 <= len(sig) <= MAX_SIGNATURE or sig[:1] != b"\x30":
        raise Refused("bad_request", "signature isn't a DER ECDSA signature")
    return sig


def safe_dir(path, owner=None):
    """True for a real directory KEY_OWNER owns that nobody else can write."""
    owner = KEY_OWNER if owner is None else owner
    try:
        st = os.lstat(path)
    except OSError:
        return False
    return stat.S_ISDIR(st.st_mode) and st.st_uid == owner and not st.st_mode & 0o022


def is_p256(path):
    try:
        r = subprocess.run([OPENSSL, "pkey", "-pubin", "-in", path, "-noout", "-text"], capture_output=True, text=True,
                           timeout=10, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return r.returncode == 0 and ("prime256v1" in r.stdout or "P-256" in r.stdout)


def test_mode():
    if E("DESK_HOST_BATCH_TEST") == "1" and os.geteuid() != 0:
        return True   # the unit tests' temporary trees, never as root
    return os.path.exists("/etc/desk-host/test.conf") and os.path.isdir("/var/lib/desk-host/test")


def key_dirs():
    """A host's batch key directory, and a TEST host's test keys (a throwaway key only a test host trusts, ADR 0078 section 7)."""
    return [KEY_DIR] + ([TEST_KEY_DIR] if test_mode() else [])


def trusted_keys(dirs=None, owner=None):
    """The keys a batch may be signed with: *.pem in the key directories that pass every check. Anything else is skipped, and said."""
    owner = KEY_OWNER if owner is None else owner
    keys = []
    for d in dirs if dirs is not None else key_dirs():
        if not os.path.lexists(d):
            continue
        if not safe_dir(d, owner):
            log(f"skipping {d}: not a directory root alone can write")
            continue
        for name in sorted(os.listdir(d)):
            if not name.endswith(".pem"):
                continue
            p = os.path.join(d, name)
            try:
                st = os.lstat(p)
            except OSError:
                continue
            if not stat.S_ISREG(st.st_mode) or st.st_uid != owner or st.st_mode & 0o022 or st.st_size > MAX_KEY:
                log(f"skipping key {p}: not a regular file root alone can write")
                continue
            if not is_p256(p):
                log(f"skipping key {p}: not a P-256 public key")
                continue
            keys.append(p)
    return keys


def verify_signature(data, sig, keys):
    """The key that verifies sig over data's exact bytes, or Refused."""
    if not keys:
        raise Refused("untrusted", "no trusted key: every batch is refused until one is installed")
    with tempfile.TemporaryDirectory(prefix="desk-host-batch-") as t:
        mp, sp = os.path.join(t, "m"), os.path.join(t, "s")
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
    raise Refused("untrusted", "the signature doesn't verify with any trusted key")


def baseline(path=None, owner=None):
    """The host image's batch-baseline ({"seq": N}, written by the bake): 0 when there's none, MAX_SEQ (every batch refused) when
    it's unreadable, as desk-batch reads its own."""
    path = path or BASELINE
    owner = KEY_OWNER if owner is None else owner
    try:
        data = read_limited(path, 4096, owner=owner)
    except FileNotFoundError:
        return 0
    except (OSError, Refused):
        log(f"{path} unreadable: every batch is refused")
        return MAX_SEQ
    try:
        v = json.loads(data)
        v = v.get("seq") if isinstance(v, dict) else v
        if type(v) is int and 0 <= v <= MAX_SEQ:
            return v
    except ValueError:
        pass
    log(f"{path} unreadable: every batch is refused")
    return MAX_SEQ


def verify(manifest, sig_bytes, keys=None):
    """A batch's manifest and signature, in the order 1.3 step 1 checks them: the signature over the exact bytes first, then the
    fields. Returns (the checked manifest, the key that verified it). Raises Refused."""
    if len(manifest) > MAX_MANIFEST:
        raise Refused("bad_request", f"manifest over {MAX_MANIFEST} bytes")
    sig = decode_signature(sig_bytes)
    key = verify_signature(manifest, sig, trusted_keys() if keys is None else keys)
    return check_manifest(manifest), key
