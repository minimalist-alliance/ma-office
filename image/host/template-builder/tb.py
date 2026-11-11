#!/usr/bin/python3 -I
"""tb.py: the template builder's steps (ADR 0077 sections 1.2 and 1.3), on a temporary builder launched from a host AMI by
image/host/template-build.sh, as root. Never on a member host: template-build.sh copies it to /var/lib/ma-tb/tools for one
run, and the builder is terminated after it. Every step fails closed (exit 1, nothing packed or uploaded) and says why;
each check's result goes to /var/lib/ma-tb/run/checks.jsonl, which passed-build.json lists.

  tb.py base --host-image <v>                 1. g1 against the bake's manifest (or one computed here, for a pre-0077 image)
  tb.py copy --gen <gN>                       3. g1 copied to templates/.build-<gN>; the copy's end time recorded
  tb.py plan --gen <gN> --source security|test [--current-chromium <v>]
                                              4. apt-get update, -s upgrade (the plan), --download-only; exit 3 if the plan is empty
  tb.py install --gen <gN>                    5. the tree's own apt-get --no-download upgrade in the install sandbox
  tb.py seal --gen <gN>                       the tree sealed as a member host seals one: owner, manifest, .complete, read-only
  tb.py check --gen <gN> [--force-carry] [--mutate-guard]   1.3 items 1 to 7 and template-apt
  tb.py pack --gen <gN> [--urgent] [--level 9] 7. archive, manifest, plan, header; then the round trip; then passed-build.json
  tb.py roundtrip --gen <gN> [--flip-byte]    the round trip alone (--flip-byte: one byte of a copy changed, which it must refuse)
  tb.py upload                                the artifact through presigned PUT URLs read from stdin (JSON {file: [url, b64]})
  tb.py testrepo [--package netbase] [--postinst-mutation] [--resign-other-key]   the local test archive (section 7)
  tb.py template-apt [--mutate stable-line|no-kernel-pin]   the template-apt check alone (its mutation pass)
  tb.py record <name> <pass|fail|skip> <detail>   a check run elsewhere (the slot start), into checks.jsonl
  tb.py reset-build --gen <gN>                drops the build tree, its sealed tree and the run's records (a second build)
"""
import ctypes
import datetime
import errno
import glob
import hashlib
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import tmpl  # noqa: E402

TB = os.environ.get("TB_DIR", "/var/lib/ma-tb")
RUN, OUT = f"{TB}/run", f"{TB}/out"
CONF = "/run/ma-tb"                      # apt's files for the build: on the builder's tmpfs, bound read-only into the sandbox
DH = "/srv/desk-host"
G1 = f"{DH}/template"                   # host 0.1.x's template: g1
TPL = f"{DH}/templates"
LIB = "/usr/local/lib/desk-host"
SANDBOX_BASE = 100000 + 30 * 65536      # the install sandbox's uid range: slot 30's, which no host has (SLOTS_MAX 29)
CHROMIUM_USER = 1102                    # kiosk, as on a desk
SECURITY = "https://security.debian.org/debian-security"
SUITE = "trixie-security"
COMPONENTS = "main contrib non-free non-free-firmware"
KERNEL_PIN = ("linux-image-* linux-headers-* linux-kbuild-* linux-signed-* linux-base grub* shim* initramfs-tools* dracut* "
              "systemd-boot* u-boot* flash-kernel*")
# 1.3 item 2: what dpkg and its triggers may write besides an upgraded package's own files (ADR 0077's list), and the
# builder's own scaffolding (usr/sbin: policy-rc.d is put in and taken out again around the install).
# Two beside the ADR's list, both trigger caches like the ones it names, and found by the first real build (0.1.10, apt and vim):
# ldconfig's own aux-cache beside /etc/ld.so.cache (libc-bin's trigger), and man-db's index (man-db's trigger, var/cache/man).
ALLOWED_PREFIXES = ("var/lib/dpkg/", "var/lib/apt/", "var/cache/apt/", "var/cache/debconf/", "etc/alternatives/",
                    "usr/share/mime/", "var/cache/fontconfig/", "var/cache/ldconfig/", "var/cache/man/")
ALLOWED_EXACT = ("etc/ld.so.cache", ".", "var/lib/dpkg", "var/lib/apt", "var/cache/apt", "var/cache/debconf", "etc/alternatives",
                 "usr/share/mime", "var/cache/fontconfig", "var/cache/ldconfig", "var/cache/man", "usr/sbin")
ALLOWED_RE = (re.compile(r"(^|/)__pycache__(/|$)"), re.compile(r"^usr/share/icons/[^/]+/icon-theme\.cache$"),
              re.compile(r"^usr/lib/[^/]+/gdk-pixbuf-2\.0/2\.10\.0/loaders\.cache$"))
# Must stay byte-identical (1.3 item 2): desk-host's additions and the desk's own trees
# Rewritten with nothing changed: a maintainer script's deb-systemd-helper records (apt's postinst for its masked timers).
# Allowed only when the entry is byte-identical to g1's; any real change there (a unit newly enabled) still fails.
SAME_OK_PREFIXES = ("var/lib/systemd/deb-systemd-helper-enabled/", "var/lib/systemd/deb-systemd-helper-masked/")
SAME_OK_EXACT = ("var/lib/systemd/deb-systemd-helper-enabled", "var/lib/systemd/deb-systemd-helper-masked")
PROTECTED_PREFIXES = ("etc/ma/", "usr/local/", "opt/ma/", "usr/share/ma/", "etc/chromium/policies/")
PROTECTED_EXACT = ("etc/ma", "usr/local", "opt/ma", "usr/share/ma", "etc/chromium/policies", "etc/nftables.conf", "etc/resolv.conf",
                   "etc/machine-id", "etc/ma/desk-rtc.conf")
HOST_IDS = range(1107, 1113)            # desk-x, desk-snd, desk-dns, (1110 commons), desk-audio, desk-data
GST_REGISTRY = "usr/local/lib/ma/gst-registry.bin"


# ------------------------------------------------------------------------------------------------------------ records
def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg):
    print(f"[tb {datetime.datetime.now(datetime.timezone.utc).strftime('%H:%M:%S')}] {msg}", flush=True)


class Fail(Exception):
    pass


def state():
    try:
        with open(f"{RUN}/state.json") as f:
            return json.load(f)
    except OSError:
        return {"times": {}}


def save_state(s):
    os.makedirs(RUN, exist_ok=True)
    with open(f"{RUN}/state.json.tmp", "w") as f:
        json.dump(s, f, indent=1)
    os.rename(f"{RUN}/state.json.tmp", f"{RUN}/state.json")


def record(name, result, detail):
    os.makedirs(RUN, exist_ok=True)
    with open(f"{RUN}/checks.jsonl", "a") as f:
        f.write(json.dumps({"name": name, "result": result, "detail": str(detail)[:4000], "at": now()}) + "\n")
    log(f"{result.upper():4} {name}: {str(detail)[:600]}")


def checks():
    out = {}
    try:
        for line in open(f"{RUN}/checks.jsonl"):
            c = json.loads(line)
            out[c["name"]] = c   # the last result of each name counts
    except OSError:
        pass
    return list(out.values())


def timed(name):
    """A decorator-free timer: with timed('x'): ... records the step's seconds in state.json."""
    class T:
        def __enter__(self):
            self.t0 = time.time()

        def __exit__(self, *a):
            s = state()
            s.setdefault("times", {})[name] = round(time.time() - self.t0, 1)
            save_state(s)
    return T()


def sh(*cmd, check=True, capture=True, env=None, input=None, timeout=None):
    r = subprocess.run(cmd, capture_output=capture, text=True, env=env, input=input, timeout=timeout)
    if check and r.returncode != 0:
        raise Fail(f"{' '.join(cmd[:4])}...: exit {r.returncode}: {(r.stderr or '')[-1500:]}{(r.stdout or '')[-500:]}")
    return r


def build_dir(gen):
    return f"{TPL}/.build-{gen}"


def sealed_dir(gen):
    return f"{TPL}/{gen}"


def complete_fields(path):
    out = {}
    for line in open(f"{path}/.complete"):
        if "=" in line:
            k, v = line.rstrip("\n").split("=", 1)
            out[k] = v
    return out


def dpkg_versions(tree):
    """{package: (status abbrev, version)} from a tree's own dpkg database, read only."""
    r = sh("dpkg-query", f"--admindir={tree}/var/lib/dpkg", "-W", "-f", "${db:Status-Abbrev}|${Package}|${Version}\n")
    out = {}
    for line in r.stdout.splitlines():
        st, pkg, ver = line.split("|", 2)
        out[pkg] = (st.strip(), ver)
    return out


def chromium_version(tree):
    v = dpkg_versions(tree).get("chromium")
    if not v or v[0] != "ii":
        raise Fail(f"{tree} has no installed chromium package")
    return v[1]


def version_ge(a, b):
    return subprocess.run(["dpkg", "--compare-versions", a, "ge", b]).returncode == 0


def upstream(v):
    """1:156.0.8078.79-1~deb13u1 -> 156.0.8078.79, as desk-browser-start reads it"""
    return v.split(":", 1)[-1].split("-", 1)[0]


