#!/usr/bin/python3 -I
"""make_template_artifact.py: a TEST artifact for a shared host's template fetch (ADR 0077 1.1), from a tree on disk, signed with a
throwaway P-256 key. For test_templates.py and a lab host only; never on an image, never the builder (tools/template/ is).

  make_template_artifact.py --tree <dir> --gen g2 --host-image <version> --base <sha256 of g1's manifest> --key <private.pem>
                            --out <dir> [--urgent] [--plan <file>] [--level 10] [--tamper archive|header] [--extra <name>]

Writes to <dir>: template.tar.zst (GNU tar of the tree, numeric owners, pax with security.capability, set-id bits cleared, zstd at a
middle level with no long window), manifest.json (templates.manifest_of, modes as packed), plan.txt, header.json, header.sig (DER).
--tamper archive changes one byte of the archive after the header is written; --extra adds a file the manifest doesn't list.
Prints the header's SHA-256 (the order's sha256).
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.environ.get("DESK_HOST_LIB", os.path.join(HERE, "../recipe/files/usr/local/lib/desk-host")))
import templates  # noqa: E402


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--tree", required=True)
    p.add_argument("--gen", required=True)
    p.add_argument("--host-image", required=True)
    p.add_argument("--base", required=True)
    p.add_argument("--key", default=None)
    p.add_argument("--out", required=True)
    p.add_argument("--urgent", action="store_true")
    p.add_argument("--plan", default=None)
    p.add_argument("--level", default="10")
    p.add_argument("--tamper", choices=("archive", "header"), default=None)
    p.add_argument("--extra", default=None)
    p.add_argument("--chromium", default=None, help="the header's chromium, if not the tree's")
    p.add_argument("--no-sign", action="store_true", help="leave header.sig to be made elsewhere (the dev key stays off the box)")
    a = p.parse_args()
    os.makedirs(a.out, exist_ok=True)
    t0 = time.monotonic()
    man = json.loads(templates.manifest_of(a.tree))
    for e in man["entries"]:
        if e["type"] != "link":
            e["mode"] &= ~0o6000   # packed with set-id bits cleared, recorded as packed
    man_bytes = templates.canonical(man)
    with open(f"{a.out}/manifest.json", "wb") as f:
        f.write(man_bytes)
    t1 = time.monotonic()
    arc = f"{a.out}/template.tar.zst"
    tar = ["tar", "-C", a.tree, "--numeric-owner", "--format=pax", "--xattrs", "--xattrs-include=security.capability", "--mode=u-s,g-s",
           "--exclude=./.complete", "--sort=name", "-cf", "-", "."]
    if a.extra:
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, a.extra), "w") as f:
                f.write("not in the manifest\n")
            tar = tar[:-1] + [".", "-C", d, a.extra]
            subprocess.run(f"{' '.join(map(repr, tar))} | zstd -q -{a.level} -T0 -o {arc!r} -f", shell=True, check=True)
    else:
        subprocess.run(f"{' '.join(map(repr, tar))} | zstd -q -{a.level} -T0 -o {arc!r} -f", shell=True, check=True)
    t2 = time.monotonic()
    plan = open(a.plan, "rb").read() if a.plan else b""
    with open(f"{a.out}/plan.txt", "wb") as f:
        f.write(plan)
    files = {}
    for name in templates.FILES:
        files[name] = {"size": os.path.getsize(f"{a.out}/{name}"), "sha256": templates.sha256_file(f"{a.out}/{name}")}
    ch = a.chromium or templates.chromium_of(a.tree)
    header = {"format": templates.FORMAT, "gen": a.gen, "hostImage": a.host_image, "created": templates.utc(), "urgent": a.urgent,
              "chromium": ch, "base": a.base, "files": files}
    hb = templates.canonical(header)
    with open(f"{a.out}/header.json", "wb") as f:
        f.write(hb)
    if not a.no_sign:
        subprocess.run(["openssl", "dgst", "-sha256", "-sign", a.key, "-out", f"{a.out}/header.sig", f"{a.out}/header.json"], check=True)
    if a.tamper == "archive":
        with open(arc, "r+b") as f:
            f.seek(os.path.getsize(arc) // 2)
            b = f.read(1)
            f.seek(-1, 1)
            f.write(bytes([b[0] ^ 0x01]))
    if a.tamper == "header":
        with open(f"{a.out}/header.json", "ab") as f:
            f.write(b" ")
    print(templates.sha256_bytes(hb))
    print(json.dumps({"manifest_s": round(t1 - t0, 1), "pack_s": round(t2 - t1, 1), "archive": files["template.tar.zst"]["size"],
                      "manifest": files["manifest.json"]["size"], "paths": len(man["entries"]),
                      "bytes": sum(e.get("size", 0) for e in man["entries"])}), file=sys.stderr)


if __name__ == "__main__":
    main()
