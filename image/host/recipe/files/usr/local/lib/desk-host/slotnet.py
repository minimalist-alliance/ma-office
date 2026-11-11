#!/usr/bin/python3 -I
"""slotnet.py resolve <k> <deskId> <volume id or -> <public address> | tag <k> | mode: what desk-host needs of slot k's
tag and addresses before it starts anything (ma-platform contract shared-host.md section 2; ADR 0072 Platform's side,
PF-01 and PF-03, and section 6's 2026-11-10 note). Host root.

The host's SlotMode (its first boot's launch tag, hosting.json; hostmeta.slot_mode) decides how a slot is reached:
- address (choice A; no SlotMode tag): each slot has a private address and an Elastic IP of its own, on 443.
- port (choice B, the owner's, 2026-11-10): one public IPv4 for the whole host, the one EC2 auto-assigned at launch; slot
  k is UDP 4430 + k on it, and every slot's ICE-TCP comes in on the host's 443 through desk-ice-demux.

resolve:
1. DeskSlot<k>, read strictly for the host's mode (hostmeta.parse_slot_tag): it must name this desk (and this volume,
   when one is given). Under port its two address fields are "-".
2. address: the slot's address is the tag's privateIp, on whichever of the host's interfaces carries it: the slots'
   interface is the host's second one under PF-03, never the host's own, and slot k is never "the k-th address". When
   the tag's address isn't on any interface yet but IMDS lists it on one of the host's interfaces, it's added there (the
   OS configures only what cloud-init saw at boot).
   port: the slot's address is the host's own, the default route's interface's, which must be IMDS's local-ipv4, and the
   public address (the link's hello) must be IMDS's public-ipv4: the host's address as EC2 has it now (it changes at a
   host stop and start, and the link says hello again at every boot).
3. IMDS's ipv4-associations for that interface must map the public address to that private address. Anything else keeps
   the slot down.
4. address only: the gateway for the slot's own routing table, when the address's interface isn't the one with the
   default route, so the slot's packets leave from the interface that owns its address (EC2 drops anything else).

Prints "<epoch> <volumeId> <address> <interface> <gateway or -> <MAC> <class>" (the class from the tag's optional sixth
field, standard when it has none) and exits 0, or prints "fault <code> <why>" and exits 3. Codes: tag_unreadable,
tag_mismatch, address_absent, address_mismatch, slot_mode (the report carries the code, nothing else).

tag <k>: "<deskId|-> <volumeId|-> <class>" of DeskSlot<k>, read as strictly as resolve reads it (desk-host class with no
class), or exit 3. mode: the host's SlotMode, or exit 3.
"""
import ipaddress
import json
import os
import subprocess
import sys

sys.dont_write_bytecode = True   # nothing written beside the host's own code
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hostmeta  # noqa: E402


class Fault(Exception):
    def __init__(self, code, why):
        super().__init__(why)
        self.code = code


def ip_json(*args):
    return json.loads(subprocess.run(["ip", "-j", *args], capture_output=True, text=True, check=True).stdout or "[]")


def iface_with(ip):
    """(interface name, prefix length) of the interface carrying ip, or None."""
    for link in ip_json("-4", "addr", "show"):
        for a in link.get("addr_info", []):
            if a.get("family") == "inet" and a.get("local") == ip:
                return link["ifname"], a["prefixlen"]
    return None


def iface_by_mac(mac):
    for link in ip_json("link", "show"):
        if link.get("address", "").lower() == mac.lower():
            return link["ifname"]
    return None


def default_iface():
    """The interface of the main table's default route with the lowest metric (the host's own, device 0, under PF-03)."""
    routes = [r for r in ip_json("-4", "route", "show", "default") if r.get("dev")]
    return min(routes, key=lambda r: r.get("metric", 0))["dev"] if routes else None


def host_mode():
    try:
        return hostmeta.slot_mode()
    except (OSError, ValueError, KeyError):
        raise Fault("slot_mode", "the host's SlotMode (hosting.json) is neither address nor port") from None


def read_tag(k, mode, imds):
    try:
        raw = imds.get(f"meta-data/tags/instance/DeskSlot{k}")
    except hostmeta.ImdsError as e:
        raise Fault("tag_unreadable", f"IMDS: {e}") from None
    tag = hostmeta.parse_slot_tag(raw, mode)
    if tag is None:
        raise Fault("tag_unreadable", f"DeskSlot{k} is {'absent' if raw is None else 'not a slot tag for SlotMode=' + mode}")
    return tag