# ------------------------------------------------------------------------------------------------------------ 1. base
def cmd_base(a):
    with timed("base"):
        f = complete_fields(G1)
        if f.get("host-version") != a.host_image:
            raise Fail(f"g1's .complete says host-version={f.get('host-version')}, not {a.host_image}")
        entries = tmpl.walk(G1)
        data = tmpl.manifest_bytes(entries)   # the host half's templates.manifest_of bytes: a host's own g1.json, so base matches
        os.makedirs(RUN, exist_ok=True)
        with open(f"{RUN}/g1.json", "wb") as fh:
            fh.write(data)
        baked = "/var/lib/desk-host/templates/g1.json"
        if os.path.exists(baked):
            with open(baked, "rb") as fh:
                bk = fh.read()
            ok = tmpl.compare(tmpl.parse_manifest(bk, allow_setid=True)[0], entries) == []
            detail = f"g1 ({len(entries)} paths) {'matches' if ok else 'DIFFERS FROM'} the bake's manifest {tmpl.sha256_bytes(bk)[:12]}"
        else:
            ok, detail = True, (f"g1 ({len(entries)} paths, {sum(e.get('size', 0) for e in entries) / 1e9:.2f} GB): the host image predates "
                                f"ADR 0077 and its bake wrote no manifest, so it's computed here, {tmpl.sha256_bytes(data)[:12]}")
        s = state()
        s.update({"hostImage": a.host_image, "g1Manifest": tmpl.sha256_bytes(data), "g1Chromium": chromium_version(G1), "g1Entries": len(entries)})
        save_state(s)
        record("base", "pass" if ok else "fail", detail)
        if not ok:
            raise Fail(detail)


# ------------------------------------------------------------------------------------------------------------ 3. copy
def cmd_copy(a):
    with timed("copy"):
        os.makedirs(TPL, mode=0o711, exist_ok=True)
        b = build_dir(a.gen)
        for stale in glob.glob(f"{TPL}/.build-*") + glob.glob(f"{TPL}/.rt-*"):
            log(f"removing a tree an earlier run left: {stale}")
            subprocess.run(["umount", "-R", stale], capture_output=True)
            shutil.rmtree(stale)
        os.mkdir(b, 0o755)
        t0 = time.time()
        tar_out = subprocess.Popen(["tar", "-C", G1, "--numeric-owner", "--xattrs", "--xattrs-include=security.capability", "--one-file-system",
                                    "-cf", "-", "."], stdout=subprocess.PIPE)
        r = subprocess.run(["tar", "-C", b, "--numeric-owner", "--xattrs", "--xattrs-include=security.capability", "-xpf", "-"], stdin=tar_out.stdout)
        tar_out.stdout.close()
        if tar_out.wait() != 0 or r.returncode != 0:
            raise Fail("copying g1 failed")
        os.unlink(f"{b}/.complete")
        time.sleep(0.05)
        end = time.time_ns()
        s = state()
        s.update({"gen": a.gen, "copyEndNs": end, "copySeconds": round(time.time() - t0, 1)})
        save_state(s)
        log(f"g1 copied to {b} in {time.time() - t0:.0f} s")


# ------------------------------------------------------------------------------------------------------------ 4. plan
def keyring():
    for k in ("/usr/share/keyrings/debian-archive-keyring.pgp", "/usr/share/keyrings/debian-archive-keyring.gpg"):
        if os.path.exists(k):
            return k
    raise Fail("the builder has no debian-archive-keyring")


def write_apt_conf(source, mutate=None):
    """The one source file, the pins and an empty parts directory, in CONF (the builder's tmpfs, bound into the sandbox)."""
    os.makedirs(f"{CONF}/empty", exist_ok=True)
    if source == "security":
        line = f"deb [signed-by={keyring()}] {SECURITY} {SUITE} {COMPONENTS}"
    else:
        line = f"deb [signed-by={CONF}/testrepo/key.gpg] copy:{CONF}/testrepo {SUITE} main"
    lines = [line]
    if mutate == "stable-line":
        lines.append(f"deb [signed-by={keyring()}] https://deb.debian.org/debian trixie main")
    with open(f"{CONF}/sources.list", "w") as f:
        f.write("\n".join(lines) + "\n")
    pin = ("Explanation: ADR 0077 1.2: the template never boots its own kernel and has no /boot\n"
           f"Package: {KERNEL_PIN}\nPin: release *\nPin-Priority: -1\n")
    with open(f"{CONF}/preferences", "w") as f:
        f.write("" if mutate == "no-kernel-pin" else pin)
    with open(f"{CONF}/policy-rc.d", "w") as f:
        f.write("#!/bin/sh\n# the template builder's install sandbox (ADR 0077 1.2 step 5): no service starts\nexit 101\n")
    os.chmod(f"{CONF}/policy-rc.d", 0o755)
    s = state()
    s["source"] = source
    save_state(s)


def apt_opts(tree):
    return ["-o", f"Dir::State={tree}/var/lib/apt", "-o", f"Dir::State::status={tree}/var/lib/dpkg/status",
            "-o", f"Dir::Cache={tree}/var/cache/apt", "-o", f"Dir::Etc::sourcelist={CONF}/sources.list",
            "-o", f"Dir::Etc::sourceparts={CONF}/empty", "-o", f"Dir::Etc::preferences={CONF}/preferences",
            "-o", f"Dir::Etc::preferencesparts={CONF}/empty", "-o", "Dir::Bin::Methods=/usr/lib/apt/methods",
            "-o", f"Dir::Log={RUN}/apt-log", "-o", "APT::Get::List-Cleanup=false", "-o", "Acquire::Languages=none"]


def check_template_apt(conf=CONF, source=None):
    """template-apt (moved here from the host, ADR 0077 section 7): the build's source file is one line, the security archive
    signed by Debian's keyring (or, on a test build only, the local test archive); kernel, bootloader and initramfs pinned
    at -1; --force-confold set; the sandbox's policy-rc.d exits 101. Returns (ok, detail)."""
    probs = []
    src = [l for l in open(f"{conf}/sources.list").read().splitlines() if l.strip() and not l.strip().startswith("#")]
    if source is None:
        source = state().get("source", "security")
    want = (f"deb [signed-by={keyring()}] {SECURITY} {SUITE} {COMPONENTS}" if source == "security"
            else f"deb [signed-by={conf}/testrepo/key.gpg] copy:{conf}/testrepo {SUITE} main")
    if src != [want]:
        probs.append(f"source file is {src}, not exactly [{want}]")
    if os.listdir(f"{conf}/empty"):
        probs.append("the parts directory isn't empty")
    pins = open(f"{conf}/preferences").read()
    blocks = [b for b in pins.split("\n\n") if b.strip()]
    pinned = False
    for b in blocks:
        f = dict(l.split(":", 1) for l in b.splitlines() if ":" in l and not l.startswith("Explanation"))
        f = {k.strip(): v.strip() for k, v in f.items()}
        if f.get("Pin-Priority") == "-1" and f.get("Pin") == "release *" and \
                all(p in f.get("Package", "").split() for p in ("linux-image-*", "grub*", "initramfs-tools*")):
            pinned = True
    if not pinned:
        probs.append("kernel, bootloader and initramfs aren't pinned at -1")
    if "Dpkg::Options::=--force-confold" not in INSTALL_ARGS or "Dpkg::Options::=--force-confdef" not in INSTALL_ARGS:
        probs.append("--force-confold isn't set")
    r = subprocess.run(["sh", f"{conf}/policy-rc.d"], capture_output=True)   # the builder's /run is noexec: read by sh, as invoke-rc.d runs it
    if r.returncode != 101:
        probs.append(f"policy-rc.d exits {r.returncode}, not 101")
    return not probs, ("one source line (" + ("the security archive, Debian's keyring" if source == "security" else "the TEST archive, its throwaway key")
                       + "), kernel/bootloader/initramfs pinned -1, --force-confold, policy-rc.d exits 101") if not probs else "; ".join(probs)


PLAN_RE = re.compile(r"^Inst (\S+) \[([^\]]+)\] \((\S+) ([^)]*)\)( \[[^\]]*\])?$")   # a trailing [..] lists what it breaks until configured


def parse_plan(out):
    """apt-get -s upgrade's output: ([(name, old, new)], [kept back], [anything installed new or removed])."""
    plan, kept, other = [], [], []
    lines = out.splitlines()
    for i, l in enumerate(lines):
        m = PLAN_RE.match(l)
        if m:
            plan.append((m.group(1), m.group(2), m.group(3)))
        elif l.startswith("Inst ") or l.startswith("Remv ") or l.startswith("Purg "):
            other.append(l)
        elif l.startswith("The following packages have been kept back:"):
            for k in lines[i + 1:]:
                if not k.startswith(" "):
                    break
                kept += k.split()
    return sorted(plan), sorted(kept), other


