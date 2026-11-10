#!/usr/bin/env python3
"""Writes deskd/src/test/resources/frames/vectors.json from the design's byte layout.

It shares nothing with the Java codec on purpose, so the vectors check that codec rather than copy it.
Usage: gen-frame-vectors.py <output path>
"""
import hashlib, json, struct, sys

KINDS = dict(HELLO=1, AUTH=2, ACTIVITY=3, PING=4, PONG=5, CLOSE=6, REQ=7, RES=8, ERR=9, SUB=10,
             UNSUB=11, EVT=12, CANCEL=13, DATA=14, CHUNK=15, CREDIT=16)
CHANNELS = dict(ctl=0, rpc=1, events=2, collab=3, mdoc=4, bulk=5)
MORE, BIN, END = 1, 2, 4
MAX_PAYLOAD = 16384 - 12

def frame(kind, flags, id_, seq, payload):
    return struct.pack(">BBBBII", 1, KINDS[kind], flags, 0, id_, seq) + payload

def flags_obj(flags):
    return dict(more=bool(flags & MORE), bin=bool(flags & BIN), end=bool(flags & END))

def valid(name, channel, meaning, kind, flags, id_, seq, payload):
    entry = dict(name=name, channel=channel, meaning=meaning, hex=frame(kind, flags, id_, seq, payload).hex(),
                 kind=kind, kindCode=KINDS[kind], flags=flags_obj(flags), id=id_, seq=seq)
    if flags & BIN:
        entry["payloadHex"] = payload.hex()
    else:
        entry["payloadText"] = payload.decode()
    return entry

def j(s):
    return s.encode()

fp = "ab" * 32
valid_vectors = [
    valid("hello-client", "ctl", "Client opens: first frame on ctl.", "HELLO", 0, 0, 0,
          j('{"deskApi":"1.0","appVersion":"0.1.0"}')),
    valid("hello-resume", "ctl", "Client resumes dropped state from a new session.", "HELLO", 0, 0, 0,
          j('{"deskApi":"1.0","appVersion":"0.1.0","resume":{"sessionId":"cs-m4k7q2x5v3a6b2c7","resumeToken":"3q2-7wABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhs"}}')),
    valid("hello-desk", "ctl", "deskd's answer.", "HELLO", 0, 0, 0,
          j('{"deskApi":"1.0","sessionId":"cs-m4k7q2x5v3a6b2c7","resumeToken":"3q2-7wABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhs","resumed":false,"serverTime":"2026-11-05T04:46:24Z","limits":{"maxFrameBytes":16384},"service":"deskd","version":"0.1.0","deskId":"d-testk3m7q2x","startedAt":"2026-11-05T04:40:00Z","runtime":"java-21"}')),
    valid("auth-refresh", "ctl", "A fresh desk token, used while the gateway is unreachable.", "AUTH", 0, 7, 0,
          j('{"deskToken":"eyJhbGciOiJFUzI1NiJ9.e30.c2ln"}')),
    valid("auth-ok", "ctl", "deskd accepted the fresh token.", "AUTH", 0, 7, 0,
          j('{"ok":true,"validUntil":"2026-11-05T04:51:54Z"}')),
    valid("activity", "ctl", "Input the client handled locally.", "ACTIVITY", 0, 0, 0,
          j('{"lastInputAt":"2026-11-05T04:46:20Z"}')),
    valid("ping", "ctl", "Liveness; id is the client's, and PONG echoes it.", "PING", 0, 42, 0, b""),
    valid("pong", "ctl", "Answer to ping 42.", "PONG", 0, 42, 0, b""),
    valid("close-expired", "ctl", "deskd closes: token expired.", "CLOSE", 0, 0, 0,
          j('{"code":4401,"reason":"token_expired"}')),
    valid("close-api", "ctl", "deskd closes: wrong deskApi major.", "CLOSE", 0, 0, 0,
          j('{"code":4426,"reason":"desk_api_mismatch","deskApi":"1.0"}')),
    valid("req-status", "rpc", "The skeleton RPC.", "REQ", 0, 1, 0, j('{"m":"desk.status.get","p":{}}')),
    valid("req-mutation", "rpc", "A mutation with an idempotency key and a deadline.", "REQ", 0, 2, 0,
          j('{"m":"notebook.page.rename","p":{"id":"p1","title":"x"},"idem":"01900000-0000-7000-8000-000000000001","deadlineMs":5000}')),
    valid("res-status", "rpc", "Result of request 1.", "RES", 0, 1, 0,
          j('{"deskId":"d-testk3m7q2x","deskdVersion":"0.1.0","rtcVersion":"0.1.0","bootId":"5f0c2e1a-8d3b-4f7e-9a6c-2b1d4e8f0a3c","uptimeSec":123,"javaVersion":"21.0.13","instanceType":"c7g.large"}')),
    valid("err-not-found", "rpc", "Request 3 failed.", "ERR", 0, 3, 0,
          j('{"code":"not_found","message":"No such method","details":{}}')),
    valid("cancel", "rpc", "Abort request 2. The id is the request's.", "CANCEL", 0, 2, 0, b""),
    valid("sub", "rpc", "Subscribe; id is a request id.", "SUB", 0, 4, 0, j('{"topic":"summary","params":{}}')),
    valid("sub-since", "rpc", "Subscribe again after a drop.", "SUB", 0, 5, 0,
          j('{"topic":"agent.run:r1","params":{},"since":41}')),
    valid("res-sub", "rpc", "Result of SUB 4: subscription 9.", "RES", 0, 4, 0, j('{"subId":9,"seq":0}')),
    valid("unsub", "rpc", "End subscription 9; id is a request id.", "UNSUB", 0, 6, 0, j('{"subId":9}')),
    valid("evt-snapshot", "events", "First event of subscription 9.", "EVT", 0, 9, 1,
          j('{"type":"snapshot","data":{"badges":3}}')),
    valid("evt-patch", "events", "Next event of subscription 9.", "EVT", 0, 9, 2,
          j('{"type":"patch","data":{"badges":4}}')),
    valid("evt-resync", "events", "The client fell behind on a stream: subscribe again with since.", "EVT", 0, 9, 2,
          j('{"type":"resync","data":{}}')),
    valid("data-bin", "mdoc", "Raw bytes.", "DATA", BIN, 11, 0, bytes.fromhex("deadbeef")),
    valid("chunk", "bulk", "Chunk 3 of transfer 12.", "CHUNK", BIN, 12, 3, bytes.fromhex("00ff10")),
    valid("chunk-end", "bulk", "Last chunk of transfer 12.", "CHUNK", BIN | END, 12, 4, bytes.fromhex("20")),
    valid("transfer-credit", "bulk", "Receiver lets transfer 12 send 1 MiB more.", "CREDIT", 0, 12, 0, j('{"bytes":1048576}')),
    valid("max-u32", "rpc", "id and seq are unsigned 32-bit.", "EVT", 0, 4294967295, 4294967295, j("{}")),
    valid("full-frame", "bulk", "The largest frame: 16 KiB, of which 16372 are payload.", "CHUNK", BIN, 1, 0, bytes(MAX_PAYLOAD)),
]

