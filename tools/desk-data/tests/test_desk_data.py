"""Tests for desk-data. Run: python3 -I -m unittest discover -s tools/desk-data/tests -v

Each test builds a small /data in a temporary directory and talks to the helper over socket.socketpair(), with the
allowed uid set to the test's own. Nothing here needs root, and nothing touches the real /data.
"""
import csv
import datetime
import fcntl
import hashlib
import importlib.machinery
import importlib.util
import io
import json
import os
import socket
import sqlite3
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PROGRAM = os.path.join(os.path.dirname(HERE), "desk-data")


def load():
    sys.dont_write_bytecode = True   # no __pycache__ beside the installed program's source
    loader = importlib.machinery.SourceFileLoader("desk_data", PROGRAM)
    spec = importlib.util.spec_from_loader("desk_data", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


dd = load()
UID = os.getuid()
if not os.environ.get("DESK_DATA_TEST_LOG"):
    dd.log = lambda msg: None   # the helper's journal lines; set DESK_DATA_TEST_LOG=1 to see them


def webkit(dt):
    return int((dt - datetime.datetime(1601, 1, 1, tzinfo=datetime.timezone.utc)).total_seconds() * 1_000_000)


def recv_all(sock, timeout=20):
    sock.settimeout(timeout)
    out = bytearray()
    while True:
        b = sock.recv(1 << 20)
        if not b:
            return bytes(out)
        out += b


class Reply:
    def __init__(self, raw):
        self.raw = raw
        line, _, rest = raw.partition(b"\n")
        self.header = json.loads(line) if line else None
        self.chunks, self.body, self.digest, self.count, self.complete = [], b"", None, None, False
        if self.header and self.header.get("ok") and "size" in self.header:
            pos = 0
            while pos + 4 <= len(rest):
                (n,) = struct.unpack(">I", rest[pos:pos + 4])
                pos += 4
                if n == 0:
                    if len(rest) - pos == 40:
                        self.digest, (self.count,) = rest[pos:pos + 32], struct.unpack(">Q", rest[pos + 32:pos + 40])
                        self.complete = True
                    break
                self.chunks.append(n)
                self.body += rest[pos:pos + n]
                pos += n

    @property
    def code(self):
        return None if self.header is None or self.header.get("ok") else self.header.get("code")


class Base(unittest.TestCase):
    opts = {}

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="desk-data-test-")
        self.root = self._tmp.name
        self.writers = []

    def tearDown(self):
        for w in self.writers:
            try:
                w.close()
            except Exception:
                pass
        for dirpath, dirnames, _ in os.walk(self.root):
            for d in dirnames:
                p = os.path.join(dirpath, d)
                try:
                    if not os.path.islink(p):
                        os.chmod(p, 0o755)
                except OSError:
                    pass   # past PATH_MAX: never made read-only, and rmtree works by fd
        self._tmp.cleanup()

    # ---- fixture helpers

    def p(self, *parts):
        return os.path.join(self.root, *parts)

    def write(self, rel, data=b"x", mode=0o644):
        path = self.p(rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data if isinstance(data, bytes) else data.encode())
        os.chmod(path, mode)
        return path

    def mkdir(self, rel):
        os.makedirs(self.p(rel), exist_ok=True)
        return self.p(rel)

    def make_db(self, rel, rows=10, wal=False):
        path = self.p(rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        db = sqlite3.connect(path, isolation_level=None)
        if wal:
            db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)")
        for i in range(rows):
            db.execute("INSERT INTO t(v) VALUES (?)", (f"row {i}",))
        db.close()
        return path

    # ---- talking to the helper

    def helper(self, **kw):
        opts = dict(allowed_uid=UID, free_floor=0, busy_s=3, online_s=0.5, quiet_ms=50, settle_ms=20,
                    idle_timeout_s=5, stall_timeout_s=5)
        opts.update(self.opts)
        opts.update(kw)
        return dd.Helper(self.root, **opts)

    def raw(self, request, helper=None, shut_write=False):
        a, b = socket.socketpair()
        h = helper or self.helper()
        t = threading.Thread(target=h.serve, args=(b,), daemon=True)
        t.start()
        try:
            if request:
                try:
                    a.sendall(request)
                except BrokenPipeError:
                    pass   # refused before the request was read (denied)
            if shut_write:
                a.shutdown(socket.SHUT_WR)
            data = recv_all(a)
        finally:
            t.join(20)
            a.close()
            b.close()
        self.assertFalse(t.is_alive(), "the helper never finished")
        return Reply(data)

    def call(self, helper=None, **req):
        req = {"v": 1, **req}
        return self.raw(json.dumps(req).encode() + b"\n", helper)

    def manifest(self, part, cursor=None, limit=2000):
        r = self.call(op="manifest", part=part, cursor=cursor, limit=limit)
        self.assertTrue(r.header["ok"], r.header)
        return r.header

    def all_paths(self, part, limit=2000):
        out, cursor = [], None
        while True:
            h = self.manifest(part, cursor, limit)
            out += [e["path"] for e in h["entries"]]
            cursor = h["next"]
            if cursor is None:
                return out

    def read(self, part, path, offset=0, helper=None):
        return self.call(helper, op="read", part=part, path=path, offset=offset)

    def read_ok(self, part, path, offset=0):
        r = self.read(part, path, offset)
        self.assertTrue(r.header and r.header.get("ok"), r.header)
        self.assertTrue(r.complete, "no trailer")
        return r

    def received_db(self, r):
        path = os.path.join(self.root, "received.db")
        for s in ("", "-wal", "-shm", "-journal"):
            if os.path.exists(path + s):
                os.unlink(path + s)
        with open(path, "wb") as f:
            f.write(r.body)
        return sqlite3.connect(path)