def cmd_plan(a):
    b = build_dir(a.gen)
    with timed("plan"):
        if a.source == "test" and not os.path.exists(f"{CONF}/testrepo/key.gpg"):
            raise Fail("no test archive: run tb.py testrepo first")
        write_apt_conf(a.source)
        ok, detail = check_template_apt(source=a.source)
        record("template-apt", "pass" if ok else "fail", detail)
        if not ok:
            raise Fail(detail)
        os.makedirs(f"{RUN}/apt-log", exist_ok=True)
        r = sh("apt-get", *apt_opts(b), "-q", "update", check=False, env=dict(os.environ, LANG="C"))
        with open(f"{RUN}/apt-update.log", "w") as f:
            f.write(r.stdout + r.stderr)
        bad = [l for l in (r.stdout + r.stderr).splitlines() if l.startswith(("E:", "Err:", "W:"))]
        if r.returncode != 0 or bad:
            record("debian-signature", "fail", f"apt-get update refused the archive (exit {r.returncode}): {' | '.join(bad)[:800]}")
            raise Fail("apt-get update failed: " + " | ".join(bad)[:800])
        record("debian-signature", "pass", f"apt-get update took the {a.source} archive's Release, signed by its key ({'Debian' if a.source == 'security' else 'throwaway test'})")
        r = sh("apt-get", *apt_opts(b), "-s", "upgrade", env=dict(os.environ, LANG="C"))
        with open(f"{RUN}/apt-plan.log", "w") as f:
            f.write(r.stdout)
        plan, kept, other = parse_plan(r.stdout)
        if other:
            raise Fail(f"apt-get -s upgrade would install new packages or remove some: {other[:5]}")
        pinned = [p for p in plan if any(re.fullmatch(g.replace("*", ".*"), p[0]) for g in KERNEL_PIN.split())]
        if pinned:
            raise Fail(f"the plan has pinned packages: {pinned}")
        s = state()
        s.update({"plan": plan, "keptBack": kept})
        save_state(s)
        log(f"plan ({len(plan)}): {' '.join(f'{n}={v}' for n, _, v in plan) or 'empty'}; kept back: {' '.join(kept) or 'none'}")
        if not plan:
            record("plan", "skip", f"the {a.source} archive has nothing newer for the template than g1 has" + (f"; kept back: {' '.join(kept)}" if kept else ""))
            return 3
        # every planned version is the archive's own, from its signed lists
        missing = []
        for n, _, v in plan:
            m = sh("apt-cache", *apt_opts(b), "madison", n).stdout
            if not any(l.split("|")[1].strip() == v and ((SECURITY in l) if a.source == "security" else (f"{CONF}/testrepo" in l))
                       for l in m.splitlines() if l.count("|") >= 2):
                missing.append(f"{n}={v}")
        if missing:
            raise Fail(f"planned versions not in the archive's signed lists: {missing}")
        r = sh("apt-get", *apt_opts(b), "-q", "-y", "--download-only", "upgrade", env=dict(os.environ, LANG="C", DEBIAN_FRONTEND="noninteractive"))
        debs = glob.glob(f"{b}/var/cache/apt/archives/*.deb")
        record("plan", "pass", f"{len(plan)} package(s) from the {a.source} archive: {' '.join(f'{n}={v}' for n, _, v in plan)[:1500]}; "
                               f"{len(debs)} .deb downloaded and checked by apt against the signed lists; kept back: {' '.join(kept) or 'none'}")
        if a.current_chromium:
            s = state()
            s["currentChromium"] = a.current_chromium
            save_state(s)
    return 0


# ------------------------------------------------------------------------------------------------------------ 5. install
libc = ctypes.CDLL(None, use_errno=True)
NR = {"open_tree": 428, "move_mount": 429, "mount_setattr": 442}
OPEN_TREE_CLONE, OPEN_TREE_CLOEXEC, AT_EMPTY_PATH, AT_RECURSIVE = 1, 0o2000000, 0x1000, 0x8000
MOVE_MOUNT_F_EMPTY_PATH, MOUNT_ATTR_IDMAP = 0x4, 0x100000
INSTALL_ARGS = ["-o", "Dpkg::Options::=--force-confold", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Use-Pty=0",
                "-o", f"Dir::Etc::sourcelist={CONF}/sources.list", "-o", f"Dir::Etc::sourceparts={CONF}/empty",
                "-o", f"Dir::Etc::preferences={CONF}/preferences", "-o", f"Dir::Etc::preferencesparts={CONF}/empty",
                "-o", "Acquire::Languages=none", "-q", "-y", "--no-download", "upgrade"]


class MountAttr(ctypes.Structure):
    _fields_ = [("attr_set", ctypes.c_uint64), ("attr_clr", ctypes.c_uint64), ("propagation", ctypes.c_uint64), ("userns_fd", ctypes.c_uint64)]


def sysc(name, *args):
    r = libc.syscall(NR[name], *args)
    if r < 0:
        e = ctypes.get_errno()
        raise Fail(f"{name}: {errno.errorcode.get(e, e)}")
    return r


def idmapped(tree, target, base):
    """An idmapped bind of tree at target: on-disk uid u is seen as base + u, so the sandbox's root (base on the host, 0 in
    its own user namespace) writes files that keep their on-disk owners. Returns the user namespace holder to kill after."""
    holder = subprocess.Popen(["unshare", "--user", f"--map-users=0:{base}:65536", f"--map-groups=0:{base}:65536", "sleep", "infinity"],
                              stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try:
            if open(f"/proc/{holder.pid}/uid_map").read().split()[1] == str(base):
                break
        except (OSError, IndexError):
            pass
        time.sleep(0.1)
    else:
        holder.kill()
        raise Fail("the user namespace for the idmapped mount never got its map")
    us = os.open(f"/proc/{holder.pid}/ns/user", os.O_RDONLY | os.O_CLOEXEC)
    t = sysc("open_tree", -100, tree.encode(), OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC | AT_RECURSIVE)
    attr = MountAttr(MOUNT_ATTR_IDMAP, 0, 0, us)
    sysc("mount_setattr", t, b"", AT_EMPTY_PATH, ctypes.byref(attr), ctypes.sizeof(attr))
    os.close(us)
    os.makedirs(target, exist_ok=True)
    sysc("move_mount", t, b"", -100, target.encode(), MOVE_MOUNT_F_EMPTY_PATH)
    os.close(t)
    return holder


def sandbox_spec(rootfs, args, base=SANDBOX_BASE, extra_mounts=()):
    """The install sandbox (ADR 0077 1.2 step 5): a runc container like a slot's service sandboxes, from Docker's own spec
    as the host image captured it (docker-oci.json): Docker's seccomp profile with the unit filter's rules (wallspec,
    no namespaces), no_new_privs, Docker's capabilities inside its own user namespace (slot 30's range), the tree as its root
    through an idmapped mount, an empty network namespace, tmpfs on /tmp, /run and /var/log (dpkg's and apt's logs never
    reach the tree), apt's files read-only at /run/ma-tb, and policy-rc.d exiting 101."""
    sys.path.insert(0, LIB)
    import wallspec  # noqa: E402
    d = wallspec.docker_spec()
    p = d["process"]
    p.update({"args": args, "cwd": "/", "terminal": False, "noNewPrivileges": True, "user": {"uid": 0, "gid": 0, "additionalGids": [0]},
              "env": ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "DEBIAN_FRONTEND=noninteractive",
                      "LANG=C.UTF-8", "HOME=/root", "TMPDIR=/tmp"]})
    p.pop("apparmorProfile", None)
    p.pop("selinuxLabel", None)
    d["root"] = {"path": rootfs, "readonly": False}
    d["hostname"] = "ma-template-build"
    keep = [m for m in d["mounts"] if m.get("type") in ("proc", "tmpfs", "devpts", "mqueue", "sysfs", "cgroup") and m["destination"] != "/run"]
    keep += [{"destination": "/tmp", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "nodev", "mode=1777", "size=1g"]},
             {"destination": "/run", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "nodev", "mode=755", "size=64m"]},
             {"destination": "/var/log", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "nodev", "mode=755", "size=64m"]},
             {"destination": CONF, "type": "bind", "source": CONF, "options": ["rbind", "ro", "nosuid", "nodev"]},
             *extra_mounts]
    d["mounts"] = keep
    lx = d["linux"]
    lx["namespaces"] = [{"type": t} for t in ("pid", "ipc", "uts", "mount", "network", "user", "cgroup")]
    lx["uidMappings"] = [{"containerID": 0, "hostID": base, "size": 65536}]
    lx["gidMappings"] = [{"containerID": 0, "hostID": base, "size": 65536}]
    lx["seccomp"] = wallspec.seccomp(lx["seccomp"], allow_namespaces=False)
    lx["cgroupsPath"] = "/ma-template-build"
    lx["resources"] = {"memory": {"limit": 4 << 30}, "pids": {"limit": 4096}}
    lx.pop("sysctl", None)
    for k in ("hooks", "annotations"):
        d.pop(k, None)
    return d


SBX = f"{TB}/sbx"   # bundles: every directory above a rootfs must let the sandbox's root (slot 30's range) pass (0711)


def run_sandbox(tree, args, name, extra_mounts=()):
    """Runs args as the sandbox's process 1 on an idmapped bind of tree. Returns (exit code, output)."""
    for d in (TB, SBX):
        os.makedirs(d, exist_ok=True)
        os.chmod(d, 0o711)
    bundle = f"{SBX}/{name}"
    shutil.rmtree(bundle, ignore_errors=True)
    os.makedirs(bundle)
    os.chmod(bundle, 0o711)
    root = f"{bundle}/rootfs"
    holder = idmapped(tree, root, SANDBOX_BASE)
    try:
        with open(f"{bundle}/config.json", "w") as f:
            json.dump(sandbox_spec(root, args, extra_mounts=extra_mounts), f)
        subprocess.run(["/usr/local/sbin/runc", "delete", "-f", f"ma-tb-{name}"], capture_output=True)
        r = subprocess.run(["/usr/local/sbin/runc", "run", "--bundle", bundle, f"ma-tb-{name}"], capture_output=True, text=True,
                           stdin=subprocess.DEVNULL, timeout=3600)
        return r.returncode, r.stdout + r.stderr
    finally:
        subprocess.run(["umount", "-l", root], capture_output=True)
        holder.send_signal(signal.SIGKILL)
        holder.wait()


def restore_apt_dirs(tree, g1_entries):
    """/var/lib/apt and /var/cache/apt back to g1's set: what the build added (lists, .debs, caches) goes, and g1's own
    entries keep their g1 owner and mode (apt's sandbox user re-owns partial/)."""
    g1 = {e["path"]: e for e in g1_entries}
    removed = 0
    for top in ("var/lib/apt", "var/cache/apt"):
        for dirpath, dirnames, filenames in os.walk(f"{tree}/{top}", topdown=False):
            for n in filenames + dirnames:
                p = os.path.join(dirpath, n)
                rel = os.path.relpath(p, tree)
                if rel not in g1:
                    if os.path.isdir(p) and not os.path.islink(p):
                        shutil.rmtree(p)
                    else:
                        os.unlink(p)
                    removed += 1
        for rel, e in g1.items():
            if rel == top or rel.startswith(top + "/"):
                p = f"{tree}/{rel}"
                if os.path.lexists(p) and e["type"] != "symlink":
                    os.lchown(p, e["uid"], e["gid"])
                    os.chmod(p, e["mode"])
    return removed


