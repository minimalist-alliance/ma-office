"""batches.py: service batches on a shared host (ADR 0078). Host root; imported by desk-host-batch (the command), desk-host-release,
report.py, desk-host-check and desk-host-link. Python 3 standard library only, plus openssl (batchsig.py).

- A batch is the one desks of their own take: manifest ma-desk-batch/1 and its detached P-256 signature by alias/ma-desk-batch,
  checked against /etc/desk-host/batch-keys (batchsig.py, desk-batch's own checks copied). The host applies the components it runs
  from its store (deskd, desk-agent, desk-notebook, desk-rtc, desk-stream); desk-agent-filter is the template's (templatePending
  when a batch names another), desk-egress and commons-server are ignored, and an image is imagePending (1.2).
- fetch(): 1.3. Verify before any download, the floor, the version conflict, store and root admission, downloads hashed as they
  arrive, desk-host-release's checked, streamed unpack (install --manifest), the batch kept on the host's root, `candidate` set.
- The store (1.4): releases/<svc>/<version>/ with current, previous and candidate links; a version is deleted only when no link
  and no slot's record names it (gc).
- /var/lib/desk-host/batch/state.json: floor, current, previous, candidate (with its canary: trialSlot, trialPassedAt,
  promoteOrdered), halted, refused, pending. current is None until a batch is promoted: the host runs releases.pin's.
- A slot's record (desk-host's /var/lib/desk-host/slots/<k>.json) carries releases ({svc: version}, what its rel/ holds), batch
  ({seq, state, at}), rolledBack ([seq]), and while a switch runs, switching; after a stop path's swap, verify (2.3).
- plan(): which batch a slot moves to: the candidate on one slot (the canary, 3.3), else current; the changed components in the
  manifest's order. The live switch (2.2) and the stop path (2.3) are desk-host's (switch, relroot), on these helpers.
"""
import base64
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import batchsig as B  # noqa: E402
import templates as T  # noqa: E402

E = os.environ.get
DH = T.DH
STORE = E("DESK_HOST_RELEASES", f"{DH}/releases")
SLOTS = E("DESK_HOST_SLOTS", f"{DH}/slots")
BVAR = E("DESK_HOST_BATCH_VAR", "/var/lib/desk-host/batch")
DL = T.DL
REC = T.REC
RUN = T.RUN
LIB = T.LIB
PIN = E("DESK_HOST_RELEASE_PIN", "/etc/desk-host/releases.pin")
UPDATES = E("DESK_HOST_UPDATES", f"{RUN}/link/updates.json")
STORE_COMPS = ("deskd", "desk-agent", "desk-notebook", "desk-rtc", "desk-stream")
TEMPLATE_COMPS = ("desk-agent-filter",)          # the template's own: applied only with a host image (templatePending)
IGNORED = ("desk-egress", "commons-server")      # don't run in a slot
MAX_TGZ = 1 << 30                                # one component's download at most
UNPACK_RATIO = 3.5                               # unpacked bytes per compressed byte, for admission (Nov 10's: 1.0 GB of 0.35 GB)
URL_MARGIN_S = T.URL_MARGIN_S
HOLD_S = 900
PRESSURE_MAX = 25.0                              # cpu.pressure some avg10 above this: no switch (ADR 0090's level)
HEADROOM_MEM = 128 << 20                         # a switch needs this much under the desk's memory.max for the new sandbox's start,
HEADROOM_PIDS = 32                               # and this many tasks under its pids.max (runc init, desk-svc, the service's first threads)
CGROUP = E("DESK_HOST_CGROUP", "/sys/fs/cgroup/desk-host")
COPY_TRIES = 3
COPY_RETRY_S = 3600
SMOKE_S = 90
SMOKE_FREE_S = 180
LINKS = ("current", "previous", "candidate")


class Failed(Exception):
    pass


def mutation(name):
    """verify-batches.sh's mutations (ADR 0078 section 7), a TEST host's only: each turns one rule off so its step must fail."""
    return T.test_mode() and E("DESK_HOST_BATCH_MUT") == name


class UrlsWanted(Exception):
    pass


def log(msg):
    print(f"desk-host-batch: {msg}", file=sys.stderr, flush=True)


utc = T.utc
parse_utc = T.parse_utc
write_atomic = T.write_atomic


# ---------------------------------------------------------------- state
def state_path():
    return f"{BVAR}/state.json"


def empty_state():
    return {"floor": 0, "current": None, "previous": None, "candidate": None, "halted": [], "refused": [], "pending": None}


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
    os.makedirs(BVAR, mode=0o755, exist_ok=True)
    write_atomic(state_path(), T.canonical(st), 0o644)


class StateLock:
    def __enter__(self):
        os.makedirs(BVAR, mode=0o755, exist_ok=True)
        self.fd = os.open(f"{BVAR}/.lock", os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600)
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


def halted_seqs(st):
    return {h["seq"] for h in st.get("halted") or []}


