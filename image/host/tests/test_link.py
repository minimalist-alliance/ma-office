#!/usr/bin/python3 -I
"""desk-host-link and its parts, with no root and no AWS (image/host/README.md, "The host link").

  python3 -I image/host/tests/test_link.py

- SigV4 against AWS's test suite (get-vanilla), AWS's documented IAM example, and the vector deskd's own test holds equal to
  botocore's (an execute-api POST with a body and a session token).
- DeskSlot<k>'s strict parse, and report.py's states.
- The link end to end against fake_platform.py (the three routes, every signature checked), a fake IMDS and
  fake_desk_host.py: hello, reports, each order once per ID, refusals, hello_required, backoff, the stand-in per slot on the
  loopback (127.0.<k>.1, answering 127.0.<k>.2 only), session refresh and revocation, and nothing about a member in its log.
"""
import datetime
import importlib.machinery
import importlib.util
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.normpath(os.path.join(HERE, "../recipe/files/usr/local/lib/desk-host"))
sys.path.insert(0, LIB)
CLASSES_CONF = os.path.normpath(os.path.join(HERE, "../recipe/files/etc/desk-host/classes.conf"))
os.environ.setdefault("DESK_HOST_CLASSES", CLASSES_CONF)   # the image's table: what a tag's class may name
import hostmeta  # noqa: E402
import sigv4  # noqa: E402

spec = importlib.util.spec_from_file_location("report", os.path.join(LIB, "report.py"))
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)