def cmd_install(a):
    b = build_dir(a.gen)
    s = state()
    if not s.get("plan"):
        raise Fail("no plan: run tb.py plan first")
    with timed("install"):
        prc = f"{b}/usr/sbin/policy-rc.d"
        if os.path.lexists(prc):
            raise Fail("g1 has a policy-rc.d of its own")
        shutil.copy(f"{CONF}/policy-rc.d", prc)
        try:
            rc, out = run_sandbox(b, ["/usr/bin/apt-get", *INSTALL_ARGS], "install")
        finally:
            os.unlink(prc)
        with open(f"{RUN}/install.log", "w") as f:
            f.write(out)
        if rc != 0:
            record("install", "fail", f"apt-get --no-download upgrade in the sandbox exited {rc}: {out[-1500:]}")
            raise Fail(f"install failed (exit {rc}), {RUN}/install.log")
        gst = [n for n, _, _ in s["plan"] if n.startswith("gstreamer1.0-") or n.startswith("libgstreamer")]
        if gst:   # 1.3 item 7's first half: the registry regenerated as the bake does, in the same sandbox
            rc, out2 = run_sandbox(b, ["/usr/bin/env", "HOME=/run/desk-stream", f"GST_REGISTRY_1_0=/{GST_REGISTRY}",
                                       "GST_PLUGIN_PATH=" + gst_plugin_path(b), "gst-inspect-1.0", "yuvconv"], "gst")
            with open(f"{RUN}/gst.log", "w") as f:
                f.write(out2)
            if rc != 0:
                raise Fail(f"the GStreamer registry didn't regenerate: {out2[-800:]}")
            os.chmod(f"{b}/{GST_REGISTRY}", 0o644)
        with open(f"{RUN}/g1.json", "rb") as fh:
            g1_entries = tmpl.parse_manifest(fh.read(), allow_setid=True)[0]
        removed = restore_apt_dirs(b, g1_entries)
        record("install", "pass", f"apt-get --no-download upgrade ran in the sandbox (user namespace {SANDBOX_BASE}+, idmapped tree, "
                                  f"no network, unit filter, no_new_privs, policy-rc.d 101, --force-confold): "
                                  f"{len([l for l in out.splitlines() if l.startswith('Setting up ')])} set up"
                                  f"{', GStreamer registry regenerated' if gst else ''}; apt's lists and .debs removed ({removed} paths)")


def gst_plugin_path(tree):
    m = os.uname().machine
    return f"/opt/ma/desk-stream/current/gst-plugins/{m}:/opt/ma/desk-stream/current/gst-plugins:/usr/local/lib/ma/gst-plugins"


# ------------------------------------------------------------------------------------------------------------ seal
def cmd_seal(a):
    b, sd = build_dir(a.gen), sealed_dir(a.gen)
    s = state()
    with timed("seal"):
        if os.path.exists(sd):
            raise Fail(f"{sd} exists already")
        os.chown(b, 0, 0)
        os.chmod(b, 0o755)
        cleared = tmpl.clear_setid(b)   # as packing would: the checks and the slot then run on the tree hosts will have
        entries = tmpl.walk(b)
        data = tmpl.manifest_bytes(entries)
        os.makedirs(OUT, exist_ok=True)
        with open(f"{OUT}/{tmpl.MANIFEST}", "wb") as f:
            f.write(data)
        os.makedirs("/var/lib/desk-host/templates", mode=0o700, exist_ok=True)
        shutil.copy(f"{OUT}/{tmpl.MANIFEST}", f"/var/lib/desk-host/templates/{a.gen}.json")
        chrom = chromium_version(b)
        msha = tmpl.sha256_bytes(data)
        with open(f"{b}/.complete", "w") as f:
            f.write(f"host-template={now()}\ngen={a.gen}\nchromium={chrom}\nmanifest={msha}\nhost-version={s['hostImage']}\n")
        os.chmod(f"{b}/.complete", 0o644)
        os.rename(b, sd)
        sh("mount", "--bind", sd, sd)
        sh("mount", "-o", "remount,bind,ro,nosuid,nodev", sd)
        s.update({"sealed": sd, "manifest": msha, "chromium": chrom, "entries": len(entries), "setidCleared": cleared,
                  "treeBytes": sum(e.get("size", 0) for e in entries)})
        save_state(s)
        log(f"sealed {sd}: {len(entries)} paths, {s['treeBytes'] / 1e9:.2f} GB in files, manifest {msha[:12]}, chromium {chrom}; "
            f"set-id bits cleared on {len(cleared)} paths")


# ------------------------------------------------------------------------------------------------------------ 1.3 checks
def owned_paths(g1_tree, new_tree, pkgs):
    """Every path an upgraded package names, before or after (dpkg -L of both databases), relative to the tree, with the
    targets of dpkg's diversions of those paths or by those packages (vim-runtime renames vim-tiny's help.txt, for one)."""
    out = set()
    for tree in (g1_tree, new_tree):
        for p in pkgs:
            for lst in glob.glob(f"{tree}/var/lib/dpkg/info/{p}.list") + glob.glob(f"{tree}/var/lib/dpkg/info/{p}:*.list"):
                for line in open(lst, errors="surrogateescape"):
                    line = line.rstrip("\n")
                    if line.startswith("/"):
                        rel = "." if line == "/." else line.lstrip("/")
                        out.add(rel)
                        top = rel.split("/", 1)[0]
                        if top in ("bin", "sbin", "lib", "lib64") and "/" in rel:   # merged /usr: /bin is a link to usr/bin
                            out.add("usr/" + rel)
    for tree in (g1_tree, new_tree):
        try:
            d = open(f"{tree}/var/lib/dpkg/diversions").read().split("\n")
        except OSError:
            continue
        for i in range(0, len(d) - 2, 3):
            frm, to, by = d[i].lstrip("/"), d[i + 1].lstrip("/"), d[i + 2]
            if by in pkgs or frm in out:
                out.update((frm, to))
    return out


def allowed(rel):
    return rel in ALLOWED_EXACT or rel.startswith(ALLOWED_PREFIXES) or any(r.search(rel) for r in ALLOWED_RE)


def protected(rel):
    return rel in PROTECTED_EXACT or rel.startswith(PROTECTED_PREFIXES)


def id_lines(tree, name, field):
    out = []
    try:
        for line in open(f"{tree}/etc/{name}"):
            f = line.split(":")
            if len(f) > field and f[field].isdigit() and int(f[field]) in HOST_IDS:
                out.append(line)
    except OSError:
        pass
    return out


def nothing_else(g1_entries, new_entries, changed_ctime, owned, gst_changed=False, g1_tree=None, new_tree=None, setid_cleared=()):
    """1.3 item 2, as a function of its inputs (tests: tests/test_tb.py). Returns (problems, reported). Modes are compared with
    set-id bits cleared on both sides, and a path whose only change is the seal's own clearing of them (setid_cleared: its
    ctime moved then) counts as unchanged."""
    norm = lambda e: dict(e, mode=e["mode"] & ~tmpl.SETID)  # noqa: E731
    g1 = {e["path"]: norm(e) for e in g1_entries}
    new = {e["path"]: norm(e) for e in new_entries}
    probs, reported = [], []
    cleared = set(setid_cleared)
    changed_ctime = [p for p in changed_ctime if not (p in cleared and g1.get(p) == new.get(p))]
    if cleared:
        reported.append(f"set-id bits cleared at the seal on {len(cleared)} paths, nothing else of them changed")
    touched = set(changed_ctime) | {p for p in set(g1) ^ set(new)} | {p for p in set(g1) & set(new) if g1[p] != new[p]}
    for p in sorted(touched):
        if p.endswith(".dpkg-dist") or p.endswith(".dpkg-new") or p.endswith(".dpkg-old"):
            reported.append(f"conffile left as ours: {p}")
            if protected(p) or protected(p.rsplit(".", 1)[0]):
                probs.append(f"a Debian conffile kept as ours under a protected path: {p}")
            continue
        if gst_changed and p == GST_REGISTRY:
            continue
        if protected(p):
            probs.append(f"protected path changed: {p}")
        elif p in g1 and p in new and g1[p] == new[p] and (p in SAME_OK_EXACT or p.startswith(SAME_OK_PREFIXES)):
            reported.append(f"rewritten unchanged: {p}")
        elif p not in owned and not allowed(p):
            what = "added" if p not in g1 else ("removed" if p not in new else ("changed" if g1[p] != new[p] else "ctime later than the copy"))
            probs.append(f"{what}, and no upgraded package's or dpkg's: {p}")
    for p in set(g1) | set(new):   # protected trees must be identical entry by entry, whatever the ctime says
        if protected(p) and g1.get(p) != new.get(p) and not (gst_changed and p == GST_REGISTRY):
            if f"protected path changed: {p}" not in probs:
                probs.append(f"protected path changed: {p}")
    if g1_tree and new_tree:
        for name, field in (("passwd", 2), ("group", 2), ("shadow", 0)):
            if name == "shadow":
                ids = {l.split(":")[0] for l in id_lines(g1_tree, "passwd", 2)}
                a = [l for l in open(f"{g1_tree}/etc/shadow") if l.split(":")[0] in ids]
                b = [l for l in open(f"{new_tree}/etc/shadow") if l.split(":")[0] in ids]
            else:
                a, b = id_lines(g1_tree, name, field), id_lines(new_tree, name, field)
            if a != b:
                probs.append(f"desk-host's users or groups 1107 to 1112 changed in /etc/{name}")
    return probs, reported


