#!/usr/bin/python3 -I
"""report.py: the slot report, as desk-host report prints it and desk-host-link carries it (ma-platform contract
shared-host.md section 4). Host root. One JSON object on one line:

  {"slots": [{"k": 1, "state": "running", "deskId": "d-...", "epoch": 3, "class": "standard", "net": {"bytesOut": 123, "bytesIn": 456},
              "fault": "..."}, ...],
   "conntrack": {"count": 9000, "max": 65536}}

- state, exactly as the contract names them: starting and stopping while desk-host up or stop runs (its marker,
  /run/desk-host/op/<k>); running while the desk's container runs; prepared for a fresh root no desk has claimed; stopped
  for a desk's root whose desk isn't running while its volume's filesystem is still held, unmounted once it isn't (so a
  detach or a snapshot is clean); empty for a slot with no root (never prepared, or a prepare in flight).
- deskId and epoch: for a slot that's starting, running or stopping, the desk and epoch desk-host started it with;
  otherwise what the slot's tag says now (null and the tag's epoch for an empty slot). A tag that's absent or doesn't parse
  gives null and 0, with fault tag_unreadable, so Platform ignores and flags the slot.
- net.bytesOut: the slot's counter (out_<k>), counted in the host's forward path after the slot's spoof drop, keyed by its
  veth, every packet out (established flows included, desk_est; ADR 0072 section 8); 0 when the counter's epoch isn't the
  reported one. desk-host resets it at each start (a wake at the same epoch included; Platform takes a lower count as a
  restart), and a boot starts it at 0. net.bytesIn is the same for what the desk receives (rx_<k>); Platform reads only
  bytesOut today, and the desk's own net.json carries both.
- class (contract 0.3.46, S-119): for a slot that's starting, running or stopping, the class desk-host runs its container
  at, from the host's own record (/run/desk-host/<k>/class.json, written at each start and each `desk-host class`), with
  "+pending" while a memory.max waits (a lower cap the desk doesn't fit yet, until its next start). Platform orders set_class
  when it isn't the slot's record's, and the link's set_class is done once this says the order's class; absent otherwise.
- shaper (running slots only; ADR 0036 per container, egress.py show): the outbound shaper on the desk's veth: on, each class's
  rate and tc's counters ({"10": {"rateBits", "bytes", "packets", "drops", "overlimits"}, "15": ..., "20": ...}), off when desk-host
  shaper <k> off took it off, and the budget's state (slowed, clamped, profile, bucketGb, dayGb, monthGb, savedAgoS). Platform reads
  none of it today (its validator ignores fields it doesn't know); ADR 0036's test 1 on a shared host reads each class's rate from
  the counters between two reports, beside net.bytesOut.
- fault: only when desk-host last refused to start the slot (/run/desk-host/fault/<k>): tag_unreadable, tag_mismatch,
  address_absent, address_mismatch, volume_absent, start_failed. Platform's validator reads the other fields only.

- ADR 0077's fields (PU-1), additive: per slot `template` (its generation), `chromium` (that generation's), `lastVersion` (the
  host's last read of its profile's Last Version, or null), `behind` (not on the current generation), `chromiumBehind` (no
  generation here is new enough for its profile) and `update.holdUntil`; per host `templates` (current, previous, candidate,
  each {gen, chromium, sealedAt, target}, and halted), `fetch` ({target, gen, state, at, step, error}) and `hostApt` ({lastOk,
  lastResult, rebootPending: {since, kernel}}). A fresh root is `prepared` only on the current generation.

- ADR 0078's fields (PB-1), additive: per slot `batch` ({seq, state}: current, behind, copying, switching, rolled-back or failed) and
  `releases` (each store component's version in its rel/); per host `batches` (current, previous, candidate with its canary, halted
  and floor, each {seq, id, at}), `batchFetch` ({seq, state, step, at, error}), `templatePending` ([{name, version}]: a batch's
  desk-agent-filter the template doesn't have) and `imagePending` ({seq, image}). update.holdUntil (ADR 0077's) is ahead while a switch runs.

Nothing about a member is in it: desk IDs and counts only.
"""
import json
import os
import re
import subprocess
import sys

sys.dont_write_bytecode = True   # nothing written beside the host's own code
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import batches  # noqa: E402
import egress  # noqa: E402
import hostmeta  # noqa: E402
import templates  # noqa: E402

REC = "/var/lib/desk-host/slots"
RUN = "/run/desk-host"
S = "/srv/desk-host/slots"
FAULTS = {"tag_unreadable", "tag_mismatch", "address_absent", "address_mismatch", "volume_absent", "start_failed"}
CLASS = re.compile(r"[a-z][a-z0-9-]{0,31}")   # classes.conf's names


def read_json(p):
    try:
        with open(p) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def read_text(p):
    try:
        with open(p) as f:
            return f.read().strip()
    except OSError:
        return None


def container_status(k):
    r = subprocess.run(["runc", "state", f"dh-desk-{k}"], capture_output=True, text=True)
    if r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout).get("status")
    except ValueError:
        return None


def counters():
    """{k: (bytes out, bytes in)} from the slots' named counters, out_<k> and rx_<k>."""
    r = subprocess.run(["nft", "-j", "list", "counters", "table", "inet", "host"], capture_output=True, text=True)
    out = {}
    if r.returncode == 0:
        try:
            for o in json.loads(r.stdout).get("nftables", []):
                c = o.get("counter")
                m = re.fullmatch(r"(out|rx)_(\d+)", (c or {}).get("name", ""))
                if m:
                    o_, i_ = out.get(int(m.group(2)), (0, 0))
                    n = int(c.get("bytes", 0))
                    out[int(m.group(2))] = (n, i_) if m.group(1) == "out" else (o_, n)
        except (ValueError, TypeError):
            pass
    return out


