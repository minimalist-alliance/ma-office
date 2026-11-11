"""tmpl.py: a shared-host template generation's artifact (ADR 0077 section 1.1), as the builder writes it and a host reads it.

One module for both halves of the contract, standard library only (Python 3.12 on the workstation, 3.13 on a host), no root
needed except to set owners and capabilities while unpacking. Used by image/host/template-builder/ (the builder),
tools/template/template-sign and tools/template/template-verify (the workstation), and the round trip.

The artifact, under desk/host-template/<host-image version>/<gen>/ in the release bucket:
  template.tar.zst   the generation's tree: a pax tar (GNU tar, --numeric-owner, entries sorted by name, the only extended
                     attribute security.capability), set-user-ID and set-group-ID bits cleared, compressed by zstd with no
                     long window. Never contains the tree's .complete, which each host writes itself at its seal.
  manifest.json      MANIFEST_FORMAT, canonical bytes (manifest_bytes): every path of the tree.
  plan.txt           "name=version\n" for every package whose version differs from g1's, sorted by name.
  header.json        FORMAT, the one signed file, at most 4096 bytes (KMS signs it RAW): see make_header.
  header.sig         ECDSA P-256 SHA-256 over header.json's exact bytes, DER (KMS's ECDSA_SHA_256, or openssl dgst).
  passed-build.json  PASS_FORMAT, the builder's record of every check.
  passed-test.json   written once the staging test host has passed it (Platform's, PU-3).

Manifest entries, in the host half's walk order (the top as ".", then depth first, each directory's names sorted), the same
bytes as its templates.manifest_of (agreed with sub/u77-host; the builder's status doc):
  {"path", "type": "dir" | "file" | "link", "mode": an integer, "uid", "gid"}
  + "size" and "sha256" for a file; "target" for a link (mode 0o777); "cap" (base64 of the raw security.capability) where a file
  has one. A hard link is a file like any other (same content, same inode). No device, FIFO or socket is ever listed.
  An artifact's modes are as packed: never a set-id bit, but the sticky and group- or other-write bits as the tree has them
  (/tmp and /var/tmp are 1777). tarfile's 'tar' filter clears those too, so an unpacker applies each member's packed mode itself
  (unpack below), as the host's does. g1's own manifest (header.base) keeps g1's set-id bits: it's g1 as the bake left it.
"""
import base64
import datetime
import hashlib
import hmac
import json
import os
import re
import stat
import subprocess
import tarfile
import tempfile
import urllib.parse

FORMAT = "ma-host-template/1"
MANIFEST_FORMAT = "ma-host-template-manifest/1"
PASS_FORMAT = "ma-host-template-pass/1"
ARCHIVE, MANIFEST, PLAN, HEADER, SIG, PASSED = "template.tar.zst", "manifest.json", "plan.txt", "header.json", "header.sig", "passed-build.json"
FILES = (ARCHIVE, MANIFEST, PLAN)
HEADER_MAX = 4096
SETID = stat.S_ISUID | stat.S_ISGID
CAP_XATTR = "security.capability"
PAX_CAP = "SCHILY.xattr." + CAP_XATTR
SKIP_TOP = (".complete",)   # never in a manifest or an archive: each host writes its own, last, at its seal
GEN_RE = re.compile(r"^g([1-9][0-9]{0,5})$")
VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+~-]{0,63}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
UTC_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")
OPENSSL = os.environ.get("TMPL_OPENSSL", "openssl")
ZSTD = os.environ.get("TMPL_ZSTD", "zstd")


def _write(path, mode, data):
    with open(path, mode) as f:
        f.write(data)


def _read(path):
    with open(path, "rb") as f:
        return f.read()


class Refused(Exception):
    """An artifact, a header, a manifest or a tree that fails a rule. str() says which and why."""


# ------------------------------------------------------------------------------------------------------------ small parts
def sha256_file(path):
    """(size, hex SHA-256) of a file's bytes."""
    h, n = hashlib.sha256(), 0
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
            n += len(b)
    return n, h.hexdigest()


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def strict_json(data, what):
    """JSON with no repeated key and no NaN or Infinity: a signed document two parsers read differently is worse than none."""
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
        raise Refused(f"{what} isn't JSON: {type(e).__name__}: {e}") from None


