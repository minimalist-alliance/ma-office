#!/usr/bin/python3 -I
"""report.py: the slot report, as desk-host report prints it and desk-host-link carries it (ma-platform contract
shared-host.md section 4). Host root. One JSON object on one line:

  {"slots": [{"k": 1, "state": "running", "deskId": "d-...", "epoch": 3, "net": {"bytesOut": 123, "bytesIn": 456}, "fault": "..."}, ...],
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
- fault: only when desk-host last refused to start the slot (/run/desk-host/fault/<k>): tag_unreadable, tag_mismatch,
  address_absent, address_mismatch, volume_absent, start_failed. Platform's validator reads the other fields only.

Nothing about a member is in it: desk IDs and counts only.
"""
import json
import os
import re
import subprocess
import sys

sys.dont_write_bytecode = True   # nothing written beside the host's own code
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hostmeta  # noqa: E402

REC = "/var/lib/desk-host/slots"
RUN = "/run/desk-host"
T = "/srv/desk-host/template"
S = "/srv/desk-host/slots"
FAULTS = {"tag_unreadable", "tag_mismatch", "address_absent", "address_mismatch", "volume_absent", "start_failed"}


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


def slot_entry(k, tag, tag_ok, rec, status, op, run, tmpl_id, root_ok, held, counter, net_epoch, fault, counter_in=0):
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
    tmpl = (read_text(f"{T}/.complete") or "").splitlines()
    tmpl_id = tmpl[0] if tmpl else None
    cnt = counters()
    slots = []
    for k in range(1, n + 1):
        tag = tags.get(k)
        net_epoch = read_text(f"{RUN}/net/{k}.epoch")
        e = slot_entry(k, tag, tags_ok and tag is not None, read_json(f"{REC}/{k}.json"), container_status(k), read_text(f"{RUN}/op/{k}"),
                       read_json(f"{RUN}/slotstate/{k}.json"), tmpl_id, os.path.isdir(f"{S}/{k}/rootfs"),
                       volume_held(tag["volumeId"] if tag else None), cnt.get(k, (0, 0))[0],
                       int(net_epoch) if net_epoch and net_epoch.isdigit() else None, read_text(f"{RUN}/fault/{k}"),
                       counter_in=cnt.get(k, (0, 0))[1])
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
    print(json.dumps(out, separators=(",", ":")))


if __name__ == "__main__":
    main()