def build_desk(t):
    """A desk's /data with every kind of thing decision 4 talks about."""
    t.write("browser/profile/Local State", b"{}")
    t.write("browser/profile/Last Version", b"156.0.8078.79")
    t.write("browser/profile/SingletonLock", b"")
    t.write("browser/profile/SingletonCookie", b"")
    os.symlink("hostname-1234", t.p("browser/profile/SingletonSocket"))
    t.write("browser/profile/Crashpad/settings.dat", b"c" * 10)
    t.write("browser/profile/component_crx_cache/x", b"c")
    t.write("browser/profile/GrShaderCache/data_0", b"c")
    t.write("browser/profile/ShaderCache/data_0", b"c")
    t.write("browser/profile/GraphiteDawnCache/data_0", b"c")
    t.write("browser/profile/Default/Preferences", b'{"a":1}')
    t.write("browser/profile/Default/Cache/Cache_Data/data_0", b"c" * 100)
    t.write("browser/profile/Default/Code Cache/js/index", b"c")
    t.write("browser/profile/Default/GPUCache/data_0", b"c")
    t.write("browser/profile/Default/DawnCache/data_0", b"c")
    t.write("browser/profile/Default/DawnGraphiteCache/data_0", b"c")
    t.write("browser/profile/Default/DawnWebGPUCache/data_0", b"c")
    t.write("browser/profile/Default/Local Storage/leveldb/000003.log", b"ls")
    t.write("browser/profile/Default/IndexedDB/https_x_0.indexeddb.leveldb/LOCK", b"")
    t.write("browser/profile/Default/Service Worker/Database/CURRENT", b"sw")
    t.write("browser/profile/Default/Sessions/Session_1", b"s" * 20)
    t.write("browser/profile/Default/Login Data", b"not really")
    t.make_db("browser/profile/Default/Network/Cookies", rows=5)
    t.write("browser/profile/Default/Network/Cookies-journal", b"")
    t.make_db("browser/profile/Default/History", rows=3)
    t.write("browser/profile/Default/History-journal", b"")
    t.write("browser/downloads/report.pdf", b"%PDF" + b"d" * 96)
    t.write("browser/home/.pki/nssdb/cert9.db", b"n")
    t.write("desk/volume.json", b'{"volumeId":"vol-x"}')
    t.write("desk/notebook/volume.json", b"member's own file of that name")
    t.make_db("desk/deskd.db", rows=4)
    t.write("agent/memory.json", b"{}")
    t.write("apps/registry.json", b"{}")
    t.write("apps/tally/releases/1.0.0/bin/tally", b"elf")
    os.symlink("releases/1.0.0", t.p("apps/tally/current"))
    os.symlink("releases/0.9.0", t.p("apps/tally/previous"))
    t.write("apps/tally/cache/c.bin", b"c")
    t.write("apps/tally/data/counts.json", b"[1,2,3]")
    t.write("files/photo.jpg", b"\xff\xd8" + b"p" * 998)
    t.write("rtc/key.pem", b"secret", 0o600)
    t.write("selfhost/key.pem", b"ed25519", 0o600)
    t.write("selfhost/pairing.json", b"{}")
    t.write("desk-egress/state.json", b"{}")
    t.mkdir("lost+found")
    t.write(".ma-move/m1/report.json", b"{}")
    t.write(".ma-volume", b"{}")
    t.write("browser-readable/stored.txt", b"shadowed")
    t.write("zeta/thing", b"z" * 7)
    os.symlink("files", t.p("files-link"))


class TestRequests(Base):
    def test_denied_uid(self):
        r = self.raw(b'{"v":1,"op":"parts"}\n', helper=self.helper(allowed_uid=UID + 1))
        self.assertEqual(r.header, {"ok": False, "code": "denied", "message": "only deskd may use this socket"})

    def test_malformed(self):
        build_desk(self)
        cases = {
            "not json": b"hello\n",
            "no newline": b'{"v":1,"op":"parts"}',
            "too long": b'{"v":1,"op":"read","part":"files","path":"' + b"a" * 16400 + b'"}\n',
            "16,385 bytes": b'{"v":1,"op":"parts"' + b" " * (16385 - 21) + b'}\n',
            "not an object": b"[1]\n",
            "no v": b'{"op":"parts"}\n',
            "v 2": b'{"v":2,"op":"parts"}\n',
            "v true": b'{"v":true,"op":"parts"}\n',
            "v 1.0": b'{"v":1.0,"op":"parts"}\n',
            "unknown op": b'{"v":1,"op":"write"}\n',
            "unknown field": b'{"v":1,"op":"parts","path":"x"}\n',
            "duplicate key": b'{"v":1,"op":"parts","op":"parts"}\n',
            "NaN": b'{"v":1,"op":"read","part":"files","path":"a","offset":NaN}\n',
            "limit 0": b'{"v":1,"op":"manifest","part":"files","limit":0}\n',
            "limit 2001": b'{"v":1,"op":"manifest","part":"files","limit":2001}\n',
            "limit string": b'{"v":1,"op":"manifest","part":"files","limit":"5"}\n',
            "cursor number": b'{"v":1,"op":"manifest","part":"files","cursor":5}\n',
            "offset negative": b'{"v":1,"op":"read","part":"files","path":"photo.jpg","offset":-1}\n',
            "offset fraction": b'{"v":1,"op":"read","part":"files","path":"photo.jpg","offset":1.5}\n',
            "offset bool": b'{"v":1,"op":"read","part":"files","path":"photo.jpg","offset":true}\n',
            "part number": b'{"v":1,"op":"manifest","part":1}\n',
            "path missing": b'{"v":1,"op":"read","part":"files"}\n',
            "two lines": b'{"v":1,"op":"parts"}\n{"v":1,"op":"parts"}\n',
            "not utf-8": b'{"v":1,"op":"read","part":"files","path":"\xff"}\n',
        }
        for name, req in cases.items():
            with self.subTest(name):
                r = self.raw(req, shut_write=True)
                self.assertEqual(r.code, "bad_request", (name, r.header))

    def test_request_of_exactly_16384_bytes_is_taken(self):
        self.write("files/a", b"hi")
        body = b'{"v":1,"op":"read","part":"files","path":"a","offset":0'
        line = body + b" " * (16384 - len(body) - 2) + b"}\n"
        self.assertEqual(len(line), 16384)
        r = self.raw(line)
        self.assertTrue(r.header["ok"], r.header)

    def test_idle_peer_is_dropped(self):
        a, b = socket.socketpair()
        h = self.helper(idle_timeout_s=0.5)
        t = threading.Thread(target=h.serve, args=(b,), daemon=True)
        start = time.monotonic()
        t.start()
        t.join(5)
        self.assertFalse(t.is_alive())
        self.assertLess(time.monotonic() - start, 3)
        self.assertEqual(recv_all(a, 2), b"")
        a.close()
        b.close()

    def test_stalled_reader_is_dropped(self):
        self.write("files/big", os.urandom(4 << 20))
        a, b = socket.socketpair()
        h = self.helper(stall_timeout_s=0.5)
        t = threading.Thread(target=h.serve, args=(b,), daemon=True)
        t.start()
        a.sendall(b'{"v":1,"op":"read","part":"files","path":"big","offset":0}\n')
        t.join(8)   # never read: the helper gives up on its own
        self.assertFalse(t.is_alive())
        r = Reply(recv_all(a, 5))
        self.assertTrue(r.header["ok"])
        self.assertFalse(r.complete)
        a.close()
        b.close()

    def test_a_reader_may_pause_past_the_request_timeout(self):
        """The request has 30 s; a reader that has asked may pause as long as deskd lets it (5 minutes without
        credit), so only deskd ends a transfer for a slow reader. The helper's own limit is past deskd's."""
        self.assertGreater(dd.STALL_TIMEOUT_S, 300)
        self.assertEqual(dd.IDLE_TIMEOUT_S, 30)
        data = os.urandom(4 << 20)
        self.write("files/big", data)
        a, b = socket.socketpair()
        h = self.helper(idle_timeout_s=0.3, stall_timeout_s=5)
        t = threading.Thread(target=h.serve, args=(b,), daemon=True)
        t.start()
        a.sendall(b'{"v":1,"op":"read","part":"files","path":"big","offset":0}\n')
        a.settimeout(5)
        first = a.recv(64)
        time.sleep(1.2)   # well past the request's timeout, with the socket full
        r = Reply(first + recv_all(a))
        t.join(5)
        a.close()
        b.close()
        self.assertTrue(r.complete)
        self.assertEqual(r.body, data)

    def test_socket_entry_point_always_uses_data(self):
        import inspect
        self.assertEqual(dd.DATA_ROOT, "/data")
        self.assertEqual(dd.DESK_UID, 1100)
        self.assertEqual(len(inspect.signature(dd.main).parameters), 0)
        self.assertIn("Helper(DATA_ROOT, DESK_UID)", inspect.getsource(dd.main))


