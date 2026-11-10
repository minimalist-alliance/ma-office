#!/usr/bin/python3 -I
"""desk-dns: a stub resolver on 127.0.0.53:53 inside one desk, for desk-agent-filter only (ADR 0072 section 2; the shared-host image).
On a desk of its own systemd-resolved is the stub the filter asks (desk-agent-filter/main.go, stubAddr). There's no
systemd in the wall, so this relays each UDP query to the VPC's resolver and the answer back. It has no Varlink or other
socket a desk uid could use to add names (WALL-06's point about resolved), and the image's firewall lets only uid 1106
reach it on 53. desk-init runs it under the unit filter, as desk-dns, with CAP_NET_BIND_SERVICE only.
"""
import socket
import threading

UPSTREAM = ("169.254.169.253", 53)
srv = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
srv.bind(("127.0.0.53", 53))


def answer(query, client):
    up = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    up.settimeout(4)
    try:
        up.sendto(query, UPSTREAM)
        srv.sendto(up.recv(65535), client)
    except OSError:
        pass
    finally:
        up.close()


while True:
    q, c = srv.recvfrom(65535)
    threading.Thread(target=answer, args=(q, c), daemon=True).start()