def resolve(k, desk, vol, public, mode, imds):
    if mode not in hostmeta.SLOT_MODES:
        raise Fault("slot_mode", "no SlotMode")
    try:
        raw = imds.get(f"meta-data/tags/instance/DeskSlot{k}")
    except hostmeta.ImdsError as e:
        raise Fault("tag_unreadable", f"IMDS: {e}") from None
    tag = hostmeta.parse_slot_tag(raw, mode)
    if tag is None:
        raise Fault("tag_unreadable", f"DeskSlot{k} is {'absent' if raw is None else 'not a slot tag'}")
    if tag["deskId"] != desk:
        raise Fault("tag_mismatch", f"DeskSlot{k} doesn't name this desk")
    if vol != "-" and tag["volumeId"] != vol:
        raise Fault("tag_mismatch", f"DeskSlot{k} doesn't name this volume")
    if not hostmeta.is_ipv4(public):
        raise Fault("address_mismatch", "no public address for the slot (the host link's hello gives it)")
    if mode == "port":
        dev = default_iface()
        found = None
        if dev:
            for link in ip_json("-4", "addr", "show", "dev", dev):
                for a in link.get("addr_info", []):
                    if a.get("family") == "inet" and found is None:
                        found = (a["local"], a["prefixlen"])
        if not found:
            raise Fault("address_absent", "the host has no address of its own")
        ip = found[0]
        try:
            own, pub = (imds.get("meta-data/local-ipv4") or "").strip(), (imds.get("meta-data/public-ipv4") or "").strip()
        except hostmeta.ImdsError as e:
            raise Fault("address_absent", f"IMDS: {e}") from None
        if own != ip:
            raise Fault("address_absent", "the default route's address isn't the instance's own (IMDS local-ipv4)")
        if not hostmeta.is_ipv4(pub):
            raise Fault("address_absent", "the host has no public IPv4 (IMDS public-ipv4)")
        if pub != public:
            raise Fault("address_mismatch", f"slot {k}'s public address (the hello's) isn't the host's own now (IMDS public-ipv4)")
    else:
        ip = tag["privateIp"]
    try:
        owner = hostmeta.mac_of_address(imds, ip)
    except hostmeta.ImdsError as e:
        raise Fault("address_absent", f"IMDS: {e}") from None
    if owner is None:
        raise Fault("address_absent", f"no interface of this host has slot {k}'s address")
    mac, cidr = owner
    have = iface_with(ip)
    if have is None:
        dev = iface_by_mac(mac)
        if dev is None:
            raise Fault("address_absent", f"slot {k}'s interface isn't in the OS")
        prefix = ipaddress.ip_network(cidr, strict=False).prefixlen if cidr else 32
        subprocess.run(["ip", "addr", "add", f"{ip}/{prefix}", "dev", dev], check=True, capture_output=True)
        subprocess.run(["ip", "link", "set", "dev", dev, "up"], check=True, capture_output=True)
        have = (dev, prefix)
    dev, prefix = have
    if (iface_by_mac(mac) or "") != dev:
        raise Fault("address_absent", f"slot {k}'s address is on an interface IMDS doesn't give it to")
    try:
        assoc = hostmeta.association(imds, mac, public)
    except hostmeta.ImdsError as e:
        raise Fault("address_mismatch", f"IMDS: {e}") from None
    if assoc != ip:
        raise Fault("address_mismatch", f"slot {k}'s public address isn't associated with its private address")
    gw = "-"
    if dev != default_iface():
        net = ipaddress.ip_network(cidr if cidr else f"{ip}/{prefix}", strict=False)
        gw = str(net.network_address + 1)   # the VPC's router: the subnet's base plus one
    return f"{tag['epoch']} {tag['volumeId']} {ip} {dev} {gw} {mac} {tag['class']}"


def main(argv):
    try:
        if len(argv) == 2 and argv[1] == "mode":
            print(host_mode())
            return 0
        if len(argv) == 3 and argv[1] == "tag" and argv[2].isdigit():
            t = read_tag(int(argv[2]), host_mode(), hostmeta.Imds())
            print(t["deskId"] or "-", t["volumeId"] or "-", t["class"])
            return 0
        if len(argv) == 6 and argv[1] == "resolve":
            k, desk, vol, public = argv[2:]
            print(resolve(int(k), desk, vol, public, host_mode(), hostmeta.Imds()))
            return 0
    except Fault as f:
        print(f"fault {f.code} {f}")
        return 3
    print("usage: slotnet.py resolve <k> <deskId> <volume id or -> <public address> | tag <k> | mode", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