class TestParts(Base):
    def test_parts_and_labels(self):
        build_desk(self)
        r = self.call(op="parts")
        self.assertTrue(r.header["ok"])
        self.assertEqual(r.header["helperVersion"], dd.HELPER_VERSION)
        parts = {p["part"]: p for p in r.header["parts"]}
        self.assertEqual([p["part"] for p in r.header["parts"]],
                         ["agent", "apps", "browser", "browser-readable", "desk", "files", "zeta"])
        self.assertEqual({k: v["label"] for k, v in parts.items()}, {
            "agent": "Agent", "apps": "Apps", "browser": "Browser", "browser-readable": "Bookmarks and history",
            "desk": "Desk settings and Chat", "files": "Files", "zeta": "zeta"})
        cookies = os.path.getsize(self.p("browser/profile/Default/Network/Cookies"))
        history = os.path.getsize(self.p("browser/profile/Default/History"))
        browser_files = {"Local State": 2, "Last Version": 13, "Preferences": 7, "000003.log": 2, "LOCK": 0,
                         "CURRENT": 2, "Session_1": 20, "Login Data": 10, "report.pdf": 100, "cert9.db": 1}
        self.assertEqual(parts["browser"]["files"], len(browser_files) + 2)
        self.assertEqual(parts["browser"]["bytes"], sum(browser_files.values()) + cookies + history)
        self.assertEqual((parts["apps"]["files"], parts["apps"]["bytes"]), (1, 7))
        deskdb = os.path.getsize(self.p("desk/deskd.db"))
        self.assertEqual((parts["desk"]["files"], parts["desk"]["bytes"]), (2, deskdb + 30))
        self.assertEqual((parts["files"]["files"], parts["files"]["bytes"]), (1, 1000))
        self.assertEqual((parts["zeta"]["files"], parts["zeta"]["bytes"]), (1, 7))
        self.assertEqual(parts["browser-readable"]["files"], 1)   # History only: no Bookmarks in this profile

    def test_notebook_is_a_part_of_its_own(self):
        """A new top-level part needs no change here: it's listed, read and labelled like any other."""
        self.write("notebook/readable/Work/General/Plan.md", b"# Plan\n")
        db = sqlite3.connect(self.p("notebook/notebook.db"))
        self.writers.append(db)
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE pages (id TEXT, title TEXT)")
        db.execute("INSERT INTO pages VALUES ('p1', 'Plan')")
        db.commit()
        parts = {p["part"]: p for p in self.call(op="parts").header["parts"]}
        self.assertEqual(parts["notebook"]["label"], "Notebook")
        self.assertEqual(parts["notebook"]["files"], 2)   # The database and the Markdown, not its -wal or -shm.
        paths = self.all_paths("notebook")
        self.assertIn("notebook.db", paths)
        self.assertIn("readable/Work/General/Plan.md", paths)
        self.assertNotIn("notebook.db-wal", paths)
        self.assertNotIn("notebook.db-shm", paths)
        self.assertEqual(self.read_ok("notebook", "readable/Work/General/Plan.md").body, b"# Plan\n")
        # The database comes whole, as a consistent copy, with its live writer still open.
        received = self.received_db(self.read_ok("notebook", "notebook.db"))
        self.assertEqual(received.execute("SELECT title FROM pages").fetchall(), [("Plan",)])
        received.close()
        self.assertEqual(self.read("notebook", "notebook.db-wal").code, "not_found")

    def test_no_browser_profile_no_readable_part(self):
        self.write("files/a")
        names = [p["part"] for p in self.call(op="parts").header["parts"]]
        self.assertEqual(names, ["files"])
        self.assertEqual(self.call(op="manifest", part="browser-readable").code, "not_found")


class TestManifest(Base):
    def setUp(self):
        super().setUp()
        build_desk(self)

    def test_browser_caches_and_locks_left_out(self):
        paths = self.all_paths("browser")
        for left_out in ("Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache",
                         "GrShaderCache", "GraphiteDawnCache", "ShaderCache", "component_crx_cache", "Crashpad",
                         "SingletonLock", "SingletonCookie", "SingletonSocket"):
            self.assertFalse([p for p in paths if left_out in p.split("/")], left_out)
        for kept in ("profile/Default/Network/Cookies", "profile/Default/History", "profile/Default/Login Data",
                     "profile/Default/Local Storage/leveldb/000003.log", "profile/Default/Sessions/Session_1",
                     "profile/Default/IndexedDB/https_x_0.indexeddb.leveldb/LOCK",
                     "profile/Default/Service Worker/Database/CURRENT", "downloads/report.pdf",
                     "home/.pki/nssdb/cert9.db", "profile/Local State", "profile/Default"):
            self.assertIn(kept, paths)
        self.assertNotIn("profile/Default/Network/Cookies-journal", paths)
        self.assertNotIn("profile/Default/History-journal", paths)

    def test_desk_and_apps_exclusions(self):
        desk = self.all_paths("desk")
        self.assertNotIn("volume.json", desk)
        self.assertIn("notebook/volume.json", desk)
        apps = self.all_paths("apps")
        self.assertEqual(apps, ["tally", "tally/data", "tally/data/counts.json"])

    def test_machine_parts_not_found(self):
        for part in ("rtc", "selfhost", "desk-egress", "lost+found", ".ma-move", ".ma-export-tmp", "nope",
                     "files-link"):
            with self.subTest(part):
                self.assertEqual(self.call(op="manifest", part=part).code, "not_found")
                self.assertEqual(self.read(part, "key.pem").code, "not_found")

    def test_entry_fields(self):
        os.utime(self.p("files/photo.jpg"), ns=(1_700_000_000_123_456_789, 1_700_000_000_123_456_789))
        os.chmod(self.p("files/photo.jpg"), 0o640)
        os.symlink("/etc/passwd", self.p("files/escape"))
        e = {x["path"]: x for x in self.manifest("files")["entries"]}
        self.assertEqual(e["photo.jpg"], {"path": "photo.jpg", "type": "file", "size": 1000,
                                          "mtimeMs": 1_700_000_000_123, "mode": 0o640})
        self.assertEqual(e["escape"]["type"], "link")
        self.assertEqual(e["escape"]["target"], "/etc/passwd")

    def test_sqlite_siblings_only_beside_a_database(self):
        self.write("files/notes", b"plain text")
        self.write("files/notes-wal", b"also plain")
        self.make_db("files/app.db", wal=False)
        self.write("files/app.db-journal", b"j")
        self.write("files/app.db-shm", b"s")
        self.write("files/app.db-wal", b"w")
        paths = self.all_paths("files")
        self.assertIn("notes-wal", paths)
        self.assertIn("app.db", paths)
        for s in ("-journal", "-shm", "-wal"):
            self.assertNotIn("app.db" + s, paths)
            self.assertEqual(self.read("files", "app.db" + s).code, "not_found")

    def test_paging_is_stable_and_complete(self):
        names = ["a", "a.txt", "a b", "B", "é", "z", "a-", "a/b", "a/b/c", "a/b/c/d.txt", "a/c", "a.d/x", "0", "~"]
        for n in names:
            if n in ("a", "a/b", "a/b/c", "a.d"):
                continue
            self.write("files/many/" + n, n.encode())
        for i in range(30):
            self.write(f"files/many/n{i:02d}/f", b"f")
        full = self.all_paths("files", 2000)
        for limit in (1, 2, 3, 7, 50):
            with self.subTest(limit=limit):
                self.assertEqual(self.all_paths("files", limit), full)
        keys = [tuple(os.fsencode(c) for c in p.split("/")) for p in full]
        self.assertEqual(keys, sorted(keys))
        self.assertEqual(len(full), len(set(full)))
        # The cursor's own entry removed between pages: nothing after it is skipped or repeated.
        first = self.manifest("files", None, 5)
        os.unlink(self.p("files", first["next"])) if os.path.isfile(self.p("files", first["next"])) else None
        rest = self.manifest("files", first["next"], 2000)["entries"]
        after = [p for p in full if tuple(os.fsencode(c) for c in p.split("/")) >
                 tuple(os.fsencode(c) for c in first["next"].split("/"))]
        self.assertEqual([e["path"] for e in rest], after)

    def test_name_that_isnt_utf8(self):
        name = b"caf\xe9.txt"
        with open(os.path.join(os.fsencode(self.p("files")), name), "wb") as f:
            f.write(b"bytes")
        paths = self.all_paths("files")
        self.assertIn("caf\udce9.txt", paths)
        r = self.read_ok("files", "caf\udce9.txt")
        self.assertEqual(r.body, b"bytes")

    def test_long_paths_left_out(self):
        fd = os.open(self.p("files"), os.O_RDONLY | os.O_DIRECTORY)
        for _ in range(21):   # 21 names of 200 bytes: the 20th level passes 4,000 bytes
            os.mkdir("d" * 200, dir_fd=fd)
            nfd = os.open("d" * 200, os.O_RDONLY | os.O_DIRECTORY, dir_fd=fd)
            os.close(fd)
            fd = nfd
        os.close(fd)
        paths = self.all_paths("files")
        self.assertEqual(max(len(p.encode()) for p in paths), 19 * 201 - 1)