def floor(st=None, base=None):
    """No batch at or below this is taken (1.3 step 2): the highest promoted, halted or refused (after its signature verified),
    the candidate's, and the host image's batch-baseline."""
    st = st or load_state()
    seqs = [st.get("floor") or 0, B.baseline() if base is None else base]
    for k in ("current", "candidate"):
        if st.get(k):
            seqs.append(st[k]["seq"])
    seqs += [h["seq"] for h in st.get("halted") or []] + [r["seq"] for r in st.get("refused") or [] if r.get("signed")]
    return max(seqs)


def current_seq(st=None):
    st = st or load_state()
    return (st.get("current") or {}).get("seq") or B.baseline()


def switches():
    """The reply's kill switches as the link last wrote them (ADR 0078 PB-2): batches true unless turned off; liveSwitches only
    when Platform says true (the owner's brief: off until the Security Analyst has read 2.2)."""
    try:
        with open(UPDATES) as fh:
            u = json.load(fh)
    except (OSError, ValueError):
        u = {}
    return {"batches": u.get("batches") is not False, "liveSwitches": u.get("liveSwitches") is True}


# ---------------------------------------------------------------- the store
def rdir(svc, ver):
    return f"{STORE}/{svc}/{ver}"


def link(svc, name):
    try:
        v = os.readlink(f"{STORE}/{svc}/{name}")
    except OSError:
        return None
    return v if B.VERSION.match(v) else None


def set_link(svc, name, ver):
    p = f"{STORE}/{svc}/{name}"
    if ver is None:
        try:
            os.unlink(p)
        except FileNotFoundError:
            pass
        return
    tmp = f"{p}.new.{os.getpid()}"
    try:
        os.unlink(tmp)
    except FileNotFoundError:
        pass
    os.symlink(ver, tmp)
    os.rename(tmp, p)