def ctimes_after(tree, after_ns):
    out = []
    for dirpath, dirnames, filenames in os.walk(tree):
        for n in dirnames + filenames + (["."] if dirpath == tree else []):
            p = os.path.join(dirpath, n) if n != "." else tree
            rel = os.path.relpath(p, tree)
            if rel == ".complete":
                continue
            if os.lstat(p).st_ctime_ns > after_ns:
                out.append(rel)
    return out


class Chroot:
    """A tree run as a root filesystem for one command, in private mount, PID and network namespaces (loopback only):
    proc, a small /dev, tmpfs /tmp and /run, and binds. The tree stays read-only; nothing is written into it. TEST ONLY on
    the builder: the carry check and chromium --version."""

    def __init__(self, tree, binds=()):
        self.tree, self.binds = tree, binds

    def script(self, inner):
        # a bind's target must exist: under /tmp or /run (the tmpfs mounted above) it's made; anywhere else it's the tree's own
        b = "\n".join(f"[ -e \"$R{dst}\" ] || {{ [ -d '{src}' ] && mkdir -p \"$R{dst}\" || touch \"$R{dst}\"; }}; mount --bind '{src}' \"$R{dst}\""
                      for src, dst in self.binds)
        return f"""set -e
R=$(mktemp -d /run/ma-tb-chroot.XXXXXX)
mount --bind '{self.tree}' "$R"; mount -o remount,bind,ro "$R"
mount -t proc proc "$R/proc"
mount -t tmpfs -o mode=755,size=8m tmpfs "$R/dev"
for d in null zero urandom random tty; do touch "$R/dev/$d"; mount --bind /dev/$d "$R/dev/$d"; done
mkdir -p "$R/dev/shm" "$R/dev/pts"; mount -t tmpfs -o mode=1777,size=512m tmpfs "$R/dev/shm"
mount -t tmpfs -o mode=1777,size=512m tmpfs "$R/tmp"
mount -t tmpfs -o mode=755,size=64m tmpfs "$R/run"
{b}
ip link set lo up
{inner}
"""

    def run(self, inner, timeout=300):
        return subprocess.run(["unshare", "--mount", "--pid", "--net", "--fork", "--mount-proc", "bash", "-c", self.script(inner)],
                              capture_output=True, text=True, timeout=timeout)


def profile_hash(d):
    h = hashlib.sha256()
    for dirpath, dirnames, filenames in os.walk(d):
        dirnames.sort()
        for n in sorted(filenames):
            p = os.path.join(dirpath, n)
            if os.path.islink(p) or not os.path.isfile(p):
                h.update(f"{os.path.relpath(p, d)}\0link\n".encode())
                continue
            h.update(f"{os.path.relpath(p, d)}\0{tmpl.sha256_file(p)[1]}\n".encode())
    return h.hexdigest()


CARRY_PY = r'''
import base64, json, os, socket, struct, subprocess, sys, threading, time, urllib.request, http.server
mode, R = sys.argv[1], sys.argv[2]   # R: the tree as this namespace's chroot root; the profile is R/tmp/prof
CDP = "http://127.0.0.1:9222"; WEB = 18766
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        self.send_response(200); self.send_header("Content-Type", "text/html")
        if self.path == "/set": self.send_header("Set-Cookie", "carry=c1; Max-Age=2592000; Path=/")
        b = ("<!doctype html><title>C[%s]</title>" % self.headers.get("Cookie", "")).encode()
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
srv = http.server.ThreadingHTTPServer(("127.0.0.1", WEB), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
def get(p, m="GET"):
    return urllib.request.urlopen(urllib.request.Request(CDP + p, method=m), timeout=10).read()
def ws_call(url, method, params):
    host, path = url.split("ws://", 1)[1].split("/", 1); h, p = host.split(":")
    s = socket.create_connection((h, int(p)), timeout=30)
    s.sendall(("GET /%s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (path, host, base64.b64encode(os.urandom(16)).decode())).encode())
    b = b""
    while b"\r\n\r\n" not in b: b += s.recv(4096)
    rest = b.split(b"\r\n\r\n", 1)[1]
    msg = json.dumps({"id": 1, "method": method, "params": params}).encode(); mask = os.urandom(4)
    hdr = bytes([0x80 | len(msg)]) if len(msg) < 126 else bytes([0x80 | 126]) + struct.pack(">H", len(msg))
    s.sendall(b"\x81" + hdr + mask + bytes(c ^ mask[i % 4] for i, c in enumerate(msg)))
    def rd(n):
        nonlocal rest
        while len(rest) < n:
            d = s.recv(65536)
            if not d: raise EOFError
            rest += d
        o, rest = rest[:n], rest[n:]; return o
    while True:
        a, l = rd(2); n = l & 0x7f
        if n == 126: n = struct.unpack(">H", rd(2))[0]
        elif n == 127: n = struct.unpack(">Q", rd(8))[0]
        m = json.loads(rd(n))
        if m.get("id") == 1: s.close(); return m
def page_eval(t, expr):
    r = ws_call(t["webSocketDebuggerUrl"], "Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True})
    return r.get("result", {}).get("result", {}).get("value")
def new(u): return json.loads(get("/json/new?" + u, "PUT"))
def title(t):
    for x in json.loads(get("/json/list")):
        if x["id"] == t["id"]: return x["title"]
args = ["/usr/sbin/chroot", "--userspec=1102:1102", R, "/usr/lib/chromium/chromium", "--headless=new", "--no-sandbox",
        "--no-first-run", "--no-default-browser-check", "--password-store=basic", "--user-data-dir=/tmp/prof", "--disable-gpu",
        "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9222", "about:blank"]
out = open("/run/ma-tb/chromium-%s.log" % mode, "w")
p = subprocess.Popen(args, stdout=out, stderr=out, env={"HOME": "/tmp", "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
for i in range(120):
    try: get("/json/version"); break
    except OSError: time.sleep(0.5)
else: print(json.dumps({"error": "chromium never answered CDP"})); sys.exit(1)
res = {"mode": mode, "version": json.loads(get("/json/version"))["Browser"]}
if mode == "set":
    t = new("http://127.0.0.1:%d/set" % WEB); time.sleep(2)
    res["setLs"] = page_eval(t, "localStorage.setItem('carry','l1'); localStorage.getItem('carry')")
    time.sleep(3)
else:
    t = new("http://127.0.0.1:%d/echo" % WEB); time.sleep(2)
    res["cookies"] = title(t); res["ls"] = page_eval(t, "localStorage.getItem('carry')")
bv = json.loads(get("/json/version"))["webSocketDebuggerUrl"]
ws_call(bv, "Browser.close", {})
for i in range(62):
    if p.poll() is not None: break
    time.sleep(0.5)
else: p.terminate(); res["closed"] = "SIGTERM"
res.setdefault("closed", "cdp")
res["exit"] = p.wait()
try:
    prefs = json.load(open(R + "/tmp/prof/Default/Preferences"))
    res["exitType"] = prefs.get("profile", {}).get("exit_type")
except Exception as e: res["exitType"] = "unreadable: %s" % e
try: res["lastVersion"] = open(R + "/tmp/prof/Last Version").read().strip()
except OSError: res["lastVersion"] = None
print(json.dumps(res))
'''


def chromium_once(tree, profile, mode):
    """One headless start of tree's Chromium on profile (a tmpfs), its own namespaces, no network but loopback. Sets or
    reads the carry cookie and localStorage over CDP, then closes it with Browser.close. --no-sandbox: in a chroot the
    kernel refuses Chromium's user namespace; the profile's format doesn't depend on the sandbox."""
    with open(f"{RUN}/carry.py", "w") as f:
        f.write(CARRY_PY)
    c = Chroot(tree, binds=[(profile, "/tmp/prof")])
    # carry.py runs on the builder (its own Python) in the namespace, and Chromium in the tree through chroot
    r = c.run(f"python3 -I {RUN}/carry.py {mode} \"$R\"", timeout=300)
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        raise Fail(f"carry ({mode}) on {tree}: {r.stdout[-600:]} {r.stderr[-900:]}")


def guard(tree, profile, mutate_guard=False):
    """tree's desk-browser-start --check on profile: its exit status (78 refuses)."""
    binds = [(profile, "/tmp/prof")]
    if mutate_guard:   # section 7's mutation: a test generation whose desk-browser-start lacks the guard
        src = f"{tree}/usr/local/lib/ma/desk-browser-start"
        m = f"{RUN}/desk-browser-start.noguard"
        text = open(src).read()
        text = re.sub(r'\nlast=\$\(head.*?\nfi\n', "\n# MUTATION: the downgrade guard removed\n", text, flags=re.S)
        with open(m, "w") as f:
            f.write(text)
        os.chmod(m, 0o755)
        binds.append((m, "/usr/local/lib/ma/desk-browser-start"))
    r = Chroot(tree, binds=binds).run("chroot --userspec=1102:1102 \"$R\" env MA_BROWSER_PROFILE=/tmp/prof /usr/local/lib/ma/desk-browser-start --check && echo rc=0 || echo \"rc=$?\"")
    m = re.search(r"rc=(\d+)", r.stdout)
    return int(m.group(1)) if m else -1, (r.stdout + r.stderr)[-400:]