DESK_A, DESK_B = "d-abcdefghijk2", "d-zyxwvutsrqp7"
VOL_A, VOL_B = "vol-0123456789abcdef0", "vol-0fedcba987654321f"
HOST = "i-0abc1234def567890"


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class SigV4Test(unittest.TestCase):
    SUITE = ("AKIDEXAMPLE", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY")
    T = datetime.datetime(2015, 8, 30, 12, 36, tzinfo=datetime.timezone.utc)

    def test_aws_suite_get_vanilla(self):
        h = sigv4.sign("GET", "https://example.amazonaws.com/", {}, b"", "service", "us-east-1", *self.SUITE, now=self.T)
        self.assertEqual(h["authorization"], "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, "
                         "SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31")
        self.assertEqual(h["host"], "example.amazonaws.com")

    def test_aws_documentation_iam_list_users(self):
        h = sigv4.sign("GET", "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
                       {"Content-Type": "application/x-www-form-urlencoded; charset=utf-8"}, b"", "iam", "us-east-1", *self.SUITE, now=self.T)
        self.assertTrue(h["authorization"].endswith("SignedHeaders=content-type;host;x-amz-date, "
                                                    "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"))

    def test_an_execute_api_post_with_a_token_matches_botocore(self):
        h = sigv4.sign("POST", "https://api.staging.minimalistalliance.com/v1/agent/heartbeat", {"content-type": "application/json"},
                       b'{"bootId":"b","seq":1}', "execute-api", "us-east-1", "ASIAVEXAMPLE7Q2M", "secretExampleKey/abc+def",
                       "IQoJb3JpZ2luX2VjEJrExampleToken==", now=datetime.datetime(2026, 11, 4, 21, tzinfo=datetime.timezone.utc))
        self.assertEqual(h["x-amz-security-token"], "IQoJb3JpZ2luX2VjEJrExampleToken==")
        self.assertEqual(h["authorization"], "AWS4-HMAC-SHA256 Credential=ASIAVEXAMPLE7Q2M/20261104/us-east-1/execute-api/aws4_request, "
                         "SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, "
                         "Signature=77b425c2ee7433acf675a9cb069606afc43908b04f9d1aa47af70dd5f55d1a29")


class SlotTagTest(unittest.TestCase):
    def test_a_placed_slot(self):
        self.assertEqual(hostmeta.parse_slot_tag(f"{DESK_A}/{VOL_A}/10.20.1.57/eipalloc-0abc12345/3"),
                         {"deskId": DESK_A, "volumeId": VOL_A, "privateIp": "10.20.1.57", "allocationId": "eipalloc-0abc12345", "epoch": 3, "class": "standard"})

    def test_the_optional_sixth_field_is_the_size_class(self):
        for cls in ("standard", "free"):
            self.assertEqual(hostmeta.parse_slot_tag(f"{DESK_A}/{VOL_A}/10.20.1.57/eipalloc-0abc12345/3/{cls}")["class"], cls)
        self.assertEqual(hostmeta.parse_slot_tag("-/-/10.20.1.58/eipalloc-0abc12346/0/free")["class"], "free")
        for bad in ("large", "", "Standard", "free ", "standard/x", "free\n"):
            with self.subTest(cls=bad):
                self.assertIsNone(hostmeta.parse_slot_tag(f"{DESK_A}/{VOL_A}/10.20.1.57/eipalloc-0abc12345/3/{bad}"))
        self.assertIsNone(hostmeta.parse_slot_tag(f"{DESK_A}/{VOL_A}"))   # 0.1.4's two fields mean nothing now

    def test_the_class_is_one_classes_conf_names(self):
        # a new class needs only classes.conf (the System Engineer's ask); standard always; no table, nothing but standard
        d = tempfile.mkdtemp(prefix="classes-")
        real = hostmeta.CLASSES_TABLE
        tag = f"{DESK_A}/{VOL_A}/10.20.1.57/eipalloc-0abc12345/3/"
        try:
            hostmeta.CLASSES_TABLE = os.path.join(d, "classes.conf")
            with open(hostmeta.CLASSES_TABLE, "w") as f:
                f.write("standard 1 1 1 1 1 1 1\nlarge 2 2 1 1 2 2 2\nBad 1 1 1 1 1 1 1\n")
            self.assertEqual(hostmeta.parse_slot_tag(tag + "large")["class"], "large")
            self.assertEqual(hostmeta.parse_slot_tag(tag + "standard")["class"], "standard")
            for bad in ("free", "Bad", "huge"):
                with self.subTest(cls=bad):
                    self.assertIsNone(hostmeta.parse_slot_tag(tag + bad))
            os.remove(hostmeta.CLASSES_TABLE)
            self.assertIsNone(hostmeta.parse_slot_tag(tag + "large"))
            self.assertEqual(hostmeta.parse_slot_tag(tag + "standard")["class"], "standard")
            self.assertEqual(hostmeta.parse_slot_tag(tag[:-1])["class"], "standard")
        finally:
            hostmeta.CLASSES_TABLE = real
            shutil.rmtree(d)

    def test_an_empty_slot_still_names_its_addresses(self):
        self.assertEqual(hostmeta.parse_slot_tag("-/-/10.20.1.58/eipalloc-0abc12346/0"),
                         {"deskId": None, "volumeId": None, "privateIp": "10.20.1.58", "allocationId": "eipalloc-0abc12346", "epoch": 0, "class": "standard"})

    def test_anything_else_means_nothing(self):
        bad = [
            None, 7, "", f"{DESK_A}/{VOL_A}", f"{DESK_A}/{VOL_A}/10.20.1.57/eipalloc-0abc12345", f"{DESK_A}/{VOL_A}/10.20.1.57/eipalloc-0abc12345/3/x",
            f"{DESK_A}/-/10.20.1.57/eipalloc-0abc12345/3", f"-/{VOL_A}/10.20.1.57/eipalloc-0abc12345/3",          # half a placement
            f"d-ABCDEFGHIJK2/{VOL_A}/10.20.1.57/eipalloc-0abc12345/3", f"d-abcdefghijk1/{VOL_A}/10.20.1.57/eipalloc-0abc12345/3",
            f"d-abcdefghijk/{VOL_A}/10.20.1.57/eipalloc-0abc12345/3", f"{DESK_A}/vol-XYZ/10.20.1.57/eipalloc-0abc12345/3",
            f"{DESK_A}/{VOL_A}/10.20.1.256/eipalloc-0abc12345/3", f"{DESK_A}/{VOL_A}/10.20.01.57/eipalloc-0abc12345/3",
            f"{DESK_A}/{VOL_A}/10.20.1/eipalloc-0abc12345/3", f"{DESK_A}/{VOL_A}/10.20.1.57/eipalloc-xyz/3",
            f"{DESK_A}/{VOL_A}/10.20.1.57/eipalloc-0abc12345/03", f"{DESK_A}/{VOL_A}/10.20.1.57/eipalloc-0abc12345/-1",
            f"{DESK_A}/{VOL_A}/10.20.1.57/eipalloc-0abc12345/1234567890", f" {DESK_A}/{VOL_A}/10.20.1.57/eipalloc-0abc12345/3",
            f"{DESK_A}/{VOL_A}/10.20.1.57/eipalloc-0abc12345/3\n", "x" * 300,
        ]
        for v in bad:
            with self.subTest(v=v):
                self.assertIsNone(hostmeta.parse_slot_tag(v))


class ReportStateTest(unittest.TestCase):
    def st(self, rec=None, status=None, op=None, root=True, held=False):
        return report.state_of(rec, status, op, "tmpl-1", root, held)

    def test_states(self):
        self.assertEqual(self.st(), "empty")
        self.assertEqual(self.st({"state": "fresh", "template": "tmpl-1"}), "prepared")
        self.assertEqual(self.st({"state": "fresh", "template": "old"}), "empty")
        self.assertEqual(self.st({"state": "desk", "deskId": DESK_A}, held=True), "stopped")
        self.assertEqual(self.st({"state": "desk", "deskId": DESK_A}), "unmounted")
        self.assertEqual(self.st({"state": "desk"}, status="running"), "running")
        self.assertEqual(self.st({"state": "desk"}, status="created"), "starting")
        self.assertEqual(self.st({"state": "fresh", "template": "tmpl-1"}, op="starting"), "starting")
        self.assertEqual(self.st({"state": "desk"}, status="running", op="stopping"), "stopping")
        self.assertEqual(self.st({"state": "desk"}, root=False), "empty")
        for s in ("empty", "prepared", "stopped", "unmounted", "running", "starting", "stopping"):
            self.assertIn(s, ("empty", "prepared", "starting", "running", "stopping", "stopped", "unmounted"))

    def test_entries(self):
        tag = hostmeta.parse_slot_tag(f"{DESK_A}/{VOL_A}/10.20.1.57/eipalloc-0abc12345/3")
        run = {"deskId": DESK_A, "epoch": 2}
        e = report.slot_entry(1, tag, True, {"state": "desk"}, "running", None, run, "t", True, True, 500, 2, None, counter_in=900)
        self.assertEqual(e, {"k": 1, "state": "running", "deskId": DESK_A, "epoch": 2, "net": {"bytesOut": 500, "bytesIn": 900}})   # what it started with
        e = report.slot_entry(1, tag, True, {"state": "desk"}, None, None, None, "t", True, False, 500, 2, "address_mismatch", counter_in=900)
        self.assertEqual(e, {"k": 1, "state": "unmounted", "deskId": DESK_A, "epoch": 3, "net": {"bytesOut": 0, "bytesIn": 0}, "fault": "address_mismatch"})
        e = report.slot_entry(2, None, False, None, None, None, None, "t", False, False, 0, None, None)
        self.assertEqual(e, {"k": 2, "state": "empty", "deskId": None, "epoch": 0, "net": {"bytesOut": 0, "bytesIn": 0}, "fault": "tag_unreadable"})

    def test_counters_read_out_and_rx_by_slot(self):
        # main's counters (desk_est): out_<k> and rx_<k> per slot; slot 1 isn't slot 10's prefix
        nft = {"nftables": [{"metainfo": {}}, {"counter": {"name": "out_1", "bytes": 11}}, {"counter": {"name": "rx_1", "bytes": 22}},
                            {"counter": {"name": "out_10", "bytes": 33}}, {"counter": {"name": "rx_2", "bytes": 44}}, {"counter": {"name": "other", "bytes": 5}}]}
        real = report.subprocess.run
        report.subprocess.run = lambda *a, **kw: types.SimpleNamespace(returncode=0, stdout=json.dumps(nft), stderr="")
        try:
            self.assertEqual(report.counters(), {1: (11, 22), 10: (33, 0), 2: (0, 44)})
        finally:
            report.subprocess.run = real

    def test_slots_and_units_from_hosting(self):
        d = tempfile.mkdtemp(prefix="hosting-")
        real = hostmeta.HOSTING
        try:
            hostmeta.HOSTING = os.path.join(d, "hosting.json")

            def put(h):
                with open(hostmeta.HOSTING, "w") as f:
                    json.dump(h, f)
            put({"desksPerHost": 6, "slotsPerHost": 9})
            self.assertEqual((hostmeta.desks_per_host(), hostmeta.slots_per_host()), (6, 9))
            put({"desksPerHost": 6})   # a host from before SlotsPerHost
            self.assertEqual((hostmeta.desks_per_host(), hostmeta.slots_per_host()), (6, 6))
            put({"desksPerHost": 6, "slotsPerHost": 30})
            self.assertRaises(ValueError, hostmeta.slots_per_host)
        finally:
            hostmeta.HOSTING = real
            shutil.rmtree(d)


class SlotNetTest(unittest.TestCase):
    """slotnet.py resolve: the tag, the address on whichever interface carries it, IMDS's association, the slot's gateway."""

    class Imds:
        def __init__(self, tags, assoc):
            self.tags, self.assoc = tags, assoc

        def get(self, p):
            m = {"meta-data/network/interfaces/macs/": "0a:00:00:00:00:01/\n0a:00:00:00:00:02/",
                 "meta-data/network/interfaces/macs/0a:00:00:00:00:01/local-ipv4s": "10.20.1.10",
                 "meta-data/network/interfaces/macs/0a:00:00:00:00:02/local-ipv4s": "10.20.1.57\n10.20.1.58",
                 "meta-data/network/interfaces/macs/0a:00:00:00:00:01/subnet-ipv4-cidr-block": "10.20.0.0/20",
                 "meta-data/network/interfaces/macs/0a:00:00:00:00:02/subnet-ipv4-cidr-block": "10.20.0.0/20"}
            if p.startswith("meta-data/tags/instance/DeskSlot"):
                return self.tags.get(p[-1])
            if "/ipv4-associations/" in p:
                mac, pub = p.split("/")[4], p.split("/")[-1]
                return self.assoc.get((mac, pub))
            return m.get(p)

    def setUp(self):
        spec = importlib.util.spec_from_file_location("slotnet", os.path.join(LIB, "slotnet.py"))
        self.sn = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.sn)
        self.added = []
        links = [{"ifname": "ens5", "address": "0a:00:00:00:00:01"}, {"ifname": "ens6", "address": "0a:00:00:00:00:02"}]
        addrs = {"ens5": ["10.20.1.10"], "ens6": ["10.20.1.57"]}
        def ip_json(*a):
            if a[:2] == ("link", "show"):
                return links
            if a[:3] == ("-4", "route", "show"):
                return [{"dst": "default", "dev": "ens6", "metric": 200}, {"dst": "default", "dev": "ens5", "metric": 100}]
            if a[:3] == ("-4", "addr", "show"):
                only = a[4] if len(a) > 4 else None
                return [{"ifname": n, "addr_info": [{"family": "inet", "local": x, "prefixlen": 20} for x in v]} for n, v in addrs.items() if only in (None, n)]
            raise AssertionError(a)
        self.sn.ip_json = ip_json
        self.sn.subprocess = type("S", (), {"run": staticmethod(lambda cmd, **kw: (self.added.append(cmd), addrs["ens6"].append(cmd[3].split("/")[0]) if cmd[1] == "addr" else None))})
        self.tag1 = f"{DESK_A}/{VOL_A}/10.20.1.57/eipalloc-0abc12345/3"
        self.tag2 = f"{DESK_B}/{VOL_B}/10.20.1.58/eipalloc-0abc12346/5/free"
        self.imds = self.Imds({"1": self.tag1, "2": self.tag2}, {("0a:00:00:00:00:02", "198.51.100.7"): "10.20.1.57", ("0a:00:00:00:00:02", "198.51.100.8"): "10.20.1.58",
                                                                ("0a:00:00:00:00:01", "198.51.100.1"): "10.20.1.10"})

    def resolve(self, *a, imds=None):
        return self.sn.resolve(*a, imds or self.imds)

    def test_a_slot_on_the_slots_interface_gets_its_own_gateway(self):
        self.assertEqual(self.resolve(1, DESK_A, "-", "198.51.100.7", "slot-ip"), f"3 {VOL_A} 10.20.1.57 ens6 10.20.0.1 0a:00:00:00:00:02 standard")
        self.assertEqual(self.added, [])

    def test_an_address_the_os_lacks_is_added_to_the_interface_imds_gives_it_to(self):
        self.assertEqual(self.resolve(2, DESK_B, VOL_B, "198.51.100.8", "slot-ip"), f"5 {VOL_B} 10.20.1.58 ens6 10.20.0.1 0a:00:00:00:00:02 free")
        self.assertEqual(self.added[0], ["ip", "addr", "add", "10.20.1.58/20", "dev", "ens6"])

    def test_refusals(self):
        cases = [((1, DESK_B, "-", "198.51.100.7", "slot-ip"), "tag_mismatch"), ((1, DESK_A, VOL_B, "198.51.100.7", "slot-ip"), "tag_mismatch"),
                 ((1, DESK_A, "-", "198.51.100.8", "slot-ip"), "address_mismatch"), ((1, DESK_A, "-", "-", "slot-ip"), "address_mismatch"),
                 ((3, DESK_A, "-", "198.51.100.7", "slot-ip"), "tag_unreadable")]
        for args, code in cases:
            with self.subTest(args=args), self.assertRaises(self.sn.Fault) as f:
                self.resolve(*args)
            self.assertEqual(f.exception.code, code)
        imds = self.Imds({"1": f"{DESK_A}/{VOL_A}/10.20.9.9/eipalloc-0abc12345/3"}, {})
        with self.assertRaises(self.sn.Fault) as f:
            self.resolve(1, DESK_A, "-", "198.51.100.7", "slot-ip", imds=imds)
        self.assertEqual(f.exception.code, "address_absent")
        imds = self.Imds({"1": f"{DESK_A}/{VOL_A}/10.20.1.57/eipalloc-0abc12345/3".replace("/3", "/03")}, {})
        with self.assertRaises(self.sn.Fault) as f:
            self.resolve(1, DESK_A, "-", "198.51.100.7", "slot-ip", imds=imds)
        self.assertEqual(f.exception.code, "tag_unreadable")

    def test_address_plus_port_uses_the_hosts_own_address(self):
        self.assertEqual(self.resolve(1, DESK_A, "-", "198.51.100.1", "port"), f"3 {VOL_A} 10.20.1.10 ens5 - 0a:00:00:00:00:01 standard")
        with self.assertRaises(self.sn.Fault):
            self.resolve(1, DESK_A, "-", "198.51.100.7", "port")