def volume_held(vol):
    """Whether the volume's filesystem is still held by the kernel (a mount anywhere), by its NVMe serial."""
    if not vol:
        return False
    want = vol.replace("-", "", 1)
    for c in os.listdir("/sys/class/nvme") if os.path.isdir("/sys/class/nvme") else []:
        if read_text(f"/sys/class/nvme/{c}/serial") == want:
            for ns in os.listdir(f"/sys/class/nvme/{c}"):
                if re.fullmatch(rf"{c}n\d+", ns) and os.path.exists(f"/sys/fs/ext4/{ns}"):
                    return True
    return False


def state_of(rec, status, op, tmpl_id, root_ok, held):
    """The contract's state from desk-host's own records. Pure, so it's tested without a host."""
    if op == "starting" or status == "created":
        return "starting"
    if op == "stopping":
        return "stopping"
    if status in ("running", "paused"):
        return "running"
    if rec is None or not root_ok:
        return "empty"
    if rec.get("state") == "fresh":
        return "prepared" if rec.get("template") == tmpl_id else "empty"
    return "stopped" if held else "unmounted"


def class_of(rec):
    """The class a slot's container runs at, from its class.json: "<class>", or "<class>+pending" while a memory.max waits;
    None when there's no record or it names no class."""
    if not isinstance(rec, dict) or not isinstance(rec.get("class"), str) or not CLASS.fullmatch(rec["class"]):
        return None
    return rec["class"] + ("+pending" if rec.get("pending") else "")


def slot_entry(k, tag, tag_ok, rec, status, op, run, tmpl_id, root_ok, held, counter, net_epoch, fault, counter_in=0, cls=None):
    st = state_of(rec, status, op, tmpl_id, root_ok, held)
    if st in ("starting", "running", "stopping") and run and hostmeta.is_desk_id(run.get("deskId")) and isinstance(run.get("epoch"), int):
        desk, epoch = run["deskId"], run["epoch"]
    elif tag:
        desk, epoch = tag["deskId"], tag["epoch"]
    else:
        desk, epoch = None, 0
    mine = net_epoch == epoch
    e = {"k": k, "state": st, "deskId": desk, "epoch": epoch,
         "net": {"bytesOut": counter if (counter and mine) else 0, "bytesIn": counter_in if (counter_in and mine) else 0}}
    if cls and st in ("starting", "running", "stopping"):
        e["class"] = cls
    if not tag_ok:
        e["fault"] = "tag_unreadable"
    elif fault in FAULTS and st not in ("running", "starting"):
        e["fault"] = fault
    return e


def main():
    n = hostmeta.slots_per_host()
    imds = hostmeta.Imds()
    try:
        tags, tags_ok = hostmeta.slot_tags(imds, n), True
    except hostmeta.ImdsError:
        tags, tags_ok = {}, False
    tst = templates.load_state()
    tmpl_id = templates.current_gen(tst)
    bst = batches.load_state()
    cnt = counters()
    slots = []
    for k in range(1, n + 1):
        tag = tags.get(k)
        net_epoch = read_text(f"{RUN}/net/{k}.epoch")
        rec = read_json(f"{REC}/{k}.json")
        e = slot_entry(k, tag, tags_ok and tag is not None, rec, container_status(k), read_text(f"{RUN}/op/{k}"),
                       read_json(f"{RUN}/slotstate/{k}.json"), tmpl_id, os.path.isdir(f"{S}/{k}/rootfs"),
                       volume_held(tag["volumeId"] if tag else None), cnt.get(k, (0, 0))[0],
                       int(net_epoch) if net_epoch and net_epoch.isdigit() else None, read_text(f"{RUN}/fault/{k}"),
                       counter_in=cnt.get(k, (0, 0))[1], cls=class_of(read_json(f"{RUN}/{k}/class.json")))
        if e["state"] == "running":
            try:
                e["shaper"] = egress.show(k, e["deskId"])
            except Exception as x:  # noqa: BLE001 - the shaper's view never costs the report
                e["shaper"] = {"on": False, "error": f"{type(x).__name__}: {x}"[:160]}
        e.update(templates.report_slot(k, rec, tst))
        try:
            e.update(batches.report_slot(k, rec, bst))
        except Exception as x:  # noqa: BLE001 - a batch field never costs the report
            e["batch"] = {"seq": None, "state": "unknown", "error": f"{type(x).__name__}"}
        slots.append(e)
        net = read_json(f"{RUN}/{k}/net.json")   # the desk's own read-only view of its count (ADR 0072 section 8), as before
        if net is not None:
            with open(f"{RUN}/{k}/net.json.tmp", "w") as f:
                json.dump({"bytesOut": e["net"]["bytesOut"], "bytesIn": e["net"]["bytesIn"], "boot": net.get("boot", "")}, f)
            os.replace(f"{RUN}/{k}/net.json.tmp", f"{RUN}/{k}/net.json")
    ct = {}
    for key, p in (("count", "/proc/sys/net/netfilter/nf_conntrack_count"), ("max", "/proc/sys/net/netfilter/nf_conntrack_max")):
        v = read_text(p)
        if v and v.isdigit():
            ct[key] = int(v)
    out = {"slots": slots}
    if len(ct) == 2:
        out["conntrack"] = ct
    out.update(templates.report_host())
    try:
        out.update(batches.report_host(bst))
    except Exception as x:  # noqa: BLE001
        out["batchFetch"] = {"state": "unknown", "error": f"{type(x).__name__}"}
    print(json.dumps(out, separators=(",", ":")))


if __name__ == "__main__":
    main()