def carry_check(cur_tree, new_tree, cur_chrom, new_chrom, mutate_guard=False):
    """1.3 item 6, on a throwaway profile in a tmpfs. Returns (ok, detail)."""
    prof = tempfile.mkdtemp(prefix="carry-", dir="/run")
    sh("mount", "-t", "tmpfs", "-o", "mode=700,size=512m", "tmpfs", prof)
    os.chown(prof, CHROMIUM_USER, CHROMIUM_USER)
    try:
        a = chromium_once(cur_tree, prof, "set")
        b = chromium_once(new_tree, prof, "read")
        probs = []
        if a.get("setLs") != "l1" or a.get("closed") != "cdp" or a.get("exitType") != "Normal":
            probs.append(f"the current Chromium didn't set and close cleanly: {a}")
        if "carry=c1" not in str(b.get("cookies")) or b.get("ls") != "l1":
            probs.append(f"the new Chromium didn't read the cookie and localStorage back: {b}")
        if b.get("closed") != "cdp" or b.get("exitType") != "Normal":
            probs.append(f"the new Chromium didn't close cleanly: {b}")
        h0 = profile_hash(prof)
        rc_cur, out_cur = guard(cur_tree, prof)
        newer = upstream(new_chrom) != upstream(cur_chrom)
        if (rc_cur != 78) if newer else (rc_cur != 0):
            probs.append(f"the current generation's guard exited {rc_cur} on the carried profile (want {78 if newer else 0}): {out_cur}")
        # the new generation's own guard, on a profile faked newer than any Chromium (ADR 0035's run did the same)
        with open(f"{prof}/Last Version", "w") as f:
            f.write("999.0.0.0")
        os.chown(f"{prof}/Last Version", CHROMIUM_USER, CHROMIUM_USER)
        h1 = profile_hash(prof)
        rc_new, out_new = guard(new_tree, prof, mutate_guard=mutate_guard)
        if rc_new != 78:
            probs.append(f"the new generation's guard exited {rc_new} on a profile from Chromium 999.0.0.0 (want 78): {out_new}")
        if profile_hash(prof) != h1 or h0 is None:
            probs.append("a guard changed the profile")
        detail = (f"set on {a.get('version')} (closed {a.get('closed')}, {a.get('exitType')}), read on {b.get('version')}: cookie and "
                  f"localStorage back; current guard {rc_cur} ({'newer carried' if newer else 'same version'}), new guard 78 on a faked 999.0.0.0, "
                  f"profile hash unchanged") if not probs else "; ".join(probs)
        return not probs, detail
    finally:
        subprocess.run(["umount", prof], capture_output=True)
        os.rmdir(prof)


def stream_elements(tree):
    confs = glob.glob(f"{tree}/opt/ma/desk-stream/current/*.conf") + glob.glob(f"{tree}/etc/ma/stream*.conf")
    els = {"x264enc", "rtph264pay"}
    for c in confs:
        for line in open(c):
            if "=" not in line or line.lstrip().startswith("#"):
                continue
            k, v = line.split("=", 1)
            if k.strip() in ("capture", "fallback-capture", "fallback-convert", "encoder"):
                for part in v.split("!"):
                    tok = part.strip().split()
                    if tok and "/" not in tok[0]:
                        els.add(tok[0])
    return sorted(els), confs


def cmd_check(a):
    s = state()
    sd = sealed_dir(a.gen)
    cur = G1   # the fleet's current generation for this host image: g1 until a fetched one is given (step 2)
    with timed("check"):
        with open(f"{RUN}/g1.json", "rb") as fh:
            g1_entries = tmpl.parse_manifest(fh.read(), allow_setid=True)[0]
        with open(f"{OUT}/{tmpl.MANIFEST}", "rb") as fh:
            new_entries = tmpl.parse_manifest(fh.read())[0]
        plan = {n: v for n, _, v in s["plan"]}
        # 1. dpkg's own state
        probs = []
        r = sh("dpkg", f"--admindir={sd}/var/lib/dpkg", "--audit", check=False)
        if r.stdout.strip() or r.returncode != 0:
            probs.append(f"dpkg --audit: {r.stdout.strip()[:400]}")
        before, after = dpkg_versions(G1), dpkg_versions(sd)
        bad_state = {p: v[0] for p, v in after.items() if v[0] != "ii" and before.get(p, ("",))[0] != v[0]}
        if bad_state:
            probs.append(f"packages not ii (and not as g1 had them): {bad_state}")
        changed = {p: after[p][1] for p in after if before.get(p) != after[p]}
        if set(before) != set(after):
            probs.append(f"packages added or removed: {sorted(set(before) ^ set(after))[:10]}")
        if changed != plan:
            probs.append(f"the installed changes {changed} aren't the plan {plan}")
        r = sh("apt-get", *apt_opts(sd), "-o", "Dir::Cache::pkgcache=", "-o", "Dir::Cache::srcpkgcache=", "check", check=False)
        if r.returncode != 0:
            probs.append(f"apt-get check: {(r.stdout + r.stderr)[-400:]}")
        record("dpkg-state", "fail" if probs else "pass", "; ".join(probs) if probs else
               f"dpkg --audit silent, every package ii (or as g1 had it), apt-get check clean; installed changes equal the plan "
               f"({len(plan)}), each version from the {s.get('source')} archive's signed lists")
        # 2. nothing else changed
        gst_changed = any(n.startswith(("gstreamer1.0-", "libgstreamer")) for n in plan)
        owned = owned_paths(G1, sd, plan)
        later = ctimes_after(sd, s["copyEndNs"])
        p2, rep = nothing_else(g1_entries, new_entries, later, owned, gst_changed, G1, sd, setid_cleared=s.get("setidCleared", ()))
        record("nothing-else", "fail" if p2 else "pass", ("; ".join(p2[:20]) + (f" (+{len(p2) - 20} more)" if len(p2) > 20 else "")) if p2 else
               f"{len(later)} paths with a later ctime and {len(tmpl.compare(g1_entries, new_entries, limit=10**9))} differing entries, all the upgraded "
               f"packages' ({len(owned)} paths) or dpkg's; desk-host's additions, /etc/ma, /usr/local, /opt/ma, /usr/share/ma, the policies and "
               f"nftables.conf byte-identical" + (f"; reported: {rep}" if rep else ""))
        # 3. dpkg --verify
        # against g1's own result for the same packages: the bake leaves out some of their directories on purpose
        # (/var/cache/apt/archives, /var/log/apt), and a problem g1 already had isn't the build's
        def verify(tree):
            r = sh("dpkg", f"--admindir={tree}/var/lib/dpkg", f"--instdir={tree}", "--verify", *sorted(plan), check=False)
            return r.returncode, [l for l in r.stdout.splitlines() if l.strip()]
        rc_new, lines = verify(sd)
        _, base_lines = verify(G1)
        new_lines = [l for l in lines if l not in base_lines]
        nonconf = [l for l in new_lines if not re.match(r"^\S+\s+c\s", l)]
        record("dpkg-verify", "fail" if nonconf or rc_new not in (0, 1) else "pass",
               f"{len(plan)} package(s) verified against their md5sums; " + (f"failed: {nonconf[:10]}" if nonconf else
               f"nothing beyond g1's own {len(base_lines)} line(s) ({'; '.join(base_lines)[:300]})" + (f"; conffiles kept as ours: {new_lines}" if new_lines else "")))
        # 4. desk-host-check template, on the new tree in a private mount namespace where it's the template
        r = subprocess.run(["unshare", "--mount", "--propagation", "private", "bash", "-c",
                            f"mount --bind '{sd}' {G1} && mount -o remount,bind,ro,nosuid,nodev {G1} && {LIB}/desk-host-check --only template"],
                           capture_output=True, text=True)
        record("host-check-template", "pass" if r.returncode == 0 else "fail", r.stdout.strip()[:800] + r.stderr.strip()[-300:])
        # 5. Chromium goes forward
        cur_chrom = s.get("currentChromium") or chromium_version(cur)
        new_chrom = chromium_version(sd)
        fwd = version_ge(new_chrom, cur_chrom)
        r = Chroot(sd).run("chroot --userspec=1102:1102 \"$R\" env HOME=/tmp /usr/bin/chromium --version")
        ran = r.returncode == 0 and upstream(new_chrom) in r.stdout
        record("chromium-forward", "pass" if fwd and ran else "fail",
               f"new {new_chrom} {'>=' if fwd else '< (REFUSED: a lower Chromium never goes in)'} current {cur_chrom}; chromium --version: {r.stdout.strip()[:120] or r.stderr.strip()[-200:]}")
        # 6. the profile carry, both ways, whenever Chromium changed (or forced: the mutation pass)
        if new_chrom != cur_chrom or a.force_carry or a.mutate_guard:
            ok, detail = carry_check(cur, sd, cur_chrom, new_chrom, mutate_guard=a.mutate_guard)
            record("profile-carry", "pass" if ok else "fail", detail)
        else:
            record("profile-carry", "skip", f"Chromium unchanged ({new_chrom}): nothing to carry")
        # 7. GStreamer
        if gst_changed:
            els, confs = stream_elements(sd)
            bad = []
            for el in els:
                r = Chroot(sd).run(f"chroot --userspec=1104:1104 \"$R\" env HOME=/tmp GST_REGISTRY_1_0=/{GST_REGISTRY} "
                                   f"GST_REGISTRY_UPDATE=no GST_PLUGIN_PATH={gst_plugin_path(sd)} gst-inspect-1.0 {el} >/dev/null && echo ok")
                if "ok" not in r.stdout:
                    bad.append(el)
            record("gstreamer", "fail" if bad else "pass", f"registry regenerated; gst-inspect-1.0 on {len(els)} elements of {[os.path.basename(c) for c in confs]}"
                   + (f": FAILED {bad}" if bad else ": all found"))
        else:
            record("gstreamer", "skip", "no gstreamer1.0-* package changed")
    failed = [c["name"] for c in checks() if c["result"] == "fail"]
    if failed:
        raise Fail(f"checks failed: {failed}")