class TestAgentKeys(Base):
    """ADR 0042: a member's sealed LLM keys are the member's, so an export and a move carry them."""

    def test_the_master_key_and_a_sealed_file_are_exported(self):
        master, sealed = os.urandom(32), b"MAKV\x01" + os.urandom(60)
        self.write("agent/keys/master.key", master, mode=0o600)
        self.write("agent/keys/k-1.sealed", sealed, mode=0o600)
        os.chmod(self.p("agent/keys"), 0o700)
        entries = {e["path"]: e for e in self.manifest("agent")["entries"]}
        self.assertEqual((entries["keys"]["type"], entries["keys"]["mode"]), ("dir", 0o700))
        for path, body in (("keys/master.key", master), ("keys/k-1.sealed", sealed)):
            with self.subTest(path):
                self.assertEqual((entries[path]["type"], entries[path]["mode"]), ("file", 0o600))
                self.assertEqual(self.read_ok("agent", path).body, body)
        parts = {p["part"]: p for p in self.call(op="parts").header["parts"]}
        self.assertEqual(parts["agent"]["files"], 2)


class TestPathSafety(Base):
    def setUp(self):
        super().setUp()
        build_desk(self)

    def test_bad_paths_invalid(self):
        for path in ("..", "../desk/deskd.db", "photo.jpg/../photo.jpg", "/etc/passwd", "", "a//b", "photo.jpg/",
                     ".", "./photo.jpg", "a\x00b", "x" * 256, "a/" + "y" * 256):
            with self.subTest(path=path):
                self.assertEqual(self.read("files", path).code, "invalid")
        self.assertEqual(self.read("../etc", "passwd").code, "invalid")
        self.assertEqual(self.read("", "passwd").code, "invalid")
        self.assertEqual(self.call(op="manifest", part="files", cursor="../x").code, "invalid")

    def test_component_of_255_bytes_is_fine(self):
        self.write("files/" + "n" * 255, b"ok")
        self.assertEqual(self.read_ok("files", "n" * 255).body, b"ok")

    def test_symlinks_listed_never_followed(self):
        os.symlink("/etc/passwd", self.p("files/escape"))
        os.symlink("../browser/profile/Default/Network/Cookies", self.p("files/cross"))
        os.symlink("../browser", self.p("files/dirlink"))
        e = {x["path"]: x for x in self.manifest("files")["entries"]}
        self.assertEqual((e["escape"]["type"], e["escape"]["target"]), ("link", "/etc/passwd"))
        self.assertEqual((e["cross"]["type"], e["cross"]["target"]),
                         ("link", "../browser/profile/Default/Network/Cookies"))
        self.assertEqual(e["dirlink"]["type"], "link")
        self.assertFalse([p for p in e if p.startswith("dirlink/")])
        for path in ("escape", "cross", "dirlink"):
            r = self.read("files", path)
            self.assertEqual(r.code, "invalid", path)
            self.assertNotIn(b"root:", r.raw)
        # A directory link in the middle of a path.
        r = self.read("files", "dirlink/profile/Default/Network/Cookies")
        self.assertEqual(r.code, "invalid")
        # Top-level: a link isn't a part.
        self.assertEqual(self.read("files-link", "photo.jpg").code, "not_found")

    def test_link_in_the_middle_inside_browser(self):
        os.symlink("../../../rtc", self.p("browser/profile/Default/Evil"))
        self.assertEqual(self.read("browser", "profile/Default/Evil/key.pem").code, "invalid")

    def test_not_regular_files(self):
        os.mkfifo(self.p("files/fifo"))
        self.assertNotIn("fifo", self.all_paths("files"))
        self.assertEqual(self.read("files", "fifo").code, "invalid")   # and it didn't hang on the open
        self.assertEqual(self.read("files", "").code, "invalid")
        self.mkdir("files/sub")
        self.assertEqual(self.read("files", "sub").code, "invalid")
        self.assertEqual(self.read("files", "photo.jpg/x").code, "invalid")
        self.assertEqual(self.read("files", "missing").code, "not_found")
        self.assertEqual(self.read("files", "nodir/missing").code, "not_found")

    def test_excluded_paths_not_found_on_read(self):
        for part, path in (("browser", "profile/Default/Cache/Cache_Data/data_0"),
                           ("browser", "profile/Default/Code Cache/js/index"),
                           ("browser", "profile/Crashpad/settings.dat"),
                           ("browser", "profile/SingletonLock"),
                           ("browser", "profile/Default/Network/Cookies-journal"),
                           ("desk", "volume.json"),
                           ("apps", "registry.json"),
                           ("apps", "tally/releases/1.0.0/bin/tally"),
                           ("apps", "tally/cache/c.bin"),
                           ("apps", "tally/current"),
                           ("rtc", "key.pem"),
                           ("selfhost", "key.pem"),
                           ("selfhost", "pairing.json"),
                           ("desk-egress", "state.json"),
                           (".ma-move", "m1/report.json")):
            with self.subTest(part=part, path=path):
                self.assertEqual(self.read(part, path).code, "not_found")
        self.assertEqual(self.read_ok("desk", "notebook/volume.json").body, b"member's own file of that name")
        self.assertEqual(self.read_ok("apps", "tally/data/counts.json").body, b"[1,2,3]")


