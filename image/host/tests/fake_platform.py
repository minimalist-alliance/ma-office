#!/usr/bin/python3 -I
"""fake_platform.py: a stand-in for Platform's three host-link routes (ma-platform contract shared-host.md sections 3 to 5,
as services/desks/src/hostlink.ts answers them), for desk-host-link's tests (test_link.py) and a test host in
image/host/verify.sh. Never on an image.

  python3 -I fake_platform.py --port <p> --state <state.json> --log <requests.jsonl> [--key AK:SK ...]

Every request's SigV4 is checked against the key its Authorization names, which must be one given (desk-host-link's fixed
loopback test key always is): an unknown key or a wrong signature is 403 "signature". The state file is read again at every request, so a test edits it to move things on:

  {"hostId": "i-...", "env": "staging", "desksPerHost": 6, "reportSeconds": 30, "refreshAfterSeconds": 600,
   "slots": {"1": {"deskId": "d-..." | null, "volumeId": "vol-..." | null, "privateIp": "...", "allocationId": "eipalloc-...",
                   "publicIp": "...", "epoch": 1, "want": "running" | "stopped", "userId": "...", "deskKind": "test"}},
   "sessionStatus": {"1": 409},      optional: slot-session answers this instead
   "helloStatus": 500,               optional: hello answers this
   "forgetHello": true,              optional: every report is told hello_required
   "extraOrders": [...]}             optional: sent with every report as they are

Orders follow hostlink.ts orderFor: an empty slot reported stopped or unmounted is prepare_slot; a desk wanted running and
not starting or running is start_slot; a desk wanted stopped and starting or running is stop_slot (idle). A reported slot
whose desk or epoch isn't the state's is ignored, as Platform ignores and flags it. Each request is one JSON line in the log.
"""
import argparse
import datetime
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.dont_write_bytecode = True
LIB = os.environ.get("DESK_HOST_LIB", os.path.join(os.path.dirname(os.path.abspath(__file__)), "../recipe/files/usr/local/lib/desk-host"))
sys.path.insert(0, LIB)
import sigv4  # noqa: E402

LOCK = threading.Lock()
HELLO = {}   # the last hello's bootId


