#!/usr/bin/python3 -I
"""demuxprobe.py <host address> <port> <case> [<slot>]: one ordinary TCP connection to a shared host's 443, as a client on
the internet makes it, and what the host did with it: "closed <ms>" (reset or EOF, and when), "open <ms>" (still open when
the wait ran out), or "answered <n> bytes". TEST ONLY: one connection per call, never a flood. Cases:
  http      an HTTP request              tls      a TLS ClientHello's first bytes
  silent    nothing                      half     half a STUN header
  noslot    a binding request whose ufrag names no slot ("cmns...")
  slot      a binding request for slot <slot>, signed with no session's password (the slot's desk-rtc closes it, or no slot runs)
"""
import binascii
import socket
import struct
import sys
import time


def request(ufrag):
    user = (ufrag + ":clnt").encode()
    attrs = struct.pack("!HH", 0x0006, len(user)) + user + b"\0" * ((4 - len(user) % 4) % 4)
    attrs += struct.pack("!HH", 0x0008, 20) + b"\0" * 20   # MESSAGE-INTEGRITY with no session's key
    hdr = struct.pack("!HHI", 0x0001, len(attrs) + 8, 0x2112A442) + b"0123456789ab"
    crc = (binascii.crc32(hdr + attrs) ^ 0x5354554E) & 0xFFFFFFFF
    msg = hdr + attrs + struct.pack("!HHI", 0x8028, 4, crc)
    return struct.pack("!H", len(msg)) + msg


def main():
    host, port, case = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    slot = int(sys.argv[4]) if len(sys.argv) > 4 else 1
    first = {"http": b"GET / HTTP/1.1\r\nHost: x\r\n\r\n", "tls": bytes.fromhex("160301020001000001fc0303"), "silent": b"",
             "half": request(f"s{slot:02d}AbCdEfGhIjKlM")[:10], "noslot": request("cmnsAbCdEfGhIjKl"),
             "slot": request(f"s{slot:02d}AbCdEfGhIjKlM")}[case]
    s = socket.create_connection((host, port), timeout=5)
    t0 = time.monotonic()
    if first:
        s.sendall(first)
    s.settimeout(float(sys.argv[5]) if len(sys.argv) > 5 else 8.0)
    try:
        d = s.recv(2048)
        print(f"answered {len(d)} bytes" if d else f"closed {(time.monotonic() - t0) * 1000:.0f}")
    except ConnectionResetError:
        print(f"closed {(time.monotonic() - t0) * 1000:.0f}")
    except socket.timeout:
        print(f"open {(time.monotonic() - t0) * 1000:.0f}")
    finally:
        s.close()


if __name__ == "__main__":
    main()