def invalid(name, why, data):
    return dict(name=name, why=why, hex=data.hex())

invalid_vectors = [
    invalid("short", "Shorter than the 12-byte header.", bytes.fromhex("0101000000000000000000")),
    invalid("empty", "No bytes at all.", b""),
    invalid("version-0", "ver must be 1.", bytes.fromhex("000100000000000000000000")),
    invalid("version-2", "ver must be 1.", bytes.fromhex("020100000000000000000000")),
    invalid("reserved-set", "The reserved byte must be 0.", bytes.fromhex("010100010000000000000000")),
    invalid("unknown-flag", "Only bits 0 to 2 of flags exist.", bytes.fromhex("010108000000000000000000")),
    invalid("oversize", "One byte over 16 KiB.", struct.pack(">BBBBII", 1, 15, 2, 0, 1, 0) + bytes(MAX_PAYLOAD + 1)),
]

def message(name, meaning, kind, flags, id_, seq, payload):
    frames = []
    off = 0
    shared = flags & BIN
    while True:
        part = payload[off:off + MAX_PAYLOAD]
        off += len(part)
        last = off >= len(payload)
        frames.append(frame(kind, flags if last else shared | MORE, id_, seq, part).hex())
        if last:
            break
    return dict(name=name, meaning=meaning, kind=kind, flags=flags_obj(flags), id=id_, seq=seq,
                payloadLength=len(payload), payloadSha256=hashlib.sha256(payload).hexdigest(), frames=frames)

pattern = bytes(i % 251 for i in range(MAX_PAYLOAD + 1))
exact = bytes(i % 251 for i in range(MAX_PAYLOAD))
messages = [
    message("two-frames", "One byte too many for one frame: 16372 + 1. MORE on the first frame, END only on the last, and the same id and seq on both.", "DATA", BIN | END, 22, 9, pattern),
    message("empty", "An empty message is one frame.", "PING", 0, 24, 0, b""),
]

out = dict(
    description="Golden frame vectors for design 4.2.4. deskd's tests check its encoder and decoder against every byte here; the TypeScript client should do the same.",
    layout="byte 0 ver=1, byte 1 kind, byte 2 flags (bit 0 MORE, bit 1 BIN, bit 2 END), byte 3 reserved=0, bytes 4-7 id u32be, bytes 8-11 seq u32be, then the payload. At most 16384 bytes.",
    kinds=KINDS,
    channels=CHANNELS,
    valid=valid_vectors,
    invalid=invalid_vectors,
    messages=messages,
)
json.dump(out, open(sys.argv[1], "w"), indent=2)
print(len(valid_vectors), len(invalid_vectors), len(messages))