class FakeImds:
    """The host's IMDS as the link reads it: instance ID, region, Env, the slot tags (from the fake host's file) and a role."""

    def __init__(self, hostfile):
        self.hostfile = hostfile
        self.role = True
        imds = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def send(self, code, body=b""):
                self.send_response(code)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_PUT(self):
                self.send(200, b"imds-token")

            def do_GET(self):
                if self.headers.get("X-aws-ec2-metadata-token") != "imds-token":
                    return self.send(401)
                p = self.path.replace("/latest/meta-data/", "")
                tags = json.load(open(imds.hostfile)).get("tags", {})
                exp = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
                v = {"instance-id": HOST, "placement/region": "us-east-1", "tags/instance/Env": "staging"}.get(p)
                if p.startswith("tags/instance/DeskSlot"):
                    v = tags.get(p[len("tags/instance/DeskSlot"):])
                if p == "iam/security-credentials/" and imds.role:
                    v = "ma-staging-shared-host"
                if p == "iam/security-credentials/ma-staging-shared-host" and imds.role:
                    v = json.dumps({"Code": "Success", "AccessKeyId": "ASIAHOSTROLE", "SecretAccessKey": "host-role-secret", "Token": "host-role-token", "Expiration": exp})
                self.send(200, v.encode()) if v is not None else self.send(404)

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.srv.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()


