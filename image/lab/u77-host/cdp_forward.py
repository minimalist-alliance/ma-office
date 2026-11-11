"""cdp_forward.py: a TEST HOST's CDP forward (WR2-01), loaded by desk-init only when the host says so (/run/desk-host/test-cdp)
and only from /desk-host-test, which only a test host mounts. Never in the image (image/host/verify.sh checks).

It lets the test harness on the host reach Chromium's 127.0.0.1:9222 (which only root and deskd may connect to) from the host's
side of the veth: it listens on the desk's own address, port 19222, and takes a connection only from 10.98.<k>.1, the host's
side; anything else is closed at once. Inside the desk, desk-host's rule rejects every new connection to port 19222 from any
uid (table inet deskhost), so no desk process reaches it either way; WR2-01's gate check shows both.
"""
import socket
import threading


def serve(k, log):
    host = f"10.98.{k}.1"
    srv = socket.create_server((f"10.98.{k}.2", 19222))

    def pipe(a, b):
        try:
            while True:
                d = a.recv(65536)
                if not d:
                    break
                b.sendall(d)
        except OSError:
            pass
        for x in (a, b):
            try:
                x.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    while True:
        c, peer = srv.accept()
        if peer[0] != host:
            log(f"cdp forward: refused {peer[0]} (only the host's side, {host})")
            c.close()
            continue
        try:
            u = socket.create_connection(("127.0.0.1", 9222), timeout=5)
            u.settimeout(None)
        except OSError:
            c.close()
            continue
        threading.Thread(target=pipe, args=(c, u), daemon=True).start()
        threading.Thread(target=pipe, args=(u, c), daemon=True).start()
