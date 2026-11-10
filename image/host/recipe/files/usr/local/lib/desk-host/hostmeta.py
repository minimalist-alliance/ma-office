"""hostmeta.py: what desk-host, its report and desk-host-link share about the host's own metadata (ma-platform contract
shared-host.md section 2; ADR 0072 Platform's side, PF-01). Host root only: IMDS answers uid 0 alone (the host's ruleset).

- Imds: IMDSv2 for the host itself (a token from PUT, then reads with it), one second a request, no proxy. The base URL is
  the real IMDS; tests point it elsewhere (DESK_HOST_IMDS).
- parse_slot_tag(): DeskSlot<k> = <deskId|->/<volumeId|->/<privateIp>/<allocationId>/<epoch>[/<class>], read strictly.
  The sixth field, the slot's size class, is optional and only a class /etc/desk-host/classes.conf names (standard and free
  today; missing means standard; the System Engineer's size classes, accepted for the contract by the coordinator), so a new
  class needs only that table. Anything that isn't exactly that is None, and None means nothing: no slot is started,
  prepared or mapped from it. The other patterns are Platform's own (services/desks/src/sharedhost.ts), so the two read the
  same tag the same way.
- class_names(): the classes classes.conf names, read with classes.py's own validated loader (standard always).
- slot_tags(): every slot's tag, 1 to SlotsPerHost, through one token.
- desks_per_host(): the first boot's DesksPerHost, the host's size in standard desks (hosting.json, desk-host-boot); the
  hello's desksPerHost.
- slots_per_host(): the first boot's SlotsPerHost, how many slots the host has (DesksPerHost to 29; DesksPerHost when
  there's none, a host from before the size classes).

Python 3 standard library only.
"""
import importlib.util
import json
import os
import re
import urllib.error
import urllib.request

IMDS = os.environ.get("DESK_HOST_IMDS", "http://169.254.169.254")
CLASSES_TABLE = os.environ.get("DESK_HOST_CLASSES", "/etc/desk-host/classes.conf")
HOSTING = os.environ.get("DESK_HOST_HOSTING", "/var/lib/desk-host/hosting.json")
SLOTS_MAX = 29

DESK_ID = re.compile(r"d-[a-z2-7]{12}")
VOLUME_ID = re.compile(r"vol-[0-9a-f]{8,17}")
ALLOCATION_ID = re.compile(r"eipalloc-[0-9a-f]{8,17}")
INSTANCE_ID = re.compile(r"i-[0-9a-f]{8,17}")
IPV4 = re.compile(r"(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}")
EPOCH = re.compile(r"0|[1-9]\d{0,8}")
_classes = {}


def class_names(path=None):
    """The size classes a tag may name: classes.conf's, by classes.py's load() (the one parser of that table; a line it
    can't read names nothing), and standard, which the table must have and a five-field tag means. Read again when the file changes."""
    path = path or CLASSES_TABLE
    try:
        key = (path, os.stat(path).st_mtime_ns)
    except OSError:
        return frozenset({"standard"})
    if key not in _classes:
        spec = importlib.util.spec_from_file_location("desk_host_classes", os.path.join(os.path.dirname(os.path.abspath(__file__)), "classes.py"))
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        _classes.clear()
        _classes[key] = frozenset(m.load(path)[0]) | {"standard"}
    return _classes[key]


def is_desk_id(s):
    return isinstance(s, str) and DESK_ID.fullmatch(s) is not None


def is_ipv4(s):
    return isinstance(s, str) and IPV4.fullmatch(s) is not None


def parse_slot_tag(v):
    """The tag's value as {deskId, volumeId, privateIp, allocationId, epoch}, or None for anything else. An empty slot has
    no desk and no volume and still names its addresses."""
    if not isinstance(v, str) or len(v) > 256:
        return None
    parts = v.split("/")
    if len(parts) == 6:
        cls = parts.pop()
        if cls not in class_names():
            return None
    elif len(parts) == 5:
        cls = "standard"
    else:
        return None
    d, vol, ip, alloc, e = parts
    empty = d == "-" and vol == "-"
    if not empty and not (DESK_ID.fullmatch(d) and VOLUME_ID.fullmatch(vol)):
        return None
    if not IPV4.fullmatch(ip) or not ALLOCATION_ID.fullmatch(alloc) or not EPOCH.fullmatch(e):
        return None
    return {"deskId": None if empty else d, "volumeId": None if empty else vol, "privateIp": ip, "allocationId": alloc,
            "epoch": int(e), "class": cls}


def desks_per_host():
    n = json.load(open(HOSTING))["desksPerHost"]
    if not isinstance(n, int) or not 1 <= n <= SLOTS_MAX:
        raise ValueError("DesksPerHost out of range")
    return n


def slots_per_host():
    with open(HOSTING) as f:
        h = json.load(f)
    n = h.get("slotsPerHost") or h["desksPerHost"]
    if not isinstance(n, int) or not 1 <= n <= SLOTS_MAX:
        raise ValueError("SlotsPerHost out of range")
    return n


class ImdsError(Exception):
    pass


class Imds:
    """IMDSv2 for host root. get() is None on a 404 (no such path), ImdsError on anything else that isn't a 200."""

    def __init__(self, base=None, timeout=1.0):
        self.base = (base or IMDS).rstrip("/")
        self.timeout = timeout
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.token = None

    def _token(self):
        req = urllib.request.Request(self.base + "/latest/api/token", method="PUT",
                                     headers={"X-aws-ec2-metadata-token-ttl-seconds": "300"})
        try:
            with self.opener.open(req, timeout=self.timeout) as r:
                return r.read(256).decode()
        except (OSError, ValueError) as e:
            raise ImdsError(f"token: {type(e).__name__}") from None

    def get(self, path, retry=True):
        if self.token is None:
            self.token = self._token()
        req = urllib.request.Request(self.base + "/latest/" + path.lstrip("/"), headers={"X-aws-ec2-metadata-token": self.token})
        try:
            with self.opener.open(req, timeout=self.timeout) as r:
                return r.read(65536).decode()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code == 401 and retry:
                self.token = None
                return self.get(path, retry=False)
            raise ImdsError(f"HTTP {e.code}") from None
        except (OSError, ValueError) as e:
            raise ImdsError(type(e).__name__) from None


def slot_tags(imds, n):
    """{k: parsed tag or None} for 1..n. A tag that's absent or doesn't parse is None. ImdsError if IMDS can't be read."""
    out = {}
    for k in range(1, n + 1):
        out[k] = parse_slot_tag(imds.get(f"meta-data/tags/instance/DeskSlot{k}"))
    return out


def mac_of_address(imds, ip):
    """(mac, subnet CIDR) of the host's interface whose private addresses include ip, by IMDS; None if no interface has it."""
    macs = imds.get("meta-data/network/interfaces/macs/") or ""
    for mac in [m.strip().rstrip("/") for m in macs.splitlines() if m.strip()]:
        ips = (imds.get(f"meta-data/network/interfaces/macs/{mac}/local-ipv4s") or "").split()
        if ip in ips:
            return mac, (imds.get(f"meta-data/network/interfaces/macs/{mac}/subnet-ipv4-cidr-block") or "").strip()
    return None


def association(imds, mac, public_ip):
    """The private address IMDS says public_ip is associated with on this interface, or None."""
    if not is_ipv4(public_ip):
        return None
    v = imds.get(f"meta-data/network/interfaces/macs/{mac}/ipv4-associations/{public_ip}")
    return v.strip() if v else None