# ------------------------------------------------------------------------------------------------------------ 7. pack
def cmd_pack(a):
    s = state()
    sd = sealed_dir(a.gen)
    with timed("pack"):
        with open(f"{OUT}/{tmpl.MANIFEST}", "rb") as fh:
            mdata = fh.read()
        entries, _ = tmpl.parse_manifest(mdata)
        diff = tmpl.compare(entries, tmpl.walk(sd))
        if diff:
            raise Fail(f"the sealed tree changed since its manifest: {diff}")
        with open(f"{OUT}/{tmpl.PLAN}", "w") as f:
            f.write("".join(f"{n}={v}\n" for n, _, v in sorted(s["plan"])))
        t0 = time.time()
        tmpl.pack(sd, f"{OUT}/{tmpl.ARCHIVE}", level=a.level)
        s["packSeconds"] = round(time.time() - t0, 1)
        files = {n: tmpl.sha256_file(f"{OUT}/{n}") for n in tmpl.FILES}
        hb = tmpl.make_header(a.gen, s["hostImage"], s["chromium"], s["g1Manifest"], files, urgent=a.urgent)
        with open(f"{OUT}/{tmpl.HEADER}", "wb") as f:
            f.write(hb)
        s.update({"archiveBytes": files[tmpl.ARCHIVE][0], "manifestBytes": files[tmpl.MANIFEST][0], "header": tmpl.sha256_bytes(hb)})
        save_state(s)
        log(f"packed: {files[tmpl.ARCHIVE][0] / 1e9:.3f} GB archive ({s['treeBytes'] / max(files[tmpl.ARCHIVE][0], 1):.2f} to 1) in {s['packSeconds']} s; "
            f"manifest {files[tmpl.MANIFEST][0] / 1e6:.1f} MB")
    roundtrip(a.gen, flip=False)
    write_pass(a.gen)