def error(code):
    return {"error": {"code": code, "message": code, "requestId": "fake", "retryable": False}}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        return status

    def signed_ok(self, body):
        auth = self.headers.get("authorization", "")
        amz = self.headers.get("x-amz-date", "")
        try:
            now = datetime.datetime.strptime(amz, "%Y%m%dT%H%M%SZ").replace(tzinfo=datetime.timezone.utc)
            signed = auth.split("SignedHeaders=")[1].split(",")[0].split(";")
            ak = auth.split("Credential=")[1].split("/")[0]
            sk = KEYS[ak]
        except (ValueError, IndexError, KeyError):
            return False
        hdrs = {n: self.headers.get(n, "") for n in signed if n not in ("host", "x-amz-date", "x-amz-security-token")}
        want = sigv4.sign("POST", f"http://{self.headers.get('host')}{self.path}", hdrs, body, "execute-api", "us-east-1",
                          ak, sk, self.headers.get("x-amz-security-token"), now=now)
        return want["authorization"] == auth

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0") or 0))
        try:
            st = json.load(open(ARGS.state))
            body = json.loads(raw or b"{}")
        except ValueError:
            return self.done(self.reply(400, error("invalid_request")), {})
        if not self.signed_ok(raw):
            return self.done(self.reply(403, error("signature")), body)
        route = self.path
        if route == "/v1/host/hello":
            status, out = self.hello(st, body)
        elif route == "/v1/host/report":
            status, out = self.report(st, body)
        elif route == "/v1/host/slot-session":
            status, out = self.session(st, body)
        else:
            status, out = 404, error("not_found")
        self.done(self.reply(status, out), body, out)

    def done(self, status, body, out=None):
        with LOCK, open(ARGS.log, "a") as f:
            f.write(json.dumps({"route": self.path, "status": status, "body": body, "reply": out,
                                "token": self.headers.get("x-amz-security-token")}) + "\n")

    def slots(self, st):
        return [{"k": int(k), "deskId": s.get("deskId"), "volumeId": s.get("volumeId"), "privateIp": s["privateIp"],
                 "allocationId": s["allocationId"], "publicIp": s["publicIp"], "epoch": s["epoch"]} for k, s in sorted(st["slots"].items(), key=lambda x: int(x[0]))]

    def hello(self, st, body):
        if st.get("helloStatus"):
            return st["helloStatus"], error("fake_hello")
        if body.get("instanceId") != st["hostId"]:
            return 403, error("host_mismatch")
        with LOCK:
            HELLO["bootId"] = body.get("bootId")
        return 200, {"hostId": st["hostId"], "env": st.get("env", "staging"), "reportSeconds": st.get("reportSeconds", 30),
                     "desksPerHost": st.get("desksPerHost", 6), "slots": self.slots(st)}

    def report(self, st, body):
        with LOCK:
            known = HELLO.get("bootId")
        if st.get("forgetHello") or not known or body.get("bootId") != known:
            return 200, {"hostId": st["hostId"], "reportSeconds": st.get("reportSeconds", 30), "orders": [], "actions": ["hello_required"]}
        orders = []
        for s in body.get("slots", []):
            k = s.get("k")
            rec = st["slots"].get(str(k))
            if not rec or rec.get("deskId") != s.get("deskId") or rec.get("epoch") != s.get("epoch"):
                continue
            state, e = s.get("state"), rec["epoch"]
            if not rec.get("deskId"):
                if state in ("stopped", "unmounted"):
                    orders.append({"id": f"prepare_slot:{k}:{e}", "op": "prepare_slot", "k": k, "epoch": e})
            elif rec.get("want") == "running" and state not in ("starting", "running"):
                orders.append({"id": f"start_slot:{k}:{e}", "op": "start_slot", "k": k, "deskId": rec["deskId"], "epoch": e})
            elif rec.get("want") == "stopped" and state in ("starting", "running"):
                orders.append({"id": f"stop_slot:{k}:{e}", "op": "stop_slot", "k": k, "deskId": rec["deskId"], "epoch": e, "reason": "idle"})
        return 200, {"hostId": st["hostId"], "reportSeconds": st.get("reportSeconds", 30), "orders": orders + st.get("extraOrders", []), "actions": []}

    def session(self, st, body):
        k, epoch = body.get("slot"), body.get("epoch")
        rec = st["slots"].get(str(k))
        if str(k) in st.get("sessionStatus", {}):
            return st["sessionStatus"][str(k)], error("fake_session")
        if not rec or not rec.get("deskId") or rec.get("epoch") != epoch:
            return 409, error("placement_changed")
        if rec.get("want") != "running":
            return 409, error("slot_not_started")
        exp = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=15)).strftime("%Y-%m-%dT%H:%M:%SZ")
        n = rec.get("sessions", 0)
        return 200, {"deskId": rec["deskId"], "epoch": epoch, "userId": rec.get("userId", "u-fake"), "deskKind": rec.get("deskKind", "test"),
                     "env": st.get("env", "staging"), "publicIp": rec.get("sessionPublicIp", rec["publicIp"]),
                     "credentials": {"accessKeyId": f"ASIAFAKESLOT{k}E{epoch}", "secretAccessKey": f"fake-secret-slot-{k}-{epoch}-{n}",
                                     "sessionToken": f"fake-token-slot-{k}-{epoch}", "expiration": exp},
                     "refreshAfterSeconds": st.get("refreshAfterSeconds", 600),
                     "endpoints": {"api": "https://api.example.invalid", "gateway": "wss://gw.example.invalid/v1"}}


def main():
    global ARGS
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, required=True)
    p.add_argument("--state", required=True)
    p.add_argument("--log", required=True)
    p.add_argument("--key", action="append", default=[], help="AK:SK, a key whose signatures are taken")
    ARGS = p.parse_args()
    for kv in ARGS.key:
        ak, sk = kv.split(":", 1)
        KEYS[ak] = sk
    srv = ThreadingHTTPServer(("127.0.0.1", ARGS.port), H)
    srv.daemon_threads = True
    print(f"fake Platform on 127.0.0.1:{ARGS.port}", flush=True)
    srv.serve_forever()


ARGS = None
KEYS = {"AKIDDESKHOSTLINKTEST": "desk-host-link-local-test-secret"}   # desk-host-link's loopback test key (LOCAL_TEST_KEY)
if __name__ == "__main__":
    main()