class TestRead(Base):
    def test_body_framing_and_trailer(self):
        data = os.urandom(300_001)
        self.write("files/blob", data)
        r = self.read_ok("files", "blob")
        self.assertEqual(r.header["size"], len(data))
        self.assertEqual(r.body, data)
        self.assertTrue(all(0 < n <= 65536 for n in r.chunks))
        self.assertEqual(r.digest, hashlib.sha256(data).digest())
        self.assertEqual(r.count, len(data))

    def test_empty_file(self):
        self.write("files/empty", b"")
        r = self.read_ok("files", "empty")
        self.assertEqual((r.header["size"], r.chunks, r.count), (0, [], 0))
        self.assertEqual(r.digest, hashlib.sha256(b"").digest())

    def test_resume_gives_the_same_trailer(self):
        data = os.urandom(1_000_003)
        self.write("files/blob", data)
        full = self.read_ok("files", "blob")
        for offset in (1, 65536, 400_000, len(data) - 1, len(data)):
            with self.subTest(offset=offset):
                r = self.read_ok("files", "blob", offset)
                self.assertEqual(r.body, data[offset:])
                self.assertEqual((r.digest, r.count), (full.digest, full.count))
        r = self.read_ok("files", "blob", len(data) + 10)   # past the end: nothing sent, the trailer says how much
        self.assertEqual((r.body, r.digest, r.count), (b"", full.digest, len(data)))

    def _paused_read(self, path, change):
        a, b = socket.socketpair()
        t = threading.Thread(target=self.helper().serve, args=(b,), daemon=True)
        t.start()
        a.sendall(json.dumps({"v": 1, "op": "read", "part": "files", "path": path, "offset": 0}).encode() + b"\n")
        a.settimeout(10)
        first = a.recv(64)
        time.sleep(0.3)   # the helper fills the socket buffer and blocks
        change()
        r = Reply(first + recv_all(a))
        t.join(10)
        a.close()
        b.close()
        return r

    def assert_failed_ending(self, r, data):
        """The existing failed-read ending: the header, part of the body, then no zero and no trailer."""
        self.assertTrue(r.header["ok"], r.header)
        self.assertFalse(r.complete, "a trailer vouched for a file that changed while it was read")
        self.assertIsNone(r.digest)
        self.assertLessEqual(len(r.body), len(data))

    def test_file_that_shrinks(self):
        data = os.urandom(4 << 20)
        path = self.write("files/shrinks", data)
        r = self._paused_read("shrinks", lambda: os.truncate(path, 2 << 20))
        self.assertEqual(r.header["size"], 4 << 20)
        self.assert_failed_ending(r, data)

    def test_file_that_grows(self):
        data = os.urandom(2 << 20)
        path = self.write("files/grows", data)

        def grow():
            with open(path, "ab") as f:
                f.write(b"more" * 100_000)

        r = self._paused_read("grows", grow)
        self.assertEqual(r.header["size"], 2 << 20)
        self.assert_failed_ending(r, data)
        self.assertEqual(r.body, data[: len(r.body)])

    def test_file_rewritten_in_place_mid_read(self):
        """Same size, same mtime put back, from offset 0: the old trailer hashed what was sent and matched it, so a
        body of old bytes and new passed every check. Now the body stops short and the reader asks again."""
        old = os.urandom(4 << 20)
        new = os.urandom(4 << 20)
        path = self.write("files/rewritten", old)
        st = os.stat(path)

        def rewrite():
            fd = os.open(path, os.O_WRONLY)
            try:
                os.pwrite(fd, new, 0)   # in place: same inode, same size
            finally:
                os.close(fd)
            os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns))   # mtime as it was; only ctime moves

        r = self._paused_read("rewritten", rewrite)
        self.assertEqual(r.header["size"], 4 << 20)
        self.assert_failed_ending(r, old)
        self.assertNotEqual(r.body, new[: len(r.body)])   # it really did start with the old bytes
        again = self.read_ok("files", "rewritten")   # asked again, it's the new file, whole and checked
        self.assertEqual(again.body, new)
        self.assertEqual(again.digest, hashlib.sha256(new).digest())

    def test_resumed_read_of_a_file_rewritten_since(self):
        """A resume hashes the part before its offset from the file as it is now, so a reader that has old bytes
        there sees the trailer differ and reads it again from 0."""
        old, new = os.urandom(300_000), os.urandom(300_000)
        path = self.write("files/f", old)
        first = self.read_ok("files", "f")
        with open(path, "r+b") as f:
            f.write(new)
        r = self.read_ok("files", "f", 100_000)
        self.assertEqual(r.digest, hashlib.sha256(new).digest())
        self.assertNotEqual(r.digest, hashlib.sha256(old[:100_000] + r.body).digest())
        self.assertNotEqual(r.digest, first.digest)

    def test_a_file_just_written_waits_to_settle(self):
        """Timestamps come from a coarse clock, so a write in the same tick as the stat before the read could leave
        them unmoved. A file changed in the last settle_ms is read once it's been still that long."""
        data = os.urandom(1000)
        self.write("files/fresh", data)
        start = time.monotonic()
        r = self.read("files", "fresh", helper=self.helper(settle_ms=300))
        self.assertTrue(r.complete)
        self.assertEqual(r.body, data)
        self.assertGreaterEqual(time.monotonic() - start, 0.2)

    def test_a_file_that_never_settles_fails(self):
        path = self.write("files/busy", b"0" * 100)
        stop = threading.Event()

        def writer():
            while not stop.is_set():
                with open(path, "r+b") as f:
                    f.write(os.urandom(100))
                time.sleep(0.005)

        t = threading.Thread(target=writer, daemon=True)
        t.start()
        try:
            r = self.read("files", "busy", helper=self.helper(settle_ms=100, busy_s=1))
        finally:
            stop.set()
            t.join(5)
        self.assertEqual(r.code, "failed")
        self.assertIn("kept changing", r.header["message"])

    def test_a_future_mtime_doesnt_stop_a_read(self):
        """mtime can be set to anything, so settling looks at ctime, which can't."""
        path = self.write("files/future", b"from the future")
        later = time.time_ns() + 10 * 365 * 86400 * 10**9
        os.utime(path, ns=(later, later))
        time.sleep(0.05)
        r = self.read_ok("files", "future")
        self.assertEqual(r.body, b"from the future")
        self.assertEqual(r.header["mtimeMs"], later // 1_000_000)


class TestSQLite(Base):
    def scratch_left(self):
        d = self.p(".ma-export-tmp")
        return [os.path.join(dp, f) for dp, _, fs in os.walk(d) for f in fs] if os.path.isdir(d) else []

    def open_wal_writer(self, rel, committed=200, uncommitted=50):
        """A live WAL database: rows committed into the -wal only, and an open transaction on top."""
        path = self.p(rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        w = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self.writers.append(w)
        w.execute("PRAGMA journal_mode=WAL")
        w.execute("PRAGMA wal_autocheckpoint=0")
        w.execute("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)")
        for i in range(committed):
            w.execute("INSERT INTO t(v) VALUES (?)", (f"committed {i}" * 20,))
        w.execute("BEGIN")
        for i in range(uncommitted):
            w.execute("INSERT INTO t(v) VALUES (?)", (f"uncommitted {i}",))
        self.assertGreater(os.path.getsize(path + "-wal"), 0)
        return path, w

    def check_wal_read(self, rel):
        r = self.read_ok("files", rel)
        self.assertEqual(r.header["size"], len(r.body))
        self.assertEqual(r.digest, hashlib.sha256(r.body).digest())
        db = self.received_db(r)
        self.assertEqual(db.execute("PRAGMA integrity_check").fetchone(), ("ok",))
        self.assertEqual(db.execute("SELECT count(*) FROM t").fetchone(), (200,))
        self.assertEqual(db.execute("SELECT count(*) FROM t WHERE v LIKE 'uncommitted%'").fetchone(), (0,))
        db.close()
        return r

    def test_wal_database_with_a_live_writer(self):
        path, w = self.open_wal_writer("files/live/app.db")
        on_disk = os.path.getsize(path)
        paths = self.all_paths("files")
        self.assertEqual(paths, ["live", "live/app.db"])
        entry = self.manifest("files")["entries"][1]
        self.assertEqual(entry["size"], on_disk)   # the manifest gives the size on disk
        r = self.check_wal_read("live/app.db")
        self.assertNotEqual(r.header["size"], on_disk)   # the backup holds what's only in the -wal
        self.assertEqual(self.read("files", "live/app.db-wal").code, "not_found")
        self.assertEqual(self.read("files", "live/app.db-shm").code, "not_found")
        w.execute("COMMIT")
        self.assertEqual(self.scratch_left(), [])

    def test_wal_database_on_a_read_only_directory(self):
        """As under ReadOnlyPaths=/data: SQLite can't write the -shm, and reads the WAL itself."""
        path, w = self.open_wal_writer("files/live/app.db")
        os.chmod(path + "-shm", 0o444)
        os.chmod(self.p("files/live"), 0o555)
        self.check_wal_read("live/app.db")
        w.execute("COMMIT")

    def test_wal_database_closed_on_a_read_only_directory(self):
        """A WAL database nobody has open has no -shm, and none can be made: the quiet copy reads it."""
        path, w = self.open_wal_writer("files/live/app.db")
        w.execute("COMMIT")
        w.close()
        self.assertFalse(os.path.exists(path + "-wal"))
        os.chmod(self.p("files/live"), 0o555)
        db = self.received_db(self.read_ok("files", "live/app.db"))
        self.assertEqual(db.execute("SELECT count(*) FROM t").fetchone(), (250,))
        db.close()

    def test_exclusive_lock_like_chromium(self):
        """Chromium keeps its databases in exclusive locking mode: the online backup never gets in."""
        path = self.p("browser/profile/Default/Network/Cookies")
        os.makedirs(os.path.dirname(path))
        w = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self.writers.append(w)
        w.execute("PRAGMA locking_mode=EXCLUSIVE")
        w.execute("PRAGMA journal_mode=TRUNCATE")
        w.execute("CREATE TABLE cookies(host TEXT, name TEXT, value BLOB)")
        for i in range(100):
            w.execute("INSERT INTO cookies VALUES (?, ?, ?)", (f"h{i}.example", "sid", os.urandom(32)))
        w.execute("BEGIN")
        w.execute("INSERT INTO cookies VALUES ('pending.example', 'sid', x'00')")
        time.sleep(0.1)
        probe = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=0)
        with self.assertRaises(sqlite3.OperationalError):
            probe.execute("SELECT count(*) FROM cookies").fetchone()
        probe.close()
        db = self.received_db(self.read_ok("browser", "profile/Default/Network/Cookies"))
        self.assertEqual(db.execute("PRAGMA integrity_check").fetchone(), ("ok",))
        self.assertEqual(db.execute("SELECT count(*) FROM cookies").fetchone(), (100,))
        db.close()
        w.execute("COMMIT")

    def test_locked_and_always_changing_fails(self):
        path = self.p("files/busy.db")
        stop = threading.Event()
        ready = threading.Event()

        def writer():
            w = sqlite3.connect(path, isolation_level=None)
            w.execute("PRAGMA locking_mode=EXCLUSIVE")
            w.execute("CREATE TABLE t(v)")
            ready.set()
            while not stop.is_set():
                w.execute("INSERT INTO t VALUES (randomblob(100))")
                time.sleep(0.01)
            w.close()

        t = threading.Thread(target=writer, daemon=True)
        os.makedirs(self.p("files"))
        t.start()
        ready.wait(5)
        try:
            r = self.read("files", "busy.db", helper=self.helper(busy_s=1.5, online_s=0.3, quiet_ms=200))
            self.assertEqual(r.code, "failed")
            self.assertIn("kept changing", r.header["message"])
        finally:
            stop.set()
            t.join(5)
        self.assertEqual(self.scratch_left(), [])

    def test_hot_journal_after_a_crash(self):
        """A writer killed mid-transaction leaves a hot journal that read-only SQLite can't roll back."""
        os.makedirs(self.p("files"))
        path = self.p("files/crashed.db")
        child = (
            "import sqlite3, os, sys\n"
            "db = sqlite3.connect(sys.argv[1], isolation_level=None)\n"
            "db.execute('PRAGMA cache_size=1'); db.execute('CREATE TABLE t(v)')\n"
            "db.execute('BEGIN')\n"
            "[db.execute('INSERT INTO t VALUES (?)', ('x' * 500,)) for _ in range(300)]\n"
            "db.execute('COMMIT'); db.execute('BEGIN'); db.execute(\"UPDATE t SET v = 'y'\")\n"
            "os._exit(0)\n")
        subprocess.run([sys.executable, "-I", "-c", child, path], check=True)
        self.assertGreater(os.path.getsize(path + "-journal"), 0)
        os.chmod(self.p("files"), 0o555)
        self.assertNotIn("crashed.db-journal", self.all_paths("files"))
        db = self.received_db(self.read_ok("files", "crashed.db"))
        self.assertEqual(db.execute("PRAGMA integrity_check").fetchone(), ("ok",))
        self.assertEqual(db.execute("SELECT count(*), min(v) FROM t").fetchone(), (300, "x" * 500))
        db.close()

    def test_path_swapped_under_sqlite_fails(self):
        """SQLite opens by path; if what it opened isn't the inode reached with O_NOFOLLOW, nothing is sent."""
        self.make_db("files/real.db", rows=3)
        other = self.make_db("browser/profile/Default/Login Data", rows=99)
        h = self.helper()
        h._source_uri = lambda dir_fd, name: f"file:{other}?mode=ro"
        r = self.read("files", "real.db", helper=h)
        self.assertEqual(r.code, "failed")
        self.assertIn("path changed", r.header["message"])

    def test_not_really_a_database_is_sent_as_it_is(self):
        data = dd.SQLITE_HEADER + os.urandom(5000)
        self.write("files/broken.db", data)
        r = self.read_ok("files", "broken.db")
        self.assertEqual(r.body, data)

    def test_resume_of_a_database(self):
        self.make_db("files/a.db", rows=500)
        full = self.read_ok("files", "a.db")
        r = self.read_ok("files", "a.db", 4096)
        self.assertEqual(full.body[4096:], r.body)
        self.assertEqual((r.digest, r.count), (full.digest, full.count))

    def test_no_room_for_a_copy(self):
        self.make_db("files/a.db")
        self.write("files/plain", b"p")
        h = self.helper(free_floor=1 << 62)
        r = self.read("files", "a.db", helper=h)
        self.assertEqual(r.code, "failed")
        self.assertIn("free space", r.header["message"])
        self.assertTrue(self.read("files", "plain", helper=self.helper(free_floor=1 << 62)).complete)

    def live_helper_dir(self, name, room=None):
        """A scratch directory a live helper holds, saying what its copy in progress may still write."""
        d = self.mkdir(f".ma-export-tmp/{name}")
        if room is not None:
            with open(os.path.join(d, dd.ROOM_FILE), "w") as f:
                f.write(str(room))
        fd = os.open(d, os.O_RDONLY | os.O_DIRECTORY)
        fcntl.flock(fd, fcntl.LOCK_EX)
        self.addCleanup(os.close, fd)
        return fd

    def room_helper(self, floor, free):
        h = self.helper(free_floor=floor)
        h.free_bytes = lambda: free
        return h

    def test_another_helpers_copy_in_progress_counts_against_the_floor(self):
        db = self.make_db("files/a.db", rows=50)
        self.write("files/plain", b"p")
        need = 2 * os.path.getsize(db)
        free = 10 << 30
        floor = free - need - (1 << 20)   # room for this copy alone, and 1 MiB more
        self.assertTrue(self.read("files", "a.db", helper=self.room_helper(floor, free)).complete)
        self.live_helper_dir("c1-live", room=2 << 20)   # another helper's copy may still write 2 MiB
        r = self.read("files", "a.db", helper=self.room_helper(floor, free))
        self.assertEqual(r.code, "failed")
        self.assertIn("free space", r.header["message"])
        self.assertTrue(self.read("files", "plain", helper=self.room_helper(floor, free)).complete)
        self.assertEqual(os.listdir(self.p(".ma-export-tmp")), ["c1-live"])   # its own room file went with it

    def test_room_of_a_helper_that_has_gone_doesnt_count(self):
        self.live_helper_dir("c1-live", room=5000)
        self.live_helper_dir("c2-live", room=200)
        self.write(".ma-export-tmp/c3-dead/" + dd.ROOM_FILE, b"7000")   # no flock: its process has gone
        self.write(".ma-export-tmp/c4-bad/" + dd.ROOM_FILE, b"lots")
        self.live_helper_dir("c4-bad")
        h = self.helper()
        h.scratch_parent = os.open(self.p(".ma-export-tmp"), os.O_RDONLY | os.O_DIRECTORY)
        try:
            self.assertEqual(h.others_room(), 5200)
        finally:
            os.close(h.scratch_parent)

    def test_rooms_add_up_across_helpers_and_are_given_back(self):
        a, b = self.room_helper(0, 10 << 20), self.room_helper(0, 10 << 20)
        for h in (a, b):
            h.data_fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
            h._clean_scratch()
        try:
            with a.room(6 << 20):
                with self.assertRaises(dd.Refusal) as refused:
                    with b.room(6 << 20):
                        pass
                self.assertEqual(refused.exception.code, "failed")
                with b.room(3 << 20):
                    self.assertEqual(a.others_room(), 3 << 20)
                self.assertEqual(a.others_room(), 0)
            with b.room(6 << 20):   # a's has been given back
                self.assertEqual(b.others_room(), 0)
                self.assertEqual(a.others_room(), 6 << 20)
        finally:
            for h in (a, b):
                h._drop_scratch()
                os.close(h.data_fd)
        self.assertEqual(os.listdir(self.p(".ma-export-tmp")), [])

    def test_concurrent_copies_cant_take_data_past_the_floor(self):
        """Each read checked the free space alone, and the copies live on /data, so several big databases read at
        once could take it past the Browser's floor. Two at once now see each other."""
        sizes = [os.path.getsize(self.make_db(f"files/{n}.db", rows=100)) for n in ("a", "b")]
        need = 2 * max(sizes)
        free = 1 << 30
        floor = free - need - need // 2   # one copy fits, two don't
        made, go = threading.Event(), threading.Event()
        slow = self.room_helper(floor, free)
        copy = slow._sqlite_copy

        def held_copy(*args):
            out = copy(*args)
            made.set()
            go.wait(10)   # still making it, as far as its room says
            return out

        slow._sqlite_copy = held_copy
        first = {}
        t = threading.Thread(target=lambda: first.setdefault("r", self.read("files", "a.db", helper=slow)))
        t.start()
        self.assertTrue(made.wait(10))
        try:
            r = self.read("files", "b.db", helper=self.room_helper(floor, free))
        finally:
            go.set()
            t.join(10)
        self.assertEqual(r.code, "failed")
        self.assertIn("free space", r.header["message"])
        self.assertTrue(first["r"].complete)
        self.assertTrue(self.read("files", "b.db", helper=self.room_helper(floor, free)).complete)
        self.assertEqual(self.scratch_left(), [])

    def test_scratch_emptied_at_start_and_kept_for_a_live_helper(self):
        self.write(".ma-export-tmp/c1-dead/db-1234", b"stale copy")
        self.write(".ma-export-tmp/stray", b"stray")
        self.mkdir(".ma-export-tmp/c2-live")
        fd = os.open(self.p(".ma-export-tmp/c2-live"), os.O_RDONLY | os.O_DIRECTORY)
        fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            self.make_db("files/a.db")
            self.read_ok("files", "a.db")
            self.assertEqual(sorted(os.listdir(self.p(".ma-export-tmp"))), ["c2-live"])
            self.assertEqual(stat.S_IMODE(os.stat(self.p(".ma-export-tmp")).st_mode), 0o700)
        finally:
            os.close(fd)
        self.call(op="parts")
        self.assertEqual(os.listdir(self.p(".ma-export-tmp")), [])
        self.assertNotIn(".ma-export-tmp", [p["part"] for p in self.call(op="parts").header["parts"]])


class TestReadable(Base):
    T1 = datetime.datetime(2026, 11, 6, 12, 0, 0, tzinfo=datetime.timezone.utc)
    T2 = datetime.datetime(2026, 11, 6, 13, 30, 15, 500000, tzinfo=datetime.timezone.utc)
    T3 = datetime.datetime(2026, 10, 1, 8, 0, 0, tzinfo=datetime.timezone.utc)

    def setUp(self):
        super().setUp()
        bookmarks = {
            "checksum": "0" * 32,
            "roots": {
                "bookmark_bar": {
                    "children": [
                        {"date_added": str(webkit(self.T1)), "guid": "g1", "id": "5", "name": "Example & <Co>",
                         "type": "url", "url": "https://example.com/?a=1&b=\"2\""},
                        {"children": [
                            {"date_added": str(webkit(self.T3)), "guid": "g3", "id": "7", "name": "Inner",
                             "type": "url", "url": "https://inner.example/"}],
                         "date_added": str(webkit(self.T3)), "date_modified": str(webkit(self.T1)), "guid": "g2",
                         "id": "6", "name": "Folder", "type": "folder"},
                    ],
                    "date_added": str(webkit(self.T3)), "date_modified": str(webkit(self.T1)), "guid": "b",
                    "id": "1", "name": "Bookmarks bar", "type": "folder"},
                "other": {"children": [{"date_added": str(webkit(self.T2)), "guid": "g4", "id": "8",
                                        "name": "Other one", "type": "url", "url": "https://other.example/"}],
                          "date_added": "0", "date_modified": "0", "guid": "o", "id": "2",
                          "name": "Other bookmarks", "type": "folder"},
                "synced": {"children": [], "date_added": "0", "date_modified": "0", "guid": "s", "id": "3",
                           "name": "Mobile bookmarks", "type": "folder"},
            },
            "version": 1,
        }
        self.write("browser/profile/Default/Bookmarks", json.dumps(bookmarks, indent=3))
        self.write("browser/profile/Profile 1/Bookmarks", json.dumps(
            {"roots": {"bookmark_bar": {"children": [], "name": "Bookmarks bar", "type": "folder"},
                       "other": {"children": []}, "synced": {"children": []}}, "version": 1}))
        self.mkdir("browser/profile/Crashpad")
        self.write("browser/profile/Crashpad/Bookmarks", b"{}")
        hist = self.p("browser/profile/Default/History")
        db = sqlite3.connect(hist, isolation_level=None)
        db.executescript("""
            CREATE TABLE urls(id INTEGER PRIMARY KEY AUTOINCREMENT, url LONGVARCHAR, title LONGVARCHAR,
              visit_count INTEGER DEFAULT 0 NOT NULL, typed_count INTEGER DEFAULT 0 NOT NULL,
              last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0 NOT NULL);
            CREATE TABLE visits(id INTEGER PRIMARY KEY AUTOINCREMENT, url INTEGER NOT NULL,
              visit_time INTEGER NOT NULL, from_visit INTEGER, transition INTEGER DEFAULT 0 NOT NULL,
              segment_id INTEGER, visit_duration INTEGER DEFAULT 0 NOT NULL);
            CREATE INDEX visits_time_index ON visits (visit_time);
        """)
        db.execute("INSERT INTO urls(id, url, title, last_visit_time) VALUES (1, 'https://example.com/', "
                   "'Example, \"quoted\"', 0)")
        db.execute("INSERT INTO urls(id, url, title, last_visit_time) VALUES (2, 'https://evil.example/', "
                   "'=HYPERLINK(\"http://x\")', 0)")
        db.execute("INSERT INTO urls(id, url, title, last_visit_time) VALUES (3, 'https://café.example/', "
                   "'Café ☕', 0)")
        for url, t in ((1, self.T3), (2, self.T1), (1, self.T2), (3, self.T1)):
            db.execute("INSERT INTO visits(url, visit_time) VALUES (?, ?)", (url, webkit(t)))
        db.close()

    def test_manifest_and_parts(self):
        entries = self.manifest("browser-readable")["entries"]
        self.assertEqual([e["path"] for e in entries],
                         ["Default", "Default/bookmarks.html", "Default/history.csv",
                          "Profile 1", "Profile 1/bookmarks.html"])
        self.assertEqual([e["type"] for e in entries], ["dir", "file", "file", "dir", "file"])
        self.assertEqual(self.all_paths("browser-readable", 2), [e["path"] for e in entries])
        part = [p for p in self.call(op="parts").header["parts"] if p["part"] == "browser-readable"][0]
        self.assertEqual(part["files"], 3)

    def test_bookmarks_html(self):
        r = self.read_ok("browser-readable", "Default/bookmarks.html")
        text = r.body.decode("utf-8")
        self.assertEqual(r.header["size"], len(r.body))
        s1, s2, s3 = (int(t.timestamp()) for t in (self.T1, self.T2, self.T3))
        self.assertTrue(text.startswith("<!DOCTYPE NETSCAPE-Bookmark-file-1>\n"))
        self.assertIn(f'    <DT><H3 ADD_DATE="{s3}" LAST_MODIFIED="{s1}" PERSONAL_TOOLBAR_FOLDER="true">'
                      "Bookmarks bar</H3>\n", text)
        self.assertIn(f'        <DT><A HREF="https://example.com/?a=1&amp;b=&quot;2&quot;" ADD_DATE="{s1}">'
                      "Example &amp; &lt;Co&gt;</A>\n", text)
        self.assertIn(f'        <DT><H3 ADD_DATE="{s3}" LAST_MODIFIED="{s1}">Folder</H3>\n', text)
        self.assertIn(f'            <DT><A HREF="https://inner.example/" ADD_DATE="{s3}">Inner</A>\n', text)
        self.assertIn(f'    <DT><A HREF="https://other.example/" ADD_DATE="{s2}">Other one</A>\n', text)
        self.assertNotIn("Mobile bookmarks", text)   # empty, so left out, as Chromium does
        self.assertTrue(text.endswith("</DL><p>\n"))
        self.assertEqual(text.count("<DL><p>"), text.count("</DL><p>"))
        again = self.read_ok("browser-readable", "Default/bookmarks.html", 100)
        self.assertEqual((again.digest, again.count), (r.digest, r.count))

    def test_history_csv(self):
        r = self.read_ok("browser-readable", "Default/history.csv")
        text = r.body.decode("utf-8")
        self.assertTrue(text.startswith("﻿"))
        rows = list(csv.reader(io.StringIO(text[1:])))
        self.assertEqual(rows, [
            ["visited_at", "title", "url"],
            ["2026-11-06T13:30:15Z", 'Example, "quoted"', "https://example.com/"],
            ["2026-11-06T12:00:00Z", "Café ☕", "https://café.example/"],
            ["2026-11-06T12:00:00Z", "'=HYPERLINK(\"http://x\")", "https://evil.example/"],
            ["2026-10-01T08:00:00Z", 'Example, "quoted"', "https://example.com/"],
        ])
        again = self.read_ok("browser-readable", "Default/history.csv", 10)
        self.assertEqual((again.digest, again.count), (r.digest, r.count))

    def test_history_while_chromium_has_it_locked(self):
        w = sqlite3.connect(self.p("browser/profile/Default/History"), isolation_level=None,
                            check_same_thread=False)
        self.writers.append(w)
        w.execute("PRAGMA locking_mode=EXCLUSIVE")
        w.execute("INSERT INTO visits(url, visit_time) VALUES (2, ?)", (webkit(self.T2) + 1_000_000,))
        time.sleep(0.1)
        rows = list(csv.reader(io.StringIO(self.read_ok("browser-readable", "Default/history.csv").body
                                           .decode("utf-8")[1:])))
        self.assertEqual(rows[1], ["2026-11-06T13:30:16Z", "'=HYPERLINK(\"http://x\")", "https://evil.example/"])
        self.assertEqual(len(rows), 6)

    def test_readable_refusals(self):
        for path in ("Default/Bookmarks", "Default/history.html", "Default", "Crashpad/bookmarks.html",
                     "Profile 1/history.csv", "Nope/bookmarks.html", "a/b/bookmarks.html"):
            with self.subTest(path=path):
                self.assertEqual(self.read("browser-readable", path).code, "not_found")
        self.assertEqual(self.read("browser-readable", "../browser/bookmarks.html").code, "invalid")
        os.symlink("/etc", self.p("browser/profile/Linked"))
        self.assertEqual(self.read("browser-readable", "Linked/bookmarks.html").code, "invalid")
        self.write("browser/profile/Broken/Bookmarks", b"{not json")
        self.assertEqual(self.read("browser-readable", "Broken/bookmarks.html").code, "failed")

    def test_stored_browser_readable_is_shadowed(self):
        self.write("browser-readable/x", b"stored")
        self.assertEqual(self.read("browser-readable", "x").code, "not_found")
        self.assertNotIn("x", self.all_paths("browser-readable"))


if __name__ == "__main__":
    unittest.main()
