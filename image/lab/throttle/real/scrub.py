#!/usr/bin/python3 -I
"""scrub.py <results dir> <evidence dir> <state.env>: TEST ONLY. Copies real.sh's results into the repo's evidence folder with
every address of the lab's boxes, any private or link-local address and any SDP candidate's address replaced by <addr>, then
lists any dotted quad left so a person can see it is a version, not an address."""
import os
import re
import shutil
import sys

src, dst, state = sys.argv[1], sys.argv[2], sys.argv[3]
known = set()
for line in open(state):
    k, _, v = line.strip().partition("=")
    if k in ("DESK_IP", "DESK_PRIV", "CLIENT_IP", "CLIENT_PRIV") and v:
        known.add(v)
QUAD = re.compile(r"(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])")
PRIVATE = re.compile(r"^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|127\.)")
CAND = re.compile(r"(candidate:\S+ \d \S+ \d+ )(\S+)( \d+ typ)")


def scrub(text):
    text = CAND.sub(lambda m: m.group(1) + "<addr>" + m.group(3), text)
    return QUAD.sub(lambda m: "<addr>" if m.group(1) in known or PRIVATE.match(m.group(1)) else m.group(1), text)


left = set()
for root, _, files in os.walk(src):
    for f in files:
        a = os.path.join(root, f)
        b = os.path.join(dst, os.path.relpath(a, src))
        os.makedirs(os.path.dirname(b), exist_ok=True)
        try:
            t = scrub(open(a).read())
        except UnicodeDecodeError:
            shutil.copy(a, b)
            continue
        open(b, "w").write(t)
        left.update(QUAD.findall(t))
print("dotted quads left (versions?):", sorted(left))