def read1(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


def artifact_sha(svc, ver):
    return read1(f"{rdir(svc, ver)}/artifact.sha256")


def versions(svc):
    try:
        return sorted(v for v in os.listdir(f"{STORE}/{svc}") if B.VERSION.match(v) and v not in LINKS and ".new." not in v
                      and os.path.isdir(rdir(svc, v)) and not os.path.islink(rdir(svc, v)))
    except FileNotFoundError:
        return []


def pins():
    out = {}
    try:
        with open(PIN) as fh:
            for line in fh:
                f = line.split()
                if len(f) == 3 and not f[0].startswith("#") and len(f[2]) == 64:
                    out[f[0]] = {"version": f[1], "sha256": f[2]}
    except OSError:
        pass
    return out


def store_map(name="current"):
    """{svc: {version, sha256}} the store's links name now."""
    out = {}
    for svc in STORE_COMPS:
        v = link(svc, name)
        if v:
            out[svc] = {"version": v, "sha256": artifact_sha(svc, v)}
    return out


def current_map(st=None):
    """What the host has promoted, or the image's pinned releases (the store as the bake left it) before any batch."""
    st = st or load_state()
    if st.get("current"):
        return st["current"]["components"]
    return image_map()


def kept_manifest(seq):
    try:
        return B.check_manifest(open(f"{BVAR}/{seq}.json", "rb").read())
    except (OSError, B.Refused):
        return None


def template_release(svc):
    """The template generation's own release of svc (its /opt/ma), as {version, sha256}."""
    t = T.gen_dir(T.current_gen()) if T.current_gen() else None
    if not t:
        return None
    d = f"{t}/opt/ma/{svc}/current"
    v = os.path.basename(os.path.realpath(d)) if os.path.isdir(d) else None
    return {"version": v, "sha256": read1(f"{d}/artifact.sha256")} if v else None


# ---------------------------------------------------------------- records (desk-host's files)
def record(k):
    return T.record(k)


def save_record(k, r):
    write_atomic(f"{REC}/{k}.json", json.dumps(r).encode(), 0o600)


def record_update(k, fn):
    """A change to slot k's record, under its own lock (desk-host writes it under the slot's lock; this is for the fields this module
    owns, written while desk-host holds the slot's lock or for a stopped slot)."""
    os.makedirs(f"{RUN}/lock", mode=0o700, exist_ok=True)
    fd = os.open(f"{RUN}/lock/rec-{k}", os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        r = record(k)
        if r is None:
            return None
        out = fn(r)
        save_record(k, r)
        return out
    finally:
        os.close(fd)


def image_map():
    """The image's own releases (releases.pin), what every slot prepared before this code holds."""
    p = pins()
    return {svc: p[svc] for svc in STORE_COMPS if svc in p} or store_map()


def rec_releases(rec, st=None):
    """{svc: version} slot k's rel/ holds: its record's, or (a record from before batches, prepared from the image's pin) the pin's."""
    rel = (rec or {}).get("releases")
    if isinstance(rel, dict) and rel:
        return dict(rel)
    return {svc: e["version"] for svc, e in image_map().items()}


def rec_seq(rec, st=None):
    b = (rec or {}).get("batch")
    if isinstance(b, dict) and isinstance(b.get("seq"), int):
        return b["seq"]
    return B.baseline()


def record_fresh(k, st=None):
    """A prepare's or a fresh copy's record: rel/ is the store's current."""
    st = st or load_state()

    def f(r):
        r["releases"] = {svc: e["version"] for svc, e in current_map(st).items()}
        r["batch"] = {"seq": current_seq(st), "state": "current", "at": utc()}
        for x in ("switching", "verify", "batchTries"):
            r.pop(x, None)
    return record_update(k, f)


# ---------------------------------------------------------------- which batch a slot moves to
def target(st, k, rec):
    """(entry, role) slot k should be on: the candidate on its canary (one slot, a desk's, not one that rolled it back), else the
    current batch; None when the slot is on it already or nothing applies."""
    rb = set((rec or {}).get("rolledBack") or [])
    have = rec_releases(rec, st)
    halted = halted_seqs(st)
    c = st.get("candidate")
    if (c and c["seq"] not in halted and c["seq"] not in rb and (rec or {}).get("state") == "desk"
            and c.get("trialSlot") in (None, k)):
        if rec_seq(rec, st) != c["seq"] or have != {s: e["version"] for s, e in c["components"].items()}:
            return c, "candidate"
        return None
    cur = st.get("current")
    if cur and cur["seq"] not in halted and cur["seq"] not in rb:
        want = {s: e["version"] for s, e in cur["components"].items()}
        if have != want or rec_seq(rec, st) != cur["seq"]:
            return cur, "current"
    return None


def order_of(e):
    o = [s for s in e.get("order") or [] if s in STORE_COMPS]
    return o + [s for s in STORE_COMPS if s not in o]


def plan(k, claim=True):
    """{seq, role, urgent, components: [{name, from, to}]} for slot k, the changed components in the manifest's order; None when
    nothing is due. claim makes slot k the candidate's canary when it's the candidate's turn."""
    st = load_state()
    rec = record(k)
    if not rec or rec.get("state") not in ("desk", "fresh"):
        return None
    t = target(st, k, rec)
    if not t:
        return None
    e, role = t
    if role == "candidate" and claim:
        def f(s):
            c = s.get("candidate")
            if not c or c["seq"] != e["seq"] or c.get("trialSlot") not in (None, k):
                return False
            if c.get("trialSlot") is None:
                c["trialSlot"], c["trialStartedAt"] = k, utc()
            return True
        if not update_state(f):
            return None
    have = rec_releases(rec, st)
    comps = [{"name": s, "from": have.get(s), "to": e["components"][s]["version"]}
             for s in order_of(e) if s in e["components"] and have.get(s) != e["components"][s]["version"]]
    return {"seq": e["seq"], "id": e["id"], "role": role, "urgent": bool(e.get("urgent")), "components": comps,
            "releases": {s: x["version"] for s, x in e["components"].items()}}


def due(k):
    return plan(k, claim=False) is not None


# ---------------------------------------------------------------- the fetch (1.3)
def fetch_status(**kw):
    p = f"{BVAR}/fetch.json"
    try:
        cur = T.rjson(p)
    except (OSError, ValueError):
        cur = {}
    cur.update(kw)
    cur["at"] = utc()
    os.makedirs(BVAR, mode=0o755, exist_ok=True)
    write_atomic(p, T.canonical(cur))
    return cur


def read_fetch_status():
    try:
        return T.rjson(f"{BVAR}/fetch.json")
    except (OSError, ValueError):
        return None


def store_admission(new_bytes):
    """None when the new releases fit on the store beside the slots' room and one copy in flight (ADR 0077 section 4, PB-8)."""
    if E("DESK_HOST_TEMPLATES_NO_ROOM_CHECK") == "1" and T.test_mode():
        return None
    if E("DESK_HOST_BATCH_ROOM_BYTES") and T.test_mode():   # verify's "store room" step: a store with less room than the batch needs
        free = int(E("DESK_HOST_BATCH_ROOM_BYTES"))
    else:
        v = os.statvfs(DH)
        free = v.f_bavail * v.f_frsize
    s = T.sizes()
    need = new_bytes + s["releases"]
    room = free - T.store_headroom()
    if room < need:
        return f"the store has {room / 1e9:.2f} GB beyond the slots' room, the batch and one copy in flight need {need / 1e9:.2f} GB"
    return None


def root_admission(download_bytes):
    if E("DESK_HOST_BATCH_ROOM_BYTES") and T.test_mode():
        if int(E("DESK_HOST_BATCH_ROOM_BYTES")) < download_bytes:
            return "the host's root has too little room (a test host's setting)"
    return T.root_admission(download_bytes)


def choose_fetch(m, st):
    """1.2 and 1.3 step 3: (to fetch [{name, version, sha256}], target components {svc: {version, sha256}}, templatePending, imagePending).
    The same version from another artifact refuses the whole batch."""
    comps = dict(current_map(st))
    fetch, tpending = [], []
    for c in m["components"]:
        n = c["name"]
        if n in STORE_COMPS:
            have = artifact_sha(n, c["version"]) if os.path.isdir(rdir(n, c["version"])) else None
            if have is not None and have != c["sha256"]:
                raise B.Refused("conflict", f"{n} {c['version']} is in the store from another artifact ({have[:12]}..., the batch "
                                            f"says {c['sha256'][:12]}...): never replaced")
            if have is None:
                fetch.append(c)
            comps[n] = {"version": c["version"], "sha256": c["sha256"]}
        elif n in TEMPLATE_COMPS:
            t = template_release(n)
            if not t or t.get("sha256") != c["sha256"]:
                tpending.append({"name": n, "version": c["version"]})
        # IGNORED and anything else: not a slot's
    return fetch, comps, tpending, ({"seq": m["seq"], "image": m["image"]} if m.get("image") else None)


def fetch(order, stop_check=None):
    """One batch_target order (1.3): exit states fetch.json says. Refused (signature, floor, hash, version), Failed, UrlsWanted."""
    seq = order.get("seq")
    tid = order.get("targetId")
    dl = f"{DL}/batch-{seq}"
    step = "verify"

    def at(s, state=None):
        nonlocal step
        step = s
        fetch_status(target=tid, seq=seq, state=state or (read_fetch_status() or {}).get("state"), step=s, error=None)

    def urls_left():
        exp = parse_utc(order.get("expiresAt"))
        if exp is not None and exp - time.time() < URL_MARGIN_S:
            raise UrlsWanted()

    t0 = time.monotonic()
    timing = {}
    signed = False
    m = None
    try:
        fetch_status(target=tid, seq=seq, state="verifying", step=step, error=None, timing=None, key=None)
        update_state(lambda s: s.__setitem__("pending", {"seq": seq, "at": utc()}))
        # 1. the manifest and its signature, before anything is downloaded
        try:
            mb = base64.b64decode(order.get("manifest") or "", validate=True)
            sig = base64.b64decode(order.get("signature") or "", validate=True)
        except (ValueError, TypeError):
            raise B.Refused("bad_request", "the order's manifest or signature isn't base64") from None
        if hashlib.sha256(mb).hexdigest() != order.get("sha256"):
            raise B.Refused("bad_request", "the order's sha256 isn't the manifest's")
        if mutation("no-sig"):   # signature checking turned off
            m, key = B.check_manifest(mb), "none (DESK_HOST_BATCH_MUT=no-sig)"
        else:
            m, key = B.verify(mb, sig)
        signed = True
        if m["seq"] != seq:
            raise B.Refused("bad_request", "the order's seq isn't the manifest's")
        if m["arch"] != B.machine_arch():
            raise B.Refused("arch", f"the batch is built for {m['arch']}, and this host is {B.machine_arch()}")
        # 2. the floor
        st = load_state()
        fl = floor(st)
        if seq <= fl and not mutation("no-floor"):
            signed = False   # a replay never raises the floor
            raise B.Refused("seq", f"seq {seq} isn't above this host's floor {fl}")
        # 3. what to fetch
        at("choose")
        todo, comps, tpending, ipending = choose_fetch(m, st)
        urls = order.get("urls") or {}
        for c in todo:
            if not T.url_ok(urls.get(c["name"])):
                raise B.Refused("bad_request", f"the order has no usable URL for {c['name']}")
        # 4. admission: the downloads on the host's root (the .tgz and its image tar beside it, about 4x), then the store
        why = None if mutation("no-room") else root_admission(len(todo) * (512 << 20) + (1 << 30))
        if why:
            raise Failed(f"no room: {why}")
        # 5. download, hashed as it arrives
        at("download", "downloading")
        T.rm_tree(dl)
        os.makedirs(dl, mode=0o700)
        got = {}
        for c in todo:
            urls_left()
            p = f"{dl}/{c['name']}-{c['version']}.tgz"
            try:
                n, _ = T.download(urls[c["name"]], p, MAX_TGZ, want_sha=None if mutation("no-hash") else c["sha256"])
            except T.Refused as e:   # not the signed manifest's bytes: refused before it's opened
                raise B.Refused("hash", f"{c['name']} {c['version']}: {e}") from None
            got[c["name"]] = (p, n)
        timing["download_s"] = round(time.monotonic() - t0, 1)
        timing["downloadBytes"] = sum(n for _, n in got.values())
        why = None if mutation("no-room") else store_admission(int(UNPACK_RATIO * timing["downloadBytes"]))
        if why:
            raise Failed(f"no room: {why}")
        # 6. install with desk-host-release's checked, streamed unpack, the hash from the verified manifest
        at("install", "installing")
        t1 = time.monotonic()
        with open(f"{dl}/manifest.json", "wb") as f:
            f.write(mb)
        with open(f"{dl}/manifest.sig", "wb") as f:
            f.write(sig)
        peaks = {}
        with T.CopyTurn(background=True):
            for c in todo:
                p, _ = got[c["name"]]
                r = subprocess.run([sys.executable, "-I", E("DESK_HOST_RELEASE_CMD", f"{LIB}/desk-host-release"), "install", "--manifest",
                                    f"{dl}/manifest.json", "--signature", f"{dl}/manifest.sig", p],
                                   capture_output=True, text=True, timeout=3600)
                if r.returncode == 3:
                    raise B.Refused("hash", f"desk-host-release refused {c['name']} {c['version']}: {r.stderr.strip()[-300:]}")
                if r.returncode != 0:
                    raise Failed(f"desk-host-release install {c['name']} {c['version']}: {r.stderr.strip()[-300:]}")
                log(r.stdout.strip().splitlines()[-1] if r.stdout.strip() else f"{c['name']} installed")
                peaks[c["name"]] = upd_peak()
        timing["install_s"] = round(time.monotonic() - t1, 1)
        timing["memoryPeak"] = upd_peak()
        # 7. keep the batch; the candidate
        at("keep")
        os.makedirs(BVAR, mode=0o755, exist_ok=True)
        write_atomic(f"{BVAR}/{seq}.json", mb, 0o644)
        write_atomic(f"{BVAR}/{seq}.sig", sig, 0o644)
        order_comps = [c["name"] for c in m["components"] if c["name"] in STORE_COMPS]

        def mark(s):
            old = s.get("candidate")
            s["candidate"] = {"seq": seq, "id": m["id"], "at": utc(), "sha256": order["sha256"], "urgent": bool(m["urgent"] or order.get("urgent")),
                              "target": tid, "components": comps, "order": order_comps, "templatePending": tpending,
                              "imagePending": ipending, "trialSlot": None, "trialStartedAt": None, "trialPassedAt": None,
                              "promoteOrdered": False, "replaces": old["seq"] if old else None}
            s["pending"] = None
        update_state(mark)
        for svc in STORE_COMPS:
            set_link(svc, "candidate", comps[svc]["version"] if svc in comps else None)
            if mutation("into-current") and svc in comps:   # installing straight into current, skipping the candidate
                set_link(svc, "current", comps[svc]["version"])
        T.rm_tree(dl)
        timing["total_s"] = round(time.monotonic() - t0, 1)
        fetch_status(target=tid, seq=seq, state="installed", step=None, error=None, key=os.path.basename(key), timing=timing)
        log(f"seq {seq} ({m['id']}) installed as the candidate: {', '.join(c['name'] + ' ' + c['version'] for c in todo) or 'nothing new to fetch'}; "
            f"key {os.path.basename(key)}; {timing}")
        gc()
        return m
    except UrlsWanted:
        T.rm_tree(dl)
        update_state(lambda s: s.__setitem__("pending", None))
        fetch_status(state="urlsWanted", step=step, error="the order's URLs expire in under 10 minutes")
        raise
    except B.Refused as e:
        T.rm_tree(dl)
        drop_partial(m)

        def f(s):
            s["pending"] = None
            s.setdefault("refused", []).append({"seq": seq if isinstance(seq, int) else None, "id": (m or {}).get("id"), "at": utc(),
                                                "code": e.code, "why": e.text[:200], "signed": signed})
            s["refused"] = s["refused"][-20:]
        update_state(f)
        fetch_status(state="refused", step=step, error=f"{e.code}: {e.text}"[:400])
        log(f"seq {seq}: REFUSED at {step}: {e.code}: {e.text}")
        raise
    except (Failed, OSError, subprocess.SubprocessError, ValueError, T.Refused, T.Failed) as e:
        T.rm_tree(dl)
        drop_partial(m)
        update_state(lambda s: s.__setitem__("pending", None))
        fetch_status(state="failed", step=step, error=f"{type(e).__name__}: {e}"[:400])
        log(f"seq {seq}: failed at {step}: {e}")
        raise Failed(str(e)) from None


def drop_partial(m):
    """A fetch that failed or was refused leaves nothing installed: releases it installed that no link or record names go (gc)."""
    try:
        gc()
    except OSError:
        pass


def upd_peak():
    try:
        return int(open(f"{T.UPD}/memory.peak").read().strip())
    except (OSError, ValueError):
        return None


# ---------------------------------------------------------------- promote, halt, trial (3.3)
def _promote(st):
    c = st["candidate"]
    prev = st.get("current") or {"seq": B.baseline(), "id": "image", "at": None, "components": image_map()}   # the first: the pin's set
    st["previous"] = prev
    st["current"] = {x: c[x] for x in ("seq", "id", "sha256", "urgent", "target", "components", "order", "templatePending", "imagePending") if x in c}
    st["current"]["at"] = utc()
    st["current"]["trialSlot"] = c.get("trialSlot")
    st["candidate"] = None
    st["floor"] = max(st.get("floor") or 0, c["seq"])
    return c


def move_links(c):
    """The store's links after a promote (1.4): previous to the old current, current to the candidate; the candidate link gone."""
    for svc in STORE_COMPS:
        want = (c["components"].get(svc) or {}).get("version")
        cur = link(svc, "current")
        if want and want != cur:
            if cur:
                set_link(svc, "previous", cur)
            set_link(svc, "current", want)
        set_link(svc, "candidate", None)


def promote(seq):
    """Platform's batch_promote: once the canary passed its smoke test (here) the candidate becomes current. Else it's ordered and
    waits for the canary."""
    def f(st):
        c = st.get("candidate") or {}
        if (st.get("current") or {}).get("seq") == seq:
            return "already current", None
        if c.get("seq") != seq:
            return "not the candidate", None
        if seq in halted_seqs(st):
            return "halted", None
        c["promoteOrdered"] = True
        if not c.get("trialPassedAt"):
            return "promote ordered; waiting for the canary's smoke test", None
        return "promoted", _promote(st)
    r, c = update_state(f)
    if c:
        move_links(c)
        log(f"seq {seq} promoted: current {seq}; previous {(c.get('replaces'))}; every running slot switches at its idle")
    return r


def trial_passed(seq, k):
    def f(st):
        c = st.get("candidate") or {}
        if c.get("seq") != seq:
            return "not the candidate", None
        c["trialPassedAt"] = utc()
        c["trialSlot"] = k
        if c.get("promoteOrdered"):
            return "passed and promoted", _promote(st)
        return "passed", None
    r, c = update_state(f)
    if c:
        move_links(c)
    return r


def halt(seq, reason):
    """No slot starts seq again on this host, and a candidate is never promoted (3.3): a slot's rollback, or Platform's batch_halt."""
    def f(st):
        if seq in halted_seqs(st):
            if (st.get("candidate") or {}).get("seq") == seq:   # a candidate taken again under that seq (a test host's no-floor mutation)
                st["candidate"] = None
            return "already halted"
        e = None
        for k in ("candidate", "current", "previous"):
            if (st.get(k) or {}).get("seq") == seq:
                e = st[k]
        st.setdefault("halted", []).append({"seq": seq, "id": (e or {}).get("id"), "at": utc(), "reason": reason[:200]})
        st["floor"] = max(st.get("floor") or 0, seq)
        if (st.get("candidate") or {}).get("seq") == seq:
            st["candidate"] = None
            return "halted (the candidate)"
        return "halted" if e else "halted (not on this host)"
    r = update_state(f)
    if not load_state().get("candidate"):
        for svc in STORE_COMPS:
            set_link(svc, "candidate", None)
    log(f"seq {seq}: {r}: {reason}")
    return r


# ---------------------------------------------------------------- a slot's batch, after a switch or a stop path's swap
def finish(k, p):
    """Slot k's batch passed: its record names the new set; the canary's pass on the host."""
    def f(r):
        r["releases"] = dict(p["releases"])
        r["batch"] = {"seq": p["seq"], "state": "current", "at": utc()}
        for x in ("switching", "verify", "batchTries"):
            r.pop(x, None)
    record_update(k, f)
    if p.get("role") == "candidate":
        return trial_passed(p["seq"], k)
    return "passed"


def rolled_back(k, p, why):
    """Slot k's batch rolled back (3.1): its record names the old set, the seq is never tried there again, and the batch is halted
    on the host (3.3)."""
    def f(r):
        old = dict(rec_releases(r))
        for c in p["components"]:
            if c.get("from"):
                old[c["name"]] = c["from"]
        r["releases"] = old
        # the slot is back on the set it had (its seq); "tried" is the batch it rolled back, which the report names
        b = r.get("batch") or {}
        was = b.get("fromSeq") if b.get("state") == "verify" and isinstance(b.get("fromSeq"), int) else rec_seq(r)
        r["batch"] = {"seq": was, "state": "rolled-back", "tried": p["seq"], "at": utc(), "why": why[:200]}
        r["rolledBack"] = sorted(set(r.get("rolledBack") or []) | {p["seq"]})[-20:]
        for x in ("switching", "verify"):
            r.pop(x, None)
    record_update(k, f)
    return halt(p["seq"], f"rolled back in slot {k}: {why}")


def copy_failed(k, p, why):
    def f(r):
        t = r.get("batchTries") or {}
        if t.get("seq") != p["seq"]:
            t = {"seq": p["seq"], "n": 0}
        t["n"] += 1
        t["last"] = utc()
        t["why"] = why[:200]
        r["batchTries"] = t
        if t["n"] >= COPY_TRIES:
            r["batch"] = {"seq": rec_seq(r), "state": "failed", "tried": p["seq"], "at": utc(), "why": why[:200]}
        return t["n"]
    return record_update(k, f)


def copy_may(k, p):
    """A copy that failed is tried again at the next idle, at most COPY_TRIES times an hour apart (desk-batch's rule)."""
    t = (record(k) or {}).get("batchTries") or {}
    if t.get("seq") != p["seq"]:
        return True
    if t.get("n", 0) >= COPY_TRIES:
        return False
    return time.time() - (parse_utc(t.get("last")) or 0) >= COPY_RETRY_S


# ---------------------------------------------------------------- the copy into a slot's rel/ (2.2 step 2)
def rel_tree_hash(root):
    """desk-host's rel_ok rule: desk-host-release's tree hash with the top's tree.sha256 and version.env (deskd's, the host's line) left out."""
    h = hashlib.sha256()
    for dp, dns, fns in os.walk(root):
        dns.sort()
        for name in sorted(dns + fns):
            if dp == root and name in ("tree.sha256", "version.env"):
                continue
            p = os.path.join(dp, name)
            st = os.lstat(p)
            rel = os.path.relpath(p, root)
            if stat.S_ISREG(st.st_mode):
                c = T.sha256_file(p)
            elif stat.S_ISLNK(st.st_mode):
                c = "->" + os.readlink(p)
            else:
                c = "-"
            h.update(f"{rel}\0{stat.S_IFMT(st.st_mode):o}\0{stat.S_IMODE(st.st_mode):o}\0{st.st_uid}\0{st.st_gid}\0{c}\n".encode())
    return h.hexdigest()


def copy_release(k, svc, ver, gen):
    """The store's svc ver into slots/<k>/rel/.new-<svc>, paced for desk-host-upd's io.max, checked against the store's tree hash;
    deskd's version.env from the slot's own generation, as a prepare writes it. rel/ is host-owned and outside the desk's root."""
    src = rdir(svc, ver)
    want = read1(f"{src}/tree.sha256")
    if not want:
        raise Failed(f"{svc} {ver} isn't in the store")
    rel = f"{SLOTS}/{k}/rel"
    if not os.path.isdir(rel) or os.path.islink(rel):
        raise Failed(f"slot {k} has no rel/")
    dst = f"{rel}/.new-{svc}"
    T.rm_tree(dst)
    os.mkdir(dst, 0o700)
    t0 = time.monotonic()
    n = T.copy_tree(src, dst)
    st = os.lstat(src)
    os.chown(dst, st.st_uid, st.st_gid)
    os.chmod(dst, stat.S_IMODE(st.st_mode))
    got = rel_tree_hash(dst)
    if got != want:
        T.rm_tree(dst)
        raise Failed(f"slot {k}: the copy of {svc} {ver} isn't the store's (tree {got[:12]}, store {want[:12]})")
    if svc == "deskd":
        rel_line = ""
        try:
            with open(f"{T.gen_dir(gen)}/etc/ma-release") as fh:
                for line in fh:
                    if line.startswith("version="):
                        rel_line = "DESKD_IMAGE_VERSION=" + line[len("version="):].strip() + "\n"
        except OSError:
            pass
        fd = os.open(f"{dst}/version.env", os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
        with os.fdopen(fd, "w") as f:
            f.write(rel_line)
    return n, round(time.monotonic() - t0, 1)


# ---------------------------------------------------------------- when a switch may run (2.2 step 1)
def pressure():
    try:
        for line in open("/proc/pressure/cpu"):
            if line.startswith("some "):
                return float(dict(x.split("=") for x in line.split()[1:])["avg10"])
    except (OSError, ValueError, KeyError):
        pass
    return 0.0


def switch_may(k, urgent_since=None):
    """(ok, why) for a live switch of slot k now: idle by its idle.json under desk-batch's rule for a service batch (downloads
    don't hold it: Chromium keeps running), the host's CPU not starved, no re-root or pre-read on the slot."""
    import idlerule
    pending = {"urgent": True, "offeredAt": urgent_since} if urgent_since else None
    ok, why = idlerule.slot_idle(k, pending, downloads=False)
    if not ok and not (E("DESK_HOST_BATCH_FORCE_IDLE") == "1" and T.test_mode()):
        return False, f"not idle: {why}"
    if E("DESK_HOST_BATCH_NO_PRESSURE") == "1" and T.test_mode():   # verify's "not while busy" mutation: the pressure rule turned off
        pass
    else:
        p = float(E("DESK_HOST_BATCH_PRESSURE", "nan")) if T.test_mode() and E("DESK_HOST_BATCH_PRESSURE") else pressure()
        if p > PRESSURE_MAX:
            return False, f"the host's cpu.pressure some avg10 is {p:.1f}% (over {PRESSURE_MAX:.0f}%)"
    room = desk_room(k)
    if room:
        return False, room
    try:
        pg = open(f"{RUN}/reroot/{k}.pgid").read().strip()
        if pg.isdigit() and os.path.exists(f"/proc/{pg}"):
            return False, "a re-root of the slot runs"
    except OSError:
        pass
    try:
        if open(f"{T.PRE}/cgroup.procs").read().split():
            return False, "a pre-read runs (desk-host-upd is frozen meanwhile)"
    except OSError:
        pass
    return True, why


def desk_room(k, cg=None, run=None):
    """None when the desk's cgroup has room for a sandbox made again (memory and tasks under its caps, no lower memory cap pending);
    else why not. A sandbox that can't start leaves its service down until the rollback's own start, which needs the same room."""
    cg = cg or f"{CGROUP}/desk-{k}"
    try:
        cur, mx = int(read1(f"{cg}/memory.current")), read1(f"{cg}/memory.max")
        pc, pm = int(read1(f"{cg}/pids.current")), read1(f"{cg}/pids.max")
    except (TypeError, ValueError):
        return "the desk's cgroup can't be read"
    if mx != "max" and int(mx) - cur < HEADROOM_MEM:
        return f"the desk has {(int(mx) - cur) >> 20} MiB under its memory.max ({HEADROOM_MEM >> 20} MiB needed)"
    if pm != "max" and int(pm) - pc < HEADROOM_PIDS:
        return f"the desk has {int(pm) - pc} tasks under its pids.max ({HEADROOM_PIDS} needed)"
    try:
        with open(f"{run or RUN}/{k}/class.json") as f:
            if (json.load(f) or {}).get("pending"):
                return "a lower memory cap is pending for the desk (it doesn't fit its class yet)"
    except (OSError, ValueError):
        pass
    return None


# ---------------------------------------------------------------- retention (1.4)
def names_in_use():
    """{svc: {version}} every link, every slot's record (its releases, a switch's or a verify's old set) and every running sandbox names."""
    keep = {svc: set() for svc in STORE_COMPS}
    for svc in STORE_COMPS:
        for name in LINKS:
            v = link(svc, name)
            if v:
                keep[svc].add(v)
    st = load_state()
    for e in [st.get("current"), st.get("previous"), st.get("candidate")]:
        for svc, x in ((e or {}).get("components") or {}).items():
            keep.setdefault(svc, set()).add(x["version"])
    for k, r in T.records().items():
        for svc, v in rec_releases(r, st).items():
            keep.setdefault(svc, set()).add(v)
        for key in ("switching", "verify"):
            for c in ((r.get(key) or {}).get("components") or []):
                for v in (c.get("from"), c.get("to")):
                    if v:
                        keep.setdefault(c["name"], set()).add(v)
    return keep


def gc():
    """Releases nothing names are deleted without following links. A candidate's are kept while it's the candidate."""
    keep = names_in_use()
    gone = []
    for svc in STORE_COMPS:
        for v in versions(svc):
            if v not in keep.get(svc, set()):
                T.rm_tree(rdir(svc, v))
                gone.append(f"{svc} {v}")
        for stale in os.listdir(f"{STORE}/{svc}") if os.path.isdir(f"{STORE}/{svc}") else []:
            if ".new." in stale:
                T.rm_tree(f"{STORE}/{svc}/{stale}")
    for f in os.listdir(BVAR) if os.path.isdir(BVAR) else []:   # kept manifests of batches no state entry names
        m = re.fullmatch(r"(\d+)\.(json|sig)", f)
        if m:
            s = int(m.group(1))
            st = load_state()
            named = {(st.get(x) or {}).get("seq") for x in ("current", "previous", "candidate")} | halted_seqs(st)
            if s not in named:
                try:
                    os.unlink(f"{BVAR}/{f}")
                except OSError:
                    pass
    return gone


# ---------------------------------------------------------------- the report (PB-1)
def _e(x):
    return {k: x.get(k) for k in ("seq", "id", "at")} if x else None


def report_host(st=None):
    st = st or load_state()
    cand = st.get("candidate")
    out = {"batches": {"current": _e(st.get("current")) or {"seq": B.baseline(), "id": "image", "at": None},
                       "previous": _e(st.get("previous")),
                       "candidate": dict(_e(cand), trialSlot=cand.get("trialSlot"), trialPassedAt=cand.get("trialPassedAt"),
                                         promoteOrdered=cand.get("promoteOrdered")) if cand else None,
                       "halted": [{"seq": h["seq"], "id": h.get("id"), "at": h.get("at"), "reason": h.get("reason")} for h in st.get("halted") or []][-10:],
                       "floor": {"seq": floor(st), "id": None, "at": None}}}
    fs = read_fetch_status()
    if fs:
        out["batchFetch"] = {k: fs.get(k) for k in ("seq", "state", "step", "at", "error")}
    e = cand or st.get("current") or {}
    out["templatePending"] = list(e.get("templatePending") or [])
    out["imagePending"] = e.get("imagePending")
    return out


def slot_state(k, rec, st):
    """PB-1's per-slot batch state: current, behind, copying, switching, rolled-back or failed."""
    b = (rec or {}).get("batch") or {}
    if (rec or {}).get("switching"):
        return "switching"
    if os.path.exists(f"{RUN}/batch/{k}.copying"):
        return "copying"
    if b.get("state") in ("rolled-back", "failed") and target(st, k, rec) is None:
        return b["state"]
    if (rec or {}).get("verify"):
        return "switching"
    t = target(st, k, rec)
    if t is None:
        return "current"
    if b.get("state") == "failed" and b.get("tried") == t[0]["seq"]:
        return "failed"
    return "behind"


def report_slot(k, rec, st=None):
    st = st or load_state()
    if not rec or rec.get("state") not in ("desk", "fresh"):
        return {}
    state = slot_state(k, rec, st)
    b = rec.get("batch") or {}
    seq = b["tried"] if state in ("rolled-back", "failed") and isinstance(b.get("tried"), int) else rec_seq(rec, st)
    return {"batch": {"seq": seq, "state": state}, "releases": rec_releases(rec, st)}