def roundtrip(gen, flip=False):
    """1.2 step 7's round trip: the packed artifact through the member host's path (1.4 steps 3 to 6, tools/template's
    code) on this builder, into a second tree whose manifest must equal the sealed one's. The header is signed with a key
    made for this round trip alone and thrown away, so the signature step runs too."""
    s = state()
    rt = f"{TPL}/.rt-{gen}"
    with timed("roundtrip-flip" if flip else "roundtrip"):
        t = tempfile.mkdtemp(prefix="rt-", dir=RUN)
        try:
            k = f"{t}/rt.pem"
            sh("openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", k)
            tmpl.public_pem(k, f"{t}/rt.pub.pem")
            with open(f"{OUT}/{tmpl.HEADER}", "rb") as fh:
                hb = fh.read()
            sig = tmpl.sign_with_key(hb, k)
            os.unlink(k)
            arc = f"{OUT}/{tmpl.ARCHIVE}"
            if flip:   # section 7's mutation: one byte of the packed archive changed after the header was written
                arc = f"{t}/{tmpl.ARCHIVE}"
                shutil.copy(f"{OUT}/{tmpl.ARCHIVE}", arc)
                with open(arc, "r+b") as f:
                    f.seek(os.path.getsize(arc) // 2)
                    b = f.read(1)
                    f.seek(-1, 1)
                    f.write(bytes([b[0] ^ 0x01]))
            tmpl.verify_sig(hb, sig, [f"{t}/rt.pub.pem"])
            h = tmpl.parse_header(hb, host_image=s["hostImage"], gens_had=["g1"], order_sha256=tmpl.sha256_bytes(hb))
            for n in tmpl.FILES:
                p = arc if n == tmpl.ARCHIVE else f"{OUT}/{n}"
                got = tmpl.sha256_file(p)
                if got != (h["files"][n]["size"], h["files"][n]["sha256"]):
                    raise tmpl.Refused(f"{n} doesn't match the header's size and SHA-256 (refused before it's opened)")
            with open(f"{OUT}/{tmpl.MANIFEST}", "rb") as fh:
                entries, by = tmpl.parse_manifest(fh.read())
            if os.path.exists(rt):
                shutil.rmtree(rt)
            t0 = time.time()
            n = tmpl.unpack(arc, rt, entries, by, as_root=True)
            secs = round(time.time() - t0, 1)
            os.chown(rt, 0, 0)
            diff = tmpl.compare(entries, tmpl.walk(rt))
            if diff:
                raise tmpl.Refused("the second tree differs from the sealed one's manifest: " + "; ".join(diff))
            s = state()
            s["unpackSeconds"] = secs
            save_state(s)
            result = ("pass", f"signed with a throwaway key, header checked as a host checks it, every file's size and SHA-256, {n} entries "
                              f"unpacked with the host's checks in {secs} s; the second tree's walk equals the sealed manifest")
        except tmpl.Refused as e:
            result = ("fail", f"refused: {e}")
        finally:
            shutil.rmtree(t, ignore_errors=True)
            shutil.rmtree(rt, ignore_errors=True)
    if flip:
        record("mutation-roundtrip", "pass" if result[0] == "fail" else "fail",
               f"one byte of the archive changed after the header: {'refused, ' + result[1] if result[0] == 'fail' else 'NOT REFUSED'}")
        return
    record("round-trip", *result)
    if result[0] != "pass":
        raise Fail(result[1])


def write_pass(gen):
    s = state()
    with open(f"{OUT}/{tmpl.HEADER}", "rb") as fh:
        hb = fh.read()
    cs = [c for c in checks() if not c["name"].startswith("mutation-")]
    need = {"base", "template-apt", "debian-signature", "plan", "install", "dpkg-state", "nothing-else", "dpkg-verify",
            "host-check-template", "chromium-forward", "profile-carry", "gstreamer", "slot-start", "slot-readback", "slot-host-checks",
            "slot-wall", "slot-wr2-02", "slot-stream-up", "round-trip"}
    have = {c["name"] for c in cs}
    cs += [{"name": n, "result": "fail", "detail": "never ran"} for n in sorted(need - have)]
    ok = all(c["result"] in ("pass", "skip") for c in cs)
    try:
        imd = lambda p: subprocess.run(["bash", "-c", f"t=$(curl -fsS -m 3 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' "  # noqa: E731
                                                       f"http://169.254.169.254/latest/api/token) && curl -fsS -m 3 -H \"X-aws-ec2-metadata-token: $t\" "
                                                       f"http://169.254.169.254/latest/meta-data/{p}"], capture_output=True, text=True).stdout.strip()
        builder = {"amiId": imd("ami-id"), "instanceType": imd("instance-type")}
    except OSError:
        builder = {}
    rec = {"format": tmpl.PASS_FORMAT, "gen": gen, "hostImage": s["hostImage"], "header": tmpl.sha256_bytes(hb), "source": s.get("source"),
           "result": "pass" if ok else "fail", "builder": builder, "finished": now(), "times": s.get("times", {}),
           "sizes": {"treeBytes": s.get("treeBytes"), "archiveBytes": s.get("archiveBytes"), "manifestBytes": s.get("manifestBytes"),
                     "entries": s.get("entries")},
           "plan": [f"{n}={v}" for n, _, v in s["plan"]], "keptBack": s.get("keptBack", []), "checks": cs}
    with open(f"{OUT}/{tmpl.PASSED}", "wb") as f:
        f.write(json.dumps(rec, indent=1).encode() + b"\n")
    log(f"passed-build.json: {rec['result']} ({len(cs)} checks)")
    if not ok:
        raise Fail(f"the build didn't pass: {[c['name'] for c in cs if c['result'] not in ('pass', 'skip')]}")


def cmd_roundtrip(a):
    roundtrip(a.gen, flip=a.flip_byte)


# ------------------------------------------------------------------------------------------------------------ upload
def cmd_upload(a):
    urls = json.load(sys.stdin)
    with timed("upload"):
        for name in (tmpl.ARCHIVE, tmpl.MANIFEST, tmpl.PLAN, tmpl.PASSED, tmpl.HEADER):
            url, b64 = urls[name]
            r = subprocess.run(["curl", "-fsS", "--retry", "3", "-o", "/dev/null", "-w", "%{http_code} %{speed_upload}", "-X", "PUT",
                                "-H", f"x-amz-checksum-sha256: {b64}", "-T", f"{OUT}/{name}", url], capture_output=True, text=True)
            if r.returncode != 0 or not r.stdout.startswith("200"):
                raise Fail(f"upload of {name}: {r.stdout} {r.stderr[-300:]}")
            log(f"uploaded {name} ({os.path.getsize(f'{OUT}/{name}')} bytes, {float(r.stdout.split()[1]) / 1e6:.0f} MB/s)")


# ------------------------------------------------------------------------------------------------------------ test archive
def cmd_testrepo(a):
    """Section 7's local test archive: one small package g1 has, repacked from Debian's own .deb at a higher version, in a
    file: archive whose InRelease a throwaway OpenPGP key signs; only this builder's source file names that key."""
    repo = f"{CONF}/testrepo"
    if os.path.exists(repo):
        shutil.rmtree(repo)
    os.makedirs(f"{repo}/pool", exist_ok=True)
    os.makedirs(f"{repo}/dists/{SUITE}/main/binary-arm64", exist_ok=True)
    ver = dpkg_versions(G1).get(a.package)
    if not ver or ver[0] != "ii":
        raise Fail(f"g1 has no installed {a.package}")
    ver = ver[1]
    # Debian's own .deb of the installed version, fetched and checked by apt against Debian's signed lists
    w = tempfile.mkdtemp(prefix="testrepo-", dir=RUN)
    os.makedirs(f"{w}/state/lists/partial")
    os.makedirs(f"{w}/cache/archives/partial")
    open(f"{w}/status", "w").close()
    with open(f"{w}/sources.list", "w") as f:
        f.write(f"deb [signed-by={keyring()}] https://deb.debian.org/debian trixie main\n"
                f"deb [signed-by={keyring()}] {SECURITY} {SUITE} main\n")
    o = ["-o", f"Dir::State={w}/state", "-o", f"Dir::State::status={w}/status", "-o", f"Dir::Cache={w}/cache",
         "-o", f"Dir::Etc::sourcelist={w}/sources.list", "-o", f"Dir::Etc::sourceparts={CONF}/empty", "-o", "Acquire::Languages=none",
         "-o", "APT::Sandbox::User=root"]
    os.makedirs(f"{CONF}/empty", exist_ok=True)
    sh("apt-get", *o, "-q", "update")
    r = subprocess.run(["apt-get", *o, "download", f"{a.package}={ver}"], cwd=w, capture_output=True, text=True)
    debs = glob.glob(f"{w}/{a.package}_*.deb")
    if r.returncode != 0 or len(debs) != 1:
        raise Fail(f"couldn't fetch Debian's {a.package} {ver}: {r.stderr[-400:]}")
    x = f"{w}/x"
    sh("dpkg-deb", "-R", debs[0], x)
    newver = f"{ver}+ma1"
    ctl = open(f"{x}/DEBIAN/control").read()
    ctl = re.sub(r"(?m)^Version: .*$", f"Version: {newver}", ctl)
    with open(f"{x}/DEBIAN/control", "w") as f:
        f.write(ctl)
    if a.postinst_mutation:   # section 7's mutation: the package's postinst also writes /etc/ma/egress.conf
        pi = f"{x}/DEBIAN/postinst"
        body = open(pi).read() if os.path.exists(pi) else "#!/bin/sh\nset -e\n"
        body = body.replace("#DEBHELPER#", "")
        body += "\n# MUTATION (ADR 0077 section 7): writes outside the package\necho '# mutated by a test package' >> /etc/ma/egress.conf\n"
        with open(pi, "w") as f:
            f.write(body)
        os.chmod(pi, 0o755)
    deb = f"{repo}/pool/{a.package}_{newver.replace(':', '%3a')}_{dpkg_arch(x)}.deb"
    sh("dpkg-deb", "--root-owner-group", "-Zxz", "-b", x, deb)
    fields = sh("dpkg-deb", "-f", deb).stdout.rstrip("\n")
    size, sha = tmpl.sha256_file(deb)
    md5 = hashlib.md5(open(deb, "rb").read()).hexdigest()
    pk = f"{fields}\nFilename: pool/{os.path.basename(deb)}\nSize: {size}\nMD5sum: {md5}\nSHA256: {sha}\n\n"
    pkp = f"{repo}/dists/{SUITE}/main/binary-arm64/Packages"
    with open(pkp, "w") as f:
        f.write(pk)
    psize, psha = tmpl.sha256_file(pkp)
    rel = (f"Origin: MA-Template-Test\nLabel: MA-Template-Test\nSuite: {SUITE}\nCodename: {SUITE}\n"
           f"Date: {datetime.datetime.now(datetime.timezone.utc).strftime('%a, %d %b %Y %H:%M:%S UTC')}\n"
           f"Architectures: arm64\nComponents: main\nDescription: the template builder's test archive (ADR 0077 section 7), never a release\n"
           f"SHA256:\n {psha} {psize} main/binary-arm64/Packages\n")
    with open(f"{repo}/dists/{SUITE}/Release", "w") as f:
        f.write(rel)
    gh = f"{RUN}/gnupg"
    shutil.rmtree(gh, ignore_errors=True)
    os.makedirs(gh, mode=0o700)
    env = dict(os.environ, GNUPGHOME=gh)
    for uid in ("MA template test archive (throwaway)", "MA template OTHER key (throwaway)"):
        sh("gpg", "--batch", "--passphrase", "", "--quick-gen-key", uid, "ed25519", "sign", "1d", env=env)
    sh("gpg", "--batch", "--yes", "-o", f"{repo}/key.gpg", "--export", "MA template test archive (throwaway)", env=env)
    signer = "MA template OTHER key (throwaway)" if a.resign_other_key else "MA template test archive (throwaway)"
    sh("gpg", "--batch", "--yes", "--local-user", signer, "--clearsign", "-o", f"{repo}/dists/{SUITE}/InRelease",
       f"{repo}/dists/{SUITE}/Release", env=env)
    shutil.rmtree(w, ignore_errors=True)
    log(f"test archive: {a.package} {ver} -> {newver}{' (postinst writes /etc/ma/egress.conf)' if a.postinst_mutation else ''}, "
        f"InRelease signed by the {'OTHER' if a.resign_other_key else 'trusted'} throwaway key; key.gpg is the trusted one's public half")


def dpkg_arch(x):
    return re.search(r"(?m)^Architecture: (\S+)$", open(f"{x}/DEBIAN/control").read()).group(1)


def cmd_template_apt(a):
    """The template-apt check's mutation pass: each mutation must FAIL, then the clean files PASS."""
    src = state().get("source", "security")
    results = []
    for m in ("stable-line", "no-kernel-pin"):
        write_apt_conf(src, mutate=m)
        ok, d = check_template_apt(source=src)
        results.append((m, ok, d))
    write_apt_conf(src)
    ok_clean, d_clean = check_template_apt(source=src)
    good = all(not ok for _, ok, _ in results) and ok_clean
    record("mutation-template-apt", "pass" if good else "fail",
           "; ".join(f"{m}: {'FAILED as it must' if not ok else 'PASSED (wrong)'} ({d[:160]})" for m, ok, d in results) + f"; put back: {'PASS' if ok_clean else 'FAIL'}")


def cmd_record(a):
    if a.result not in ("pass", "fail", "skip"):
        raise Fail("result must be pass, fail or skip")
    record(a.name, a.result, a.detail)


def cmd_reset_build(a):
    sd = sealed_dir(a.gen)
    subprocess.run(["umount", sd], capture_output=True)
    for p in (build_dir(a.gen), sd, f"{TPL}/.rt-{a.gen}"):
        if os.path.exists(p):
            shutil.rmtree(p)
    for p in glob.glob(f"{OUT}/*"):
        os.unlink(p)
    if os.path.exists(f"/var/lib/desk-host/templates/{a.gen}.json"):
        os.unlink(f"/var/lib/desk-host/templates/{a.gen}.json")
    keep = state()
    s = {k: keep[k] for k in ("hostImage", "g1Manifest", "g1Chromium", "g1Entries") if k in keep}
    s["times"] = {}
    save_state(s)
    if os.path.exists(f"{RUN}/checks.jsonl"):
        os.rename(f"{RUN}/checks.jsonl", f"{RUN}/checks-{int(time.time())}.jsonl")
    log(f"reset: {a.gen}'s trees and records dropped (g1's manifest kept)")


def main(argv):
    import argparse
    ap = argparse.ArgumentParser(prog="tb.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)
    p = sp.add_parser("base"); p.add_argument("--host-image", required=True); p.set_defaults(f=cmd_base)  # noqa: E702
    p = sp.add_parser("copy"); p.add_argument("--gen", required=True); p.set_defaults(f=cmd_copy)  # noqa: E702
    p = sp.add_parser("plan"); p.add_argument("--gen", required=True); p.add_argument("--source", choices=("security", "test"), required=True)  # noqa: E702
    p.add_argument("--current-chromium"); p.set_defaults(f=cmd_plan)  # noqa: E702
    p = sp.add_parser("install"); p.add_argument("--gen", required=True); p.set_defaults(f=cmd_install)  # noqa: E702
    p = sp.add_parser("seal"); p.add_argument("--gen", required=True); p.set_defaults(f=cmd_seal)  # noqa: E702
    p = sp.add_parser("check"); p.add_argument("--gen", required=True); p.add_argument("--force-carry", action="store_true")  # noqa: E702
    p.add_argument("--mutate-guard", action="store_true"); p.set_defaults(f=cmd_check)  # noqa: E702
    p = sp.add_parser("pack"); p.add_argument("--gen", required=True); p.add_argument("--urgent", action="store_true")  # noqa: E702
    p.add_argument("--level", type=int, default=9); p.set_defaults(f=cmd_pack)  # noqa: E702
    p = sp.add_parser("roundtrip"); p.add_argument("--gen", required=True); p.add_argument("--flip-byte", action="store_true"); p.set_defaults(f=cmd_roundtrip)  # noqa: E702
    p = sp.add_parser("upload"); p.set_defaults(f=cmd_upload)  # noqa: E702
    p = sp.add_parser("testrepo"); p.add_argument("--package", default="netbase"); p.add_argument("--postinst-mutation", action="store_true")  # noqa: E702
    p.add_argument("--resign-other-key", action="store_true"); p.set_defaults(f=cmd_testrepo)  # noqa: E702
    p = sp.add_parser("template-apt"); p.set_defaults(f=cmd_template_apt)  # noqa: E702
    p = sp.add_parser("record"); p.add_argument("name"); p.add_argument("result"); p.add_argument("detail"); p.set_defaults(f=cmd_record)  # noqa: E702
    p = sp.add_parser("reset-build"); p.add_argument("--gen", required=True); p.set_defaults(f=cmd_reset_build)  # noqa: E702
    a = ap.parse_args(argv)
    if os.geteuid() != 0:
        print("tb.py: root only", file=sys.stderr)
        return 2
    os.makedirs(RUN, exist_ok=True)
    os.makedirs(CONF, mode=0o755, exist_ok=True)
    try:
        # the slot start binds another generation over the template for its re-root (slot.sh template); every step here
        # reads g1 there, so none runs until slot.sh has put g1 back
        if a.cmd not in ("record", "upload") and "gen" in complete_fields(G1):
            raise Fail(f"{G1} is generation {complete_fields(G1)['gen']} now, not g1: run slot.sh template g1 first")
        return a.f(a) or 0
    except (Fail, tmpl.Refused) as e:
        print(f"tb.py {a.cmd}: FAILED: {e}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
