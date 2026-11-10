#!/usr/bin/env python3
"""A stand-in for IMDS, to run deskd by hand against gateway-shim. Never for a real desk.

Defaults match gateway-shim's desk and owner. Point deskd at it with DESKD_IMDS_URL. The shim checks no
signature, so the credentials here are fixed nonsense.
"""
import argparse
import datetime
import http.server
import json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8788)
    parser.add_argument("--desk-id", default="d-dev0000000000")
    parser.add_argument("--owner-id", default="00000000-0000-4000-8000-000000000001")
    parser.add_argument("--public-ip", default="127.0.0.1")
    parser.add_argument("--env", default="staging")
    args = parser.parse_args()

    role = "ma-desk-" + args.desk_id
    values = {
        "/latest/meta-data/tags/instance/DeskId": args.desk_id,
        "/latest/meta-data/tags/instance/UserId": args.owner_id,
        "/latest/meta-data/tags/instance/DeskKind": "test",
        "/latest/meta-data/tags/instance/Env": args.env,
        "/latest/meta-data/instance-id": "i-0123456789abcdef0",
        "/latest/meta-data/public-ipv4": args.public_ip,
        "/latest/meta-data/instance-type": "local",
        "/latest/meta-data/ami-id": "ami-local",
        "/latest/meta-data/iam/security-credentials/": role,
    }

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_):
            pass

        def reply(self, status, body):
            data = body.encode()
            self.send_response(status)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_PUT(self):
            self.reply(200, "local-imds-token")

        def do_GET(self):
            if self.path == "/latest/meta-data/iam/security-credentials/" + role:
                expires = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=6)
                self.reply(200, json.dumps({
                    "Code": "Success",
                    "AccessKeyId": "ASIALOCALLOCALLOCAL",
                    "SecretAccessKey": "not-a-secret",
                    "Token": "not-a-token",
                    "Expiration": expires.strftime("%Y-%m-%dT%H:%M:%SZ"),
                }))
            elif self.path in values:
                self.reply(200, values[self.path])
            else:
                self.reply(404, "")

    http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
