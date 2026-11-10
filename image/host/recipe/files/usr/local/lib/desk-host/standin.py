"""standin.py: a placed desk's metadata stand-in, one per running slot, inside desk-host-link (ma-platform contract
shared-host.md section 5; ADR 0072 Platform's side, IN-03 and IN-04). Python 3 standard library only.

A desk on a shared host has no instance of its own, so nothing of the host's IMDS may reach it: the host drops every packet
a desk sends to 169.254.169.254 but one, TCP 80 from the slot's own address, which desk-host DNATs on the slot's veth to
this listener on the host's end of that veth (10.98.<k>.1:<STANDIN_PORT>). The listener is bound to that address only and
answers only the slot's own address (10.98.<k>.2), so no slot reaches another's, and the host's ruleset takes a
connection to it only when its original destination was the metadata address (desk-host's in_<k> chain).

What it serves, IMDSv2 as deskd and desk-kind read it (a token from PUT, then reads with it):
  instance-id                         the desk ID (as a self-hosted desk's is; the agent API takes it so for a placed desk)
  placement/region                    the host's region
  public-ipv4                         the slot's public address (from slot-session, equal to the hello's)
  instance-type                       "shared-host"
  tags/instance and its DeskId, UserId, DeskKind, Env   from slot-session's reply, never the host's tags
  iam/security-credentials/[<role>]   the slot's 15-minute credentials from slot-session
Anything else is 404, and so is everything before the slot's first session. Nothing it holds is written anywhere: the
credentials live in this process's memory only, never on the desk's volume or the host's disks.
"""
import datetime
import json
import secrets
import socket
import socketserver
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

IP_FREEBIND = getattr(socket, "IP_FREEBIND", 15)
TOKEN_MAX_TTL = 21600
MAX_TOKENS = 64
MAX_CONNS = 16
ROLE = "ma-shared-desk"   # what deskd sees under iam/security-credentials/; the real role is Platform's
PREFIX = "/latest/meta-data/"


def _iso(t):
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, handler, standin):
        self.standin = standin
        self.slots = threading.BoundedSemaphore(MAX_CONNS)
        super().__init__(addr, handler, bind_and_activate=False)
        self.socket.setsockopt(socket.SOL_IP, IP_FREEBIND, 1)   # bound before desk-host makes the veth that carries the address
        self.server_bind()
        self.server_activate()

    def server_bind(self):   # HTTPServer's would look the address up in DNS (getfqdn) before a desk could start
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

    def verify_request(self, request, client_address):
        # Only the slot's own address, on this slot's own listener (the host's in_<k> chain is the first check)
        try:
            local = request.getsockname()[0]
        except OSError:
            return False
        return client_address[0] == self.standin.peer and local == self.standin.bind_ip

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


class _Handler(BaseHTTPRequestHandler):
    server_version = "EC2ws"
    sys_version = ""
    timeout = 5
    protocol_version = "HTTP/1.0"

    def log_message(self, *a):   # paths, tokens and credentials stay out of the journal
        pass

    def send(self, code, body=b"", ctype="text/plain"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_PUT(self):
        si = self.server.standin
        if self.path != "/latest/api/token" or self.headers.get("X-Forwarded-For") is not None:
            return self.send(404 if self.path != "/latest/api/token" else 403)
        try:
            ttl = int(self.headers.get("X-aws-ec2-metadata-token-ttl-seconds", ""))
        except ValueError:
            return self.send(400)
        if not 1 <= ttl <= TOKEN_MAX_TTL:
            return self.send(400)
        tok = secrets.token_urlsafe(32)
        with si.lock:
            now = time.monotonic()
            si.tokens = {t: e for t, e in si.tokens.items() if e > now}
            if len(si.tokens) >= MAX_TOKENS:
                return self.send(503)
            si.tokens[tok] = now + ttl
        self.send(200, tok.encode())

    def do_GET(self):
        si = self.server.standin
        tok = self.headers.get("X-aws-ec2-metadata-token", "")
        with si.lock:
            ok = bool(tok) and si.tokens.get(tok, 0) > time.monotonic()
            sess = si.session
        if not ok:
            return self.send(401)
        if not sess:
            return self.send(404)   # deskd asks again until the slot's first session is in
        p = self.path
        tags = {"DeskId": sess["deskId"], "UserId": sess["userId"], "DeskKind": sess["deskKind"], "Env": sess["env"]}
        values = {PREFIX + "instance-id": sess["deskId"], PREFIX + "placement/region": si.region,
                  PREFIX + "public-ipv4": sess["publicIp"], PREFIX + "instance-type": "shared-host",
                  PREFIX + "tags/instance": "\n".join(sorted(tags)), PREFIX + "iam/security-credentials/": ROLE}
        for name, v in tags.items():
            values[PREFIX + "tags/instance/" + name] = v
        if p in values and values[p]:
            return self.send(200, values[p].encode())
        if p == PREFIX + "iam/security-credentials/" + ROLE:
            c = sess["credentials"]
            body = {"Code": "Success", "LastUpdated": _iso(sess["at"]), "Type": "AWS-HMAC", "AccessKeyId": c["accessKeyId"],
                    "SecretAccessKey": c["secretAccessKey"], "Token": c["sessionToken"], "Expiration": c["expiration"]}
            return self.send(200, json.dumps(body).encode(), "application/json")
        self.send(404)

    def do_HEAD(self):
        self.send(405)

    do_POST = do_DELETE = do_PATCH = do_HEAD


class StandIn:
    """Slot k's stand-in: listen on bind_ip:port, answer peer only. set_session() and clear() swap what it serves."""

    def __init__(self, k, bind_ip, port, peer, region):
        self.k, self.bind_ip, self.port, self.peer, self.region = k, bind_ip, port, peer, region
        self.lock = threading.Lock()
        self.tokens = {}
        self.session = None
        self.srv = None

    def start(self):
        if self.srv is None:
            self.srv = _Server((self.bind_ip, self.port), _Handler, self)
            threading.Thread(target=self.srv.serve_forever, kwargs={"poll_interval": 0.5}, daemon=True).start()

    def set_session(self, reply):
        """reply: slot-session's 200 body, already checked by the link."""
        s = {k: reply[k] for k in ("deskId", "userId", "deskKind", "env", "publicIp")}
        s["credentials"] = {k: reply["credentials"][k] for k in ("accessKeyId", "secretAccessKey", "sessionToken", "expiration")}
        s["at"] = time.time()
        with self.lock:
            self.session = s

    def clear(self):
        with self.lock:
            self.session = None
            self.tokens = {}

    def stop(self):
        self.clear()
        if self.srv is not None:
            self.srv.shutdown()
            self.srv.server_close()
            self.srv = None