class LinkTest(unittest.TestCase):
    """The link, in-process, against fakes on the loopback."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="link-test-")
        t = lambda *p: os.path.join(self.tmp, *p)  # noqa: E731
        self.hostfile, self.statefile, self.reqlog = t("host.json"), t("platform.json"), t("requests.jsonl")
        self.tag_a = f"{DESK_A}/{VOL_A}/10.20.1.57/eipalloc-0abc12345/1"
        self.write_host({"desksPerHost": 2, "tags": {"1": self.tag_a, "2": "-/-/10.20.1.58/eipalloc-0abc12346/4"},
                         "slots": {"1": {"state": "prepared", "deskId": DESK_A, "epoch": 1},
                                   "2": {"state": "prepared", "deskId": None, "epoch": 4}}})
        self.write_platform({"hostId": HOST, "env": "staging", "desksPerHost": 2, "reportSeconds": 1, "refreshAfterSeconds": 600, "slots": {
            "1": {"deskId": DESK_A, "volumeId": VOL_A, "privateIp": "10.20.1.57", "allocationId": "eipalloc-0abc12345", "publicIp": "198.51.100.7",
                  "epoch": 1, "want": "running", "userId": "member-sub-a", "deskKind": "test"},
            "2": {"deskId": None, "volumeId": None, "privateIp": "10.20.1.58", "allocationId": "eipalloc-0abc12346", "publicIp": "198.51.100.8",
                  "epoch": 4, "want": "stopped"}}})
        open(t("boot_id"), "w").write("11111111-2222-3333-4444-555555555555\n")
        json.dump({"desksPerHost": 2, "hostingVersion": "2", "from": "tags"}, open(t("hosting.json"), "w"))
        self.port = free_port()
        self.standin_port = free_port()
        open(t("desk-host.conf"), "w").write(f"LINK_API=http://127.0.0.1:{self.port}\nSTANDIN_PORT={self.standin_port}\nLINK_PREPARE_EMPTY=0\n")
        self.fake = subprocess.Popen([sys.executable, "-I", os.path.join(HERE, "fake_platform.py"), "--port", str(self.port), "--state", self.statefile,
                                      "--log", self.reqlog, "--key", "ASIAHOSTROLE:host-role-secret"], stdout=subprocess.DEVNULL, env={**os.environ, "DESK_HOST_LIB": LIB})
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", self.port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.05)
        self.imds = FakeImds(self.hostfile)
        os.environ.update({
            "DESK_HOST_IMDS": self.imds.url, "DESK_HOST_HOSTING": t("hosting.json"), "DESK_HOST_LINK_CONF": t("desk-host.conf"),
            "DESK_HOST_LINK_RUN": t("run", "link"), "DESK_HOST_LINK_LOGDIR": t("log"), "DESK_HOST_LINK_BOOT_ID": t("boot_id"),
            "DESK_HOST_LINK_CMD": f"{sys.executable} -I {os.path.join(HERE, 'fake_desk_host.py')} {self.hostfile}",
            "DESK_HOST_LINK_SLOT_NET": "127.0.{k}", "DESK_HOST_LINK_POLL": "0.2", "DESK_HOST_LINK_BACKOFF_MIN": "0.1",
            "DESK_HOST_LINK_BACKOFF_MAX": "0.8", "DESK_HOST_LINK_ORDER_RETRY": "0.3", "DESK_HOST_LINK_REFRESH_MIN": "0.5",
            "DESK_HOST_LINK_REPORT_MIN": "1"})
        loader = importlib.machinery.SourceFileLoader("desk_host_link", os.path.join(LIB, "desk-host-link"))
        sp = importlib.util.spec_from_loader("desk_host_link", loader)
        self.mod = importlib.util.module_from_spec(sp)
        loader.exec_module(self.mod)
        importlib.reload(hostmeta)
        self.mod.hostmeta = hostmeta
        self.logged = []
        self.mod.log = lambda m: self.logged.append(m)
        self.link = None
        self.stopping = False

    def tearDown(self):
        self.stopping = True
        if self.link:
            self.link.wake.set()
            self.thread.join(5)
            for k in list(self.link.standins):
                self.link.drop_standin(k)
        self.fake.terminate()
        self.fake.wait(5)
        self.imds.srv.shutdown()
        self.imds.srv.server_close()
        subprocess.run(["rm", "-rf", self.tmp])

    # ---------- helpers ----------

    def write_host(self, h):
        json.dump(h, open(self.hostfile, "w"))

    def host(self):
        return json.load(open(self.hostfile))

    def edit_host(self, f):
        h = self.host()
        f(h)
        self.write_host(h)

    def write_platform(self, s):
        json.dump(s, open(self.statefile, "w"))

    def edit_platform(self, f):
        s = json.load(open(self.statefile))
        f(s)
        self.write_platform(s)

    def requests(self, route=None):
        try:
            rows = [json.loads(line) for line in open(self.reqlog)]
        except FileNotFoundError:
            return []
        return [r for r in rows if route is None or r["route"] == route]

    def calls(self, cmd=None):
        return [c for c in self.host().get("calls", []) if cmd is None or c[0] == cmd]

    def start(self):
        self.link = self.mod.Link()
        self.thread = threading.Thread(target=self.link.run, kwargs={"until": lambda: self.stopping}, daemon=True)
        self.thread.start()

    def until(self, f, timeout=10, what="condition"):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if f():
                return
            time.sleep(0.05)
        self.fail(f"timed out waiting for {what}; log: {self.logged[-8:]}")

    def standin(self, k, path, token=True, src=None, method="GET"):
        """(status, body) from slot k's stand-in, as a desk at 127.0.<k>.2 (or src) would ask."""
        def req(m, p, hdrs):
            s = socket.create_connection((f"127.0.{k}.1", self.standin_port), timeout=2, source_address=(src or f"127.0.{k}.2", 0))
            try:
                s.sendall(f"{m} {p} HTTP/1.0\r\n{''.join(f'{a}: {b}' + chr(13) + chr(10) for a, b in hdrs.items())}\r\n".encode())
                data = b""
                while True:
                    c = s.recv(65536)
                    if not c:
                        break
                    data += c
            finally:
                s.close()
            if not data:
                return None, b""
            head, _, body = data.partition(b"\r\n\r\n")
            return int(head.split()[1]), body
        hdrs = {}
        if token:
            st, tok = req("PUT", "/latest/api/token", {"X-aws-ec2-metadata-token-ttl-seconds": "60"})
            if st != 200:
                return st, tok
            hdrs["X-aws-ec2-metadata-token"] = tok.decode()
        return req(method, path, hdrs)

    # ---------- the tests ----------

    def test_hello_report_and_a_start_run_once(self):
        self.start()
        self.until(lambda: self.calls("up"), what="desk-host up")
        hello = self.requests("/v1/host/hello")[0]
        self.assertEqual(hello["status"], 200)
        self.assertEqual(hello["body"], {"instanceId": HOST, "bootId": "11111111-2222-3333-4444-555555555555", "desksPerHost": 2, "hostingVersion": 2})
        self.assertEqual(hello["token"], "host-role-token")   # signed with the instance role's credentials, every call checked by the fake
        self.assertEqual(self.calls("up"), [["up", "1", DESK_A, "--class", "standard", "--public", "198.51.100.7"]])
        sess = self.requests("/v1/host/slot-session")
        self.assertEqual(sess[0]["body"], {"slot": 1, "epoch": 1})
        self.until(lambda: any(r["body"].get("slots", [{}])[0].get("state") == "running" for r in self.requests("/v1/host/report")), what="a running report")
        time.sleep(1)
        self.assertEqual(len(self.calls("up")), 1)
        seqs = [r["body"]["seq"] for r in self.requests("/v1/host/report")]
        self.assertEqual(seqs, sorted(seqs))
        self.assertTrue(all(r["status"] == 200 for r in self.requests()))
        rep = self.requests("/v1/host/report")[-1]["body"]
        self.assertEqual(rep["conntrack"], {"count": 10, "max": 65536})
        self.assertEqual(rep["slots"][0], {"k": 1, "state": "running", "deskId": DESK_A, "epoch": 1, "net": {"bytesOut": 0}})

    def test_the_stand_in_serves_its_slot_only(self):
        self.edit_host(lambda h: h["tags"].update({"2": f"{DESK_B}/{VOL_B}/10.20.1.58/eipalloc-0abc12346/4/free"}) or h["slots"].update({"2": {"state": "prepared", "deskId": DESK_B, "epoch": 4}}))
        self.edit_platform(lambda s: s["slots"]["2"].update({"deskId": DESK_B, "volumeId": VOL_B, "want": "running", "userId": "member-sub-b", "deskKind": "personal"}))
        self.start()
        self.until(lambda: len(self.calls("up")) == 2, what="both slots up")
        self.assertIn(["up", "2", DESK_B, "--class", "free", "--public", "198.51.100.8"], self.calls("up"))   # the tag's class, passed through
        self.until(lambda: self.standin(1, "/latest/meta-data/instance-id")[0] == 200, what="slot 1's stand-in")
        self.assertEqual(self.standin(1, "/latest/meta-data/instance-id"), (200, DESK_A.encode()))
        self.assertEqual(self.standin(2, "/latest/meta-data/instance-id"), (200, DESK_B.encode()))
        self.assertEqual(self.standin(1, "/latest/meta-data/placement/region"), (200, b"us-east-1"))
        self.assertEqual(self.standin(1, "/latest/meta-data/public-ipv4"), (200, b"198.51.100.7"))
        self.assertEqual(self.standin(1, "/latest/meta-data/tags/instance/UserId"), (200, b"member-sub-a"))
        self.assertEqual(self.standin(1, "/latest/meta-data/tags/instance/DeskKind"), (200, b"test"))
        self.assertEqual(self.standin(1, "/latest/meta-data/tags/instance/Env"), (200, b"staging"))
        self.assertEqual(self.standin(1, "/latest/meta-data/tags/instance"), (200, b"DeskId\nDeskKind\nEnv\nUserId"))
        role = self.standin(1, "/latest/meta-data/iam/security-credentials/")
        self.assertEqual(role, (200, b"ma-shared-desk"))
        st, body = self.standin(1, "/latest/meta-data/iam/security-credentials/ma-shared-desk")
        c = json.loads(body)
        self.assertEqual((st, c["Code"], c["AccessKeyId"], c["Token"]), (200, "Success", "ASIAFAKESLOT1E1", "fake-token-slot-1-1"))
        self.assertEqual(json.loads(self.standin(2, "/latest/meta-data/iam/security-credentials/ma-shared-desk")[1])["AccessKeyId"], "ASIAFAKESLOT2E4")
        for p in ("/latest/meta-data/local-ipv4", "/latest/meta-data/mac", "/latest/meta-data/iam/info", "/latest/meta-data/ami-id",
                  "/latest/dynamic/instance-identity/document", "/latest/user-data", "/latest/meta-data/tags/instance/DeskSlot1",
                  "/latest/meta-data/network/interfaces/macs/", "/latest/meta-data/iam/security-credentials/ma-staging-shared-host"):
            with self.subTest(path=p):
                self.assertEqual(self.standin(1, p)[0], 404)
        self.assertEqual(self.standin(1, "/latest/meta-data/instance-id", token=False)[0], 401)          # IMDSv2 only
        self.assertEqual(self.standin(1, "/latest/meta-data/instance-id", method="POST")[0], 405)
        # another slot's address, or the host's own, gets nothing from slot 1's listener (connection closed unanswered)
        self.assertEqual(self.standin(1, "/latest/meta-data/instance-id", src="127.0.2.2")[0], None)
        self.assertEqual(self.standin(1, "/latest/meta-data/instance-id", src="127.0.0.1")[0], None)
        # a token from one slot doesn't work on another's
        st, tok = 0, b""
        s = socket.create_connection(("127.0.1.1", self.standin_port), source_address=("127.0.1.2", 0))
        s.sendall(b"PUT /latest/api/token HTTP/1.0\r\nX-aws-ec2-metadata-token-ttl-seconds: 60\r\n\r\n")
        tok = s.makefile("rb").read().partition(b"\r\n\r\n")[2]
        s.close()
        s = socket.create_connection(("127.0.2.1", self.standin_port), source_address=("127.0.2.2", 0))
        s.sendall(b"GET /latest/meta-data/instance-id HTTP/1.0\r\nX-aws-ec2-metadata-token: " + tok + b"\r\n\r\n")
        self.assertIn(b" 401 ", s.makefile("rb").readline())
        s.close()
        self.assertEqual(self.standin(1, "/latest/api/token", token=False, method="PUT")[0], 400)   # no TTL

    def test_a_stop_order_stops_the_slot_and_its_stand_in(self):
        self.start()
        self.until(lambda: self.calls("up"), what="up")
        self.until(lambda: self.standin(1, "/latest/meta-data/instance-id")[0] == 200, what="stand-in")
        self.edit_platform(lambda s: s["slots"]["1"].update({"want": "stopped"}))
        self.link.wake.set()
        self.edit_host(lambda h: h["slots"]["1"].update({"bytesOut": 7}))   # any change reports at once
        self.until(lambda: self.calls("stop"), what="desk-host stop")
        self.assertEqual(self.calls("stop"), [["stop", "1"]])
        self.until(lambda: 1 not in self.link.standins, what="stand-in dropped")
        with self.assertRaises(OSError):
            self.standin(1, "/latest/meta-data/instance-id")

    def test_a_failed_start_is_tried_again_and_a_done_one_never(self):
        self.edit_host(lambda h: h.update({"fail": {"up": 1}}))
        self.start()
        self.until(lambda: len(self.calls("up")) == 2, what="the retry")
        self.until(lambda: self.host()["slots"]["1"]["state"] == "running", what="running")
        time.sleep(1)
        self.assertEqual(len(self.calls("up")), 2)
        # a host that never shows the start done gets the same order again from Platform, and runs it once
        self.stopping = True
        self.thread.join(5)
        for k in list(self.link.standins):
            self.link.drop_standin(k)
        self.edit_host(lambda h: h.update({"stuck": ["up"], "calls": [], "slots": {"1": {"state": "prepared", "deskId": DESK_A, "epoch": 1}, "2": h["slots"]["2"]}}))
        self.stopping = False
        self.start()
        self.until(lambda: self.calls("up"), what="up")
        for _ in range(3):
            self.edit_host(lambda h: h["slots"]["1"].update({"bytesOut": h["slots"]["1"].get("bytesOut", 0) + 1}))
            time.sleep(0.5)
        self.assertGreater(len([r for r in self.requests("/v1/host/report") if r["reply"] and r["reply"]["orders"]]), 3)
        self.assertEqual(len(self.calls("up")), 1)

    def test_a_wake_after_a_stop_at_the_same_epoch_runs_the_same_start_id_again(self):
        self.start()
        self.until(lambda: self.calls("up"), what="the first start")
        self.edit_platform(lambda s: s["slots"]["1"].update({"want": "stopped"}))
        self.until(lambda: self.calls("stop"), what="the stop")
        self.edit_platform(lambda s: s["slots"]["1"].update({"want": "running"}))
        self.until(lambda: len(self.calls("up")) == 2, what="the wake")
        self.assertEqual([c[0] for c in self.calls()], ["up", "stop", "up"])

    def test_a_start_the_tag_doesnt_name_is_refused(self):
        self.edit_host(lambda h: h["tags"].update({"1": f"{DESK_B}/{VOL_A}/10.20.1.57/eipalloc-0abc12345/1"}))
        self.edit_platform(lambda s: s.update({"extraOrders": [{"id": "start_slot:1:1", "op": "start_slot", "k": 1, "deskId": DESK_A, "epoch": 1}]}))
        self.start()
        self.until(lambda: len(self.requests("/v1/host/report")) >= 3, what="reports")
        self.assertEqual(self.calls("up"), [])
        self.assertEqual(self.requests("/v1/host/slot-session"), [])

    def test_a_start_whose_addresses_arent_the_hellos_is_refused(self):
        self.edit_host(lambda h: h["tags"].update({"1": f"{DESK_A}/{VOL_A}/10.20.1.99/eipalloc-0abc12345/1"}))
        self.edit_host(lambda h: h["slots"].update({"1": {"state": "prepared", "deskId": DESK_A, "epoch": 1}}))
        self.start()
        self.until(lambda: len(self.requests("/v1/host/report")) >= 3, what="reports")
        self.assertEqual(self.calls("up"), [])
        self.assertEqual(open(os.path.join(self.tmp, "run", "fault", "1")).read().strip(), "address_mismatch")

    def test_a_session_for_another_public_address_is_refused(self):
        self.edit_platform(lambda s: s["slots"]["1"].update({"sessionPublicIp": "203.0.113.9"}))
        self.start()
        self.until(lambda: len(self.requests("/v1/host/slot-session")) >= 2, what="sessions")
        self.assertEqual(self.calls("up"), [])
        self.assertNotIn(1, self.link.standins)

    def test_bad_orders_are_ignored(self):
        self.edit_platform(lambda s: (s["slots"]["1"].update({"want": "stopped"}), s.update({"extraOrders": [
            {"id": "start_slot:3:1", "op": "start_slot", "k": 3, "deskId": DESK_A, "epoch": 1},           # past DesksPerHost
            {"id": "start_slot:1:2", "op": "start_slot", "k": 1, "deskId": DESK_A, "epoch": 1},           # id isn't op:k:epoch
            {"id": "start_slot:1:1", "op": "start_slot", "k": 1, "deskId": "d-NOTADESK", "epoch": 1},
            {"id": "start_slot:True:1", "op": "start_slot", "k": True, "deskId": DESK_A, "epoch": 1},
            {"id": "format_slot:1:1", "op": "format_slot", "k": 1, "epoch": 1},
            {"id": "stop_slot:1:1", "op": "stop_slot", "k": 1, "epoch": 1}, "start_slot:1:1", None]})))
        self.start()
        self.until(lambda: len(self.requests("/v1/host/report")) >= 3, what="reports")
        self.assertEqual(self.calls(), [])

    def test_prepare_runs_only_for_an_empty_slot_at_its_epoch(self):
        self.edit_host(lambda h: h["slots"].update({"2": {"state": "unmounted", "deskId": None, "epoch": 4}}))
        self.start()
        self.until(lambda: self.calls("prepare"), what="prepare")
        time.sleep(0.8)
        self.assertEqual(self.calls("prepare"), [["prepare", "2"]])
        # an order to prepare a slot whose tag names a desk is refused
        self.edit_platform(lambda s: s.update({"extraOrders": [{"id": "prepare_slot:1:1", "op": "prepare_slot", "k": 1, "epoch": 1}]}))
        self.link.wake.set()
        self.until(lambda: len(self.requests("/v1/host/report")) >= 6, what="reports")
        self.assertEqual(self.calls("prepare"), [["prepare", "2"]])

    def test_hello_required_sends_hello_again(self):
        self.start()
        self.until(lambda: self.requests("/v1/host/report"), what="a report")
        self.edit_platform(lambda s: s.update({"forgetHello": True}))
        self.edit_host(lambda h: h["slots"]["2"].update({"bytesOut": 1}))
        self.until(lambda: any(r["reply"] and "hello_required" in r["reply"].get("actions", []) for r in self.requests("/v1/host/report")), what="hello_required")
        self.edit_platform(lambda s: s.pop("forgetHello"))
        self.until(lambda: len(self.requests("/v1/host/hello")) >= 2, what="a second hello")

    def test_errors_back_off(self):
        self.edit_platform(lambda s: s.update({"helloStatus": 500}))
        self.start()
        self.until(lambda: len(self.requests("/v1/host/hello")) >= 4, timeout=15, what="hello retries")
        self.edit_platform(lambda s: s.pop("helloStatus"))
        self.until(lambda: self.requests("/v1/host/report"), timeout=15, what="a report after the retries")
        self.assertTrue(any("next try in" in m for m in self.logged))

    def test_sessions_refresh_and_a_revoked_one_stops_being_served(self):
        self.edit_platform(lambda s: s.update({"refreshAfterSeconds": 1}))
        self.start()
        self.until(lambda: len(self.requests("/v1/host/slot-session")) >= 3, what="refreshes")
        self.assertEqual(self.standin(1, "/latest/meta-data/instance-id"), (200, DESK_A.encode()))
        self.edit_platform(lambda s: s.update({"sessionStatus": {"1": 409}}))
        self.until(lambda: 1 not in self.link.standins, what="the stand-in dropped")
        with self.assertRaises(OSError):
            self.standin(1, "/latest/meta-data/instance-id")

    def test_a_restarted_link_serves_a_running_slot_again(self):
        self.edit_host(lambda h: h["slots"].update({"1": {"state": "running", "deskId": DESK_A, "epoch": 1}}))
        self.start()
        self.until(lambda: self.standin(1, "/latest/meta-data/instance-id")[0] == 200 if 1 in self.link.standins else False, what="the stand-in")
        self.assertEqual(self.calls("up"), [])

    def test_slots_with_no_root_are_prepared_after_the_first_hello(self):
        conf = os.environ["DESK_HOST_LINK_CONF"]
        text = open(conf).read()
        open(conf, "w").write(text.replace("LINK_PREPARE_EMPTY=0", "LINK_PREPARE_EMPTY=1"))
        self.edit_host(lambda h: h.update({"slots": {"1": {"state": "empty", "deskId": DESK_A, "epoch": 1}, "2": {"state": "empty", "deskId": None, "epoch": 4}}}))
        self.edit_platform(lambda s: s["slots"]["1"].update({"want": "stopped"}))
        self.start()
        self.until(lambda: len(self.calls("prepare")) == 2, what="both prepared")
        time.sleep(0.8)
        self.assertEqual(sorted(self.calls("prepare")), [["prepare", "1"], ["prepare", "2"]])

    def test_the_api_may_only_be_the_envs_or_a_loopback_fake(self):
        conf = os.environ["DESK_HOST_LINK_CONF"]
        for bad in ("https://api.example.com", "http://10.0.0.5:8080", "http://127.0.0.1", "http://127.0.0.1:80/x"):
            open(conf, "w").write(f"LINK_API={bad}\n")
            with self.subTest(api=bad), self.assertRaises(SystemExit):
                self.mod.Link()
        open(conf, "w").write("LINK_API_staging=https://host-api.staging.minimalistalliance.com\n")
        self.assertEqual(self.mod.Link().api.base, "https://host-api.staging.minimalistalliance.com")
        open(conf, "w").write("LINK_API_prod=https://host-api.minimalistalliance.com\n")
        with self.assertRaises(SystemExit):   # this instance's Env is staging, and staging's URL isn't set
            self.mod.Link()

    def test_with_no_role_only_a_loopback_fake_is_signed_with_the_test_key(self):
        self.imds.role = False
        self.start()
        self.until(lambda: self.requests("/v1/host/report"), what="a report")
        self.assertIsNone(self.requests("/v1/host/hello")[0]["token"])
        conf = os.environ["DESK_HOST_LINK_CONF"]
        open(conf, "w").write("LINK_API_staging=https://host-api.staging.minimalistalliance.com\n")
        with self.assertRaises(self.mod.ApiError):
            self.mod.Link().api.creds.get()

    def test_nothing_about_a_member_is_logged(self):
        self.start()
        self.until(lambda: self.calls("up") and self.requests("/v1/host/slot-session"), what="a start")
        time.sleep(0.5)
        text = "\n".join(self.logged)
        for secret in (DESK_A, "member-sub-a", "fake-secret", "fake-token", "ASIAFAKE", "host-role-secret", "host-role-token", "198.51.100.7"):
            self.assertNotIn(secret, text)
        self.assertIn("slot 1: start_slot epoch 1: up in", text)


if __name__ == "__main__":
    unittest.main(verbosity=1)