def gen_number(gen):
    m = GEN_RE.match(gen if isinstance(gen, str) else "")
    if not m:
        raise Refused(f"generation {gen!r} isn't g<n>")
    return int(m.group(1))


def canonical(obj):
    """The bytes this module writes for a manifest: sorted keys, no spaces, ASCII, one trailing newline (templates.canonical's)."""
    return (json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode()


# ------------------------------------------------------------------------------------------------------------ the manifest
def walk_tree(root, skip_top=SKIP_TOP):
    """(rel, lstat) for every path under root: '.' first, then depth first, each directory's names sorted; no link followed,
    one filesystem, the top's .complete left out. The host half's walk_tree (templates.py), so both make the same bytes."""
    top = os.lstat(root)
    yield ".", top

    def rec(d, rel):
        with os.scandir(d) as it:
            ents = sorted(((e.name, e.path, e.stat(follow_symlinks=False)) for e in it), key=lambda x: x[0])
        for name, path, st in ents:
            if rel == "." and name in skip_top:
                continue
            r = name if rel == "." else f"{rel}/{name}"
            yield r, st
            if stat.S_ISDIR(st.st_mode) and st.st_dev == top.st_dev:
                yield from rec(path, r)
    yield from rec(root, ".")


def entry_of(path, rel, st):
    """One manifest entry: the mode exactly as on disk (a tree to pack has had its set-id bits cleared: clear_setid)."""
    m = st.st_mode
    e = {"path": rel, "mode": stat.S_IMODE(m), "uid": st.st_uid, "gid": st.st_gid}
    if stat.S_ISDIR(m):
        e["type"] = "dir"
    elif stat.S_ISREG(m):
        e["type"] = "file"
        e["size"], e["sha256"] = sha256_file(path)
        try:
            cap = os.getxattr(path, CAP_XATTR, follow_symlinks=False)
        except OSError:
            cap = None
        if cap:
            e["cap"] = base64.b64encode(cap).decode()
    elif stat.S_ISLNK(m):
        e["type"] = "link"
        e["mode"] = 0o777
        e["target"] = os.fsdecode(os.readlink(path))
    else:
        raise Refused(f"{rel}: a device, FIFO or socket can't be in a template")
    return e


def walk(root, skip_top=SKIP_TOP):
    """Every path under root as a manifest entry, in the manifest's order."""
    root = os.path.abspath(root)
    return [entry_of(root if rel == "." else os.path.join(root, rel), rel, st) for rel, st in walk_tree(root, skip_top)]


def clear_setid(root):
    """Clears every set-user-ID and set-group-ID bit under root, as packing would (the host's extractor refuses them); returns
    the paths it changed. The builder does it at the seal, so its checks and its slot run on the tree the hosts will have."""
    out = []
    for rel, st in walk_tree(root):
        if not stat.S_ISLNK(st.st_mode) and st.st_mode & SETID:
            os.chmod(root if rel == "." else os.path.join(root, rel), stat.S_IMODE(st.st_mode) & ~SETID)
            out.append(rel)
    return out


def manifest_bytes(entries):
    """The manifest's one serialization, the host half's (templates.manifest_of): {"format", "entries"}, sorted keys, no
    spaces, ASCII, one newline. g1's on a host and on the builder are then the same bytes, and header.base matches."""
    return canonical({"format": MANIFEST_FORMAT, "entries": entries})


ENTRY_KEYS = {"dir": {"path", "type", "mode", "uid", "gid"},
              "file": {"path", "type", "mode", "uid", "gid", "size", "sha256", "cap"},
              "link": {"path", "type", "mode", "uid", "gid", "target"}}


def _int(v, hi):
    return type(v) is int and 0 <= v <= hi


def parse_manifest(data, allow_setid=False):
    """The manifest's entries, each checked: known types and fields, unique paths, the top first and every directory before
    what's in it, no set-id bit (an artifact's; g1's own may have them: allow_setid), owners 0 to 65535, paths that stay inside
    the tree. Returns the list (in order) and a dict by path."""
    m = strict_json(data, "manifest")
    if not isinstance(m, dict) or m.get("format") != MANIFEST_FORMAT or not isinstance(m.get("entries"), list):
        raise Refused(f"manifest: format isn't {MANIFEST_FORMAT}, or no entries")
    entries, by = m["entries"], {}
    for e in entries:
        if not isinstance(e, dict) or e.get("type") not in ENTRY_KEYS:
            raise Refused(f"manifest: a bad entry {str(e)[:120]}")
        if not set(e) <= ENTRY_KEYS[e["type"]] or not ENTRY_KEYS[e["type"]] - {"cap"} <= set(e):
            raise Refused(f"manifest: {e.get('path')!r} has fields {sorted(e)}")
        p = e["path"]
        if not isinstance(p, str) or p == "" or "\0" in p or (p != "." and (p.startswith("/") or any(x in ("", ".", "..") for x in p.split("/")))):
            raise Refused(f"manifest: path {p!r} isn't a clean relative path")
        if p in by:
            raise Refused(f"manifest: {p!r} appears twice")
        if not _int(e["mode"], 0o7777) or (e["mode"] & SETID and not allow_setid):
            raise Refused(f"manifest: {p!r} mode {e['mode']!r} (0 to 07777, never a set-id bit)")
        for f in ("uid", "gid"):
            if not _int(e[f], 65535):
                raise Refused(f"manifest: {p!r} {f} {e[f]!r}")
        if e["type"] == "file":
            if not _int(e["size"], 1 << 50) or not HEX64.match(str(e["sha256"])):
                raise Refused(f"manifest: {p!r} size or sha256")
            if "cap" in e:
                try:
                    ok = isinstance(e["cap"], str) and 0 < len(base64.b64decode(e["cap"], validate=True)) <= 64
                except ValueError:
                    ok = False
                if not ok:
                    raise Refused(f"manifest: {p!r} cap")
        if e["type"] == "link" and not (isinstance(e["target"], str) and 0 < len(e["target"]) <= 4096 and "\0" not in e["target"]):
            raise Refused(f"manifest: {p!r} target")
        if p == "." and by:
            raise Refused("manifest: the top must come first")
        if p != "." and by.get(p.rsplit("/", 1)[0] if "/" in p else ".", {}).get("type") != "dir":
            raise Refused(f"manifest: {p!r} comes before, or without, the directory above it")
        by[p] = e
    if not entries or entries[0]["path"] != "." or entries[0]["type"] != "dir":
        raise Refused("manifest: the first entry must be the tree's top, a directory")
    return entries, by


def compare(want, got, owners=True, limit=20):
    """Differences between two manifests' entries (lists), as strings; empty when they're equal. owners=False skips uid and
    gid (an unpack by a user who isn't root can't set them; the archive's own owners were checked as it was read)."""
    w = {e["path"]: e for e in want}
    g = {e["path"]: e for e in got}
    out = []
    for p in sorted(set(w) | set(g), key=lambda s: s.encode()):
        if p not in g:
            out.append(f"missing {p}")
        elif p not in w:
            out.append(f"not in the manifest {p}")
        else:
            a, b = dict(w[p]), dict(g[p])
            if not owners:
                for f in ("uid", "gid"):
                    a.pop(f, None)
                    b.pop(f, None)
            if a != b:
                keys = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
                out.append(f"differs {p}: " + ", ".join(f"{k} {a.get(k)!r} -> {b.get(k)!r}" for k in keys))
        if len(out) >= limit:
            out.append("...")
            break
    return out


# ------------------------------------------------------------------------------------------------------------ the header
def make_header(gen, host_image, chromium, base, files, urgent=False, created=None):
    """header.json's bytes. files: {name: (size, sha256)} for exactly FILES. base: the SHA-256 of g1's manifest."""
    created = created or datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    h = {"format": FORMAT, "gen": gen, "hostImage": host_image, "created": created, "urgent": bool(urgent),
         "chromium": chromium, "base": base, "files": {n: {"size": s, "sha256": d} for n, (s, d) in sorted(files.items())}}
    data = (json.dumps(h, sort_keys=True, indent=1) + "\n").encode("utf-8")
    check_header_fields(h)
    if len(data) > HEADER_MAX:
        raise Refused(f"header is {len(data)} bytes, over {HEADER_MAX}")
    return data


def check_header_fields(h):
    if not isinstance(h, dict):
        raise Refused("header isn't an object")
    if h.get("format") != FORMAT:
        raise Refused(f"header format {h.get('format')!r}, not {FORMAT}")
    want = {"format", "gen", "hostImage", "created", "urgent", "chromium", "base", "files"}
    if set(h) != want:
        raise Refused(f"header fields {sorted(h)}, want {sorted(want)}")
    if gen_number(h["gen"]) < 2:
        raise Refused("header gen must be g2 or later: g1 is each host's own bake")
    if not (isinstance(h["hostImage"], str) and VERSION_RE.match(h["hostImage"])):
        raise Refused("header hostImage")
    if not (isinstance(h["created"], str) and UTC_RE.match(h["created"])):
        raise Refused("header created must be like 2026-11-11T18:00:00Z")
    if not isinstance(h["urgent"], bool):
        raise Refused("header urgent must be true or false")
    if not (isinstance(h["chromium"], str) and VERSION_RE.match(h["chromium"].replace(":", ""))):
        raise Refused("header chromium")
    if not (isinstance(h["base"], str) and HEX64.match(h["base"])):
        raise Refused("header base must be g1's manifest SHA-256")
    f = h["files"]
    if not isinstance(f, dict) or set(f) != set(FILES):
        raise Refused(f"header files must be exactly {list(FILES)}")
    for n, v in f.items():
        if not (isinstance(v, dict) and set(v) == {"size", "sha256"} and isinstance(v["size"], int) and not isinstance(v["size"], bool)
                and v["size"] >= 0 and isinstance(v["sha256"], str) and HEX64.match(v["sha256"])):
            raise Refused(f"header files.{n} must be {{size, sha256}}")


def parse_header(data, host_image=None, gens_had=(), order_sha256=None):
    """header.json checked as a member host checks it (ADR 0077 1.4 step 3, after the signature): at most 4 KiB, strict
    JSON, the format, every field; then, where given, this host's image version, a gen above every one the host has had
    (current, previous, candidate or halted), and the order's SHA-256 of these exact bytes."""
    if len(data) > HEADER_MAX:
        raise Refused(f"header is {len(data)} bytes, over {HEADER_MAX}")
    h = strict_json(data, "header")
    check_header_fields(h)
    if host_image is not None and h["hostImage"] != host_image:
        raise Refused(f"header is for host image {h['hostImage']}, this host is {host_image}")
    if gens_had and gen_number(h["gen"]) <= max(gen_number(g) for g in gens_had):
        raise Refused(f"header gen {h['gen']} isn't above every generation this host has had ({', '.join(sorted(gens_had))})")
    if order_sha256 is not None and sha256_bytes(data) != order_sha256:
        raise Refused("header's SHA-256 isn't the order's")
    return h


# ------------------------------------------------------------------------------------------------------------ signatures
def is_p256(pem_path):
    r = subprocess.run([OPENSSL, "pkey", "-pubin", "-in", pem_path, "-noout", "-text"], capture_output=True, text=True, timeout=10)
    return r.returncode == 0 and ("prime256v1" in r.stdout or "P-256" in r.stdout)


def verify_sig(data, sig, keys):
    """The key (a PEM path) that verifies sig over data's exact bytes; Refused when none does. Only P-256 keys count."""
    keys = [k for k in keys if is_p256(k)]
    if not keys:
        raise Refused("no trusted P-256 key: every artifact is refused")
    if not sig or len(sig) > 128:
        raise Refused("no signature, or not one ECDSA P-256 signature")
    with tempfile.TemporaryDirectory(prefix="tmpl-") as t:
        mp, sp = os.path.join(t, "m"), os.path.join(t, "s")
        with open(mp, "wb") as f:
            f.write(data)
        with open(sp, "wb") as f:
            f.write(sig)
        for k in keys:
            r = subprocess.run([OPENSSL, "dgst", "-sha256", "-verify", k, "-signature", sp, mp], capture_output=True, timeout=10)
            if r.returncode == 0:
                return k
    raise Refused("the signature doesn't verify with any trusted key")


def sign_with_key(data, private_pem):
    """A dev key's signature (DER), as KMS's ECDSA_SHA_256 gives one."""
    with tempfile.TemporaryDirectory(prefix="tmpl-") as t:
        mp, sp = os.path.join(t, "m"), os.path.join(t, "s")
        with open(mp, "wb") as f:
            f.write(data)
        subprocess.run([OPENSSL, "dgst", "-sha256", "-sign", private_pem, "-out", sp, mp], check=True, capture_output=True, timeout=10)
        return _read(sp)


def public_pem(private_pem, out):
    subprocess.run([OPENSSL, "pkey", "-in", private_pem, "-pubout", "-out", out], check=True, capture_output=True, timeout=10)


# ------------------------------------------------------------------------------------------------------------ pack
def pack(tree, out, level=9, threads=0):
    """The tree's archive (as module docstring), written to out. GNU tar and zstd; run as root, so every owner and
    security.capability is read. Returns (size, sha256)."""
    tar = ["tar", "-C", tree, "--numeric-owner", "--format=pax", "--xattrs", "--xattrs-include=" + CAP_XATTR, "--no-acls",
           "--no-selinux", "--sort=name", "--mode=ug-s", "--one-file-system"] + [f"--exclude=./{n}" for n in SKIP_TOP] + ["-cf", "-", "."]
    with open(out, "wb") as f:
        t = subprocess.Popen(tar, stdout=subprocess.PIPE)
        z = subprocess.Popen([ZSTD, "-q", f"-{int(level)}", f"-T{int(threads)}", "-c"], stdin=t.stdout, stdout=f)
        t.stdout.close()
        rz, rt = z.wait(), t.wait()
    if rt != 0 or rz != 0:
        raise Refused(f"pack failed: tar exit {rt}, zstd exit {rz}")
    return sha256_file(out)


# ------------------------------------------------------------------------------------------------------------ unpack
def _norm(name):
    n = name[2:] if name.startswith("./") else name
    n = n.rstrip("/")
    return "." if n in ("", ".") else n


def _inside(dest, rel_link_dir, target):
    """True when a link at <rel_link_dir>/x pointing at target stays inside the tree; an absolute target is the tree's own
    root (a desk's links point at its root), as desk-host-check's in_template reads them."""
    base = "" if target.startswith("/") else ("" if rel_link_dir == "." else rel_link_dir)
    depth = 0 if base == "" else len(base.split("/"))
    for part in target.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            depth -= 1
            if depth < 0:
                return False
        else:
            depth += 1
    return True


def unpack(archive, dest, entries, by_path=None, as_root=None):
    """Unpack archive into dest (which must not exist), checked as a member host checks it (ADR 0077 1.4 steps 5 and 6):
    every member through tarfile's 'tar' filter and listed by the manifest with its type, link target, owner, mode, size,
    SHA-256 and capability; no member outside the tree, no link pointing out of it, no device file; each file hashed as it's
    written, nothing read back; every manifest entry present. Modes come from the manifest (the 'tar' filter would clear the
    sticky and group- and other-write bits it carries). Owners and capabilities are set only as root. Refused on any
    failure, with dest left for the caller to remove."""
    as_root = os.geteuid() == 0 if as_root is None else as_root
    by = by_path or {e["path"]: e for e in entries}
    os.mkdir(dest, 0o700)
    dest = os.path.realpath(dest)
    seen, dirs = set(), []
    z = subprocess.Popen([ZSTD, "-q", "-d", "-c", "--", archive], stdout=subprocess.PIPE)
    try:
        with tarfile.open(fileobj=z.stdout, mode="r|") as tf:
            for m in tf:
                name = _norm(m.name)
                e = by.get(name)
                if e is None:
                    raise Refused(f"member {m.name!r} isn't in the manifest")
                if name in seen:
                    raise Refused(f"member {name!r} appears twice")
                if m.isdev() or m.isfifo() or m.ischr() or m.isblk():
                    raise Refused(f"member {name!r} is a device file or a FIFO")
                try:
                    tarfile.tar_filter(m, dest)
                except tarfile.FilterError as x:
                    raise Refused(f"member {name!r}: tarfile's tar filter: {x}") from None
                xattrs = {k: v for k, v in m.pax_headers.items() if k.startswith("SCHILY.xattr.") or k.startswith("LIBARCHIVE.xattr.")}
                if set(xattrs) - {PAX_CAP}:
                    raise Refused(f"member {name!r} carries extended attributes beyond {CAP_XATTR}: {sorted(xattrs)}")
                cap = xattrs.get(PAX_CAP)
                cap = base64.b64encode(cap.encode("utf-8", "surrogateescape")).decode() if cap is not None else None
                if cap != e.get("cap"):
                    raise Refused(f"member {name!r}: capability {cap} isn't the manifest's {e.get('cap')}")
                if (m.uid, m.gid) != (e["uid"], e["gid"]):
                    raise Refused(f"member {name!r}: owner {m.uid}:{m.gid}, the manifest says {e['uid']}:{e['gid']}")
                mode = e["mode"]
                if (m.mode & 0o7777) != mode and not m.issym():
                    raise Refused(f"member {name!r}: mode {m.mode & 0o7777:04o}, the manifest says {e['mode']:04o}")
                target = dest if name == "." else os.path.join(dest, name)
                parent = os.path.dirname(target)
                if name != "." and (os.path.realpath(parent) != parent or not os.path.isdir(parent)):
                    raise Refused(f"member {name!r}: its directory isn't a plain directory of the tree")
                rel_dir = name.rsplit("/", 1)[0] if "/" in name else "."
                if m.isdir():
                    if e["type"] != "dir":
                        raise Refused(f"member {name!r} is a directory, the manifest says {e['type']}")
                    if name != ".":
                        os.mkdir(target, 0o700)
                    dirs.append((target, e, m.mtime))
                elif m.issym():
                    if e["type"] != "link" or m.linkname != e["target"]:
                        raise Refused(f"member {name!r}: link {m.linkname!r}, the manifest says {e.get('type')} {e.get('target')!r}")
                    if not _inside(dest, rel_dir, m.linkname):
                        raise Refused(f"member {name!r}: link {m.linkname!r} points out of the tree")
                    os.symlink(m.linkname, target)
                    if as_root:
                        os.lchown(target, e["uid"], e["gid"])
                    os.utime(target, (m.mtime, m.mtime), follow_symlinks=False)
                elif m.islnk():
                    other = _norm(m.linkname)
                    o = by.get(other)
                    if e["type"] != "file" or other not in seen or o is None or o["type"] != "file" \
                            or (o["size"], o["sha256"], o["mode"], o["uid"], o["gid"], o.get("cap")) != (e["size"], e["sha256"], e["mode"], e["uid"], e["gid"], e.get("cap")):
                        raise Refused(f"member {name!r}: a hard link to {m.linkname!r} that the manifest doesn't match")
                    os.link(os.path.join(dest, other), target, follow_symlinks=False)
                elif m.isreg():
                    if e["type"] != "file" or m.size != e["size"]:
                        raise Refused(f"member {name!r}: a file of {m.size} bytes, the manifest says {e['type']} {e.get('size')}")
                    src = tf.extractfile(m)
                    h, n = hashlib.sha256(), 0
                    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
                    with os.fdopen(fd, "wb") as out:
                        for b in iter(lambda: src.read(1 << 20), b""):
                            h.update(b)
                            n += len(b)
                            out.write(b)
                        if n != e["size"] or h.hexdigest() != e["sha256"]:
                            raise Refused(f"member {name!r}: its bytes don't hash to the manifest's SHA-256")
                        if as_root:
                            os.fchown(out.fileno(), e["uid"], e["gid"])
                            if cap:
                                os.setxattr(out.fileno(), CAP_XATTR, base64.b64decode(cap))
                        os.fchmod(out.fileno(), mode)
                    os.utime(target, (m.mtime, m.mtime))
                else:
                    raise Refused(f"member {name!r}: a type no template has")
                seen.add(name)
    except tarfile.TarError as x:
        raise Refused(f"the archive isn't a readable tar: {x}") from None
    finally:
        z.stdout.close()
        rz = z.wait()
    if rz != 0:
        raise Refused(f"zstd couldn't decompress the archive (exit {rz})")
    missing = [p for p in by if p not in seen]
    if missing:
        raise Refused(f"{len(missing)} manifest entries aren't in the archive, first {missing[:3]}")
    for target, e, mtime in reversed(dirs):   # deepest first, so a read-only directory is closed after its contents
        if as_root:
            os.lchown(target, e["uid"], e["gid"])
        os.chmod(target, e["mode"])
        os.utime(target, (mtime, mtime))
    return len(seen)


# ------------------------------------------------------------------------------------------------------------ pass record
def check_pass(data, header_bytes):
    """passed-build.json passes: its format, a pass result, every check pass or skip, and the header it names is these bytes."""
    p = strict_json(data, "passed-build.json")
    if not isinstance(p, dict) or p.get("format") != PASS_FORMAT:
        raise Refused(f"passed-build.json format isn't {PASS_FORMAT}")
    h = strict_json(header_bytes, "header")
    if p.get("header") != sha256_bytes(header_bytes):
        raise Refused("passed-build.json names another header")
    if p.get("gen") != h.get("gen") or p.get("hostImage") != h.get("hostImage"):
        raise Refused("passed-build.json is for another generation or host image")
    checks = p.get("checks")
    if not isinstance(checks, list) or not checks:
        raise Refused("passed-build.json lists no checks")
    bad = [c.get("name") for c in checks if not isinstance(c, dict) or c.get("result") not in ("pass", "skip")]
    if bad or p.get("result") != "pass":
        raise Refused(f"passed-build.json doesn't pass: result {p.get('result')!r}, failed {bad}")
    return p


# ------------------------------------------------------------------------------------------------------------ S3 upload URLs
def presign_put(bucket, key, sha256_hex, creds, region="us-east-1", expires=3600, now=None):
    """A presigned S3 PUT URL (SigV4, query auth) that S3 accepts only with the header x-amz-checksum-sha256 set to this
    SHA-256 (base64), which is signed, so the body must hash to it or S3 refuses the bytes. creds: AccessKeyId,
    SecretAccessKey and optionally SessionToken (aws configure export-credentials). Returns (url, header value)."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    amz, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    host = f"{bucket}.s3.{region}.amazonaws.com"
    b64 = base64.b64encode(bytes.fromhex(sha256_hex)).decode()
    scope = f"{day}/{region}/s3/aws4_request"
    q = {"X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": f"{creds['AccessKeyId']}/{scope}", "X-Amz-Date": amz,
         "X-Amz-Expires": str(int(expires)), "X-Amz-SignedHeaders": "host;x-amz-checksum-sha256"}
    if creds.get("SessionToken"):
        q["X-Amz-Security-Token"] = creds["SessionToken"]
    enc = lambda s: urllib.parse.quote(s, safe="-_.~")  # noqa: E731
    cq = "&".join(f"{enc(k)}={enc(v)}" for k, v in sorted(q.items()))
    path = "/" + urllib.parse.quote(key, safe="-_.~/")
    creq = "\n".join(["PUT", path, cq, f"host:{host}\nx-amz-checksum-sha256:{b64}\n", "host;x-amz-checksum-sha256", "UNSIGNED-PAYLOAD"])
    sts = "\n".join(["AWS4-HMAC-SHA256", amz, scope, hashlib.sha256(creq.encode()).hexdigest()])
    k = ("AWS4" + creds["SecretAccessKey"]).encode()
    for part in (day, region, "s3", "aws4_request"):
        k = hmac.new(k, part.encode(), hashlib.sha256).digest()
    sig = hmac.new(k, sts.encode(), hashlib.sha256).hexdigest()
    return f"https://{host}{path}?{cq}&X-Amz-Signature={sig}", b64
