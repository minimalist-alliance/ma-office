# Runbook: build and sign a shared-host template generation

**Who:** the System Engineer, who owns the template (ADR 0077 sections 1.2 and 6, PU-5). **When:** about weekly per host-image
version still in the fleet, when `trixie-security` has something newer for the template, and at once for an urgent fix
(ADR 0077 section 5). **What it makes:** one signed artifact under `desk/host-template/<host image>/<gen>/` in the release bucket,
which Platform's targets name (PU-3) and member hosts fetch (1.4). Nothing here touches a desk, a member host, prod, or any
`host_image` or `desk_image` setting.

## Before you start
- `head -1 ~/ma-coord/USAGE-GATE.md` reads `OPEN`.
- The host AMI the generation is for: `aws ec2 describe-images --owners self --filters Name=tag:HostKind,Values=shared --query 'Images[].[ImageId,Name,CreationDate]' --output table`.
  One generation per host-image version still in the fleet (1.2): a generation is built on its own AMI and never chains on another.
- The next `gen` for that version: one above the newest under `s3://<release bucket>/desk/host-template/<version>/` (`aws s3 ls`). The bake is `g1`.
- Node 24 at `~/.local/node-v24` and `e2e/node_modules` (`cd e2e && npm ci`): the slot start runs `browser-session.spec.ts` from here.
- Your AWS credentials can sign with `alias/ma-host-template` (Platform's, PU-9; `kms:Sign` is the System Engineer's role's only).

## 1. Build (about 15 minutes and $0.04; 23 minutes and $0.07 with `--mutations`; measured on host 0.1.10, 2026-11-11)
```bash
OWNER_TAG=syseng-template image/host/template-build.sh <host AMI> --gen <gN> [--urgent]
```
It takes `~/work/.aws-bake.lock` (it waits up to an hour for it), launches an `m7g.xlarge` from the AMI (`Purpose=desk-image-build`, no instance role, SSH from this
workstation only, a power-off after 150 minutes whatever happens), runs every step of 1.2 and every check of 1.3 on it, uploads the
artifact through presigned PUT URLs that carry each file's SHA-256, and terminates the builder on exit, then lists what's left by
your `OWNER_TAG` (it must be nothing).
- **Exit 3, "PLAN EMPTY":** `trixie-security` has nothing newer for the template than the bake. Nothing is built; nothing to do.
- **Exit 1:** a step failed closed. Nothing was signed, and nothing was uploaded unless the upload itself was the step. The run's
  records are in `image/host/evidence/template-build-<ami>-<gen>/` (`run.txt`, `checks.jsonl`, `state.json`): each check says what
  it found. A `nothing-else` failure names the paths a maintainer script wrote outside its package: decide whether that's a new
  trigger cache to allow (`ALLOWED_PREFIXES` in `image/host/template-builder/tb.py`, with a test) or a package that waits for a
  host image. Kept-back packages are listed in `plan`: they need a stable point release and wait for a host image.
- **Exit 0:** the artifact is at `s3://<bucket>/desk/host-template/<version>/<gN>/`, with `passed-build.json`. An artifact is
  never replaced: the script refuses a prefix that isn't empty, before it launches anything.
- **Never stop it with a SIGKILL** (a task manager's stop does that): its trap is what terminates the builder. If it was killed, see
  "If something is left running" below; the builder powers itself off after `--keep-minutes` anyway.

## 2. Sign (on the workstation, never the builder)
```bash
tools/template/template-sign s3://<bucket>/desk/host-template/<version>/<gN>/ --kms-key-id alias/ma-host-template
```
It refuses unless S3's own stored SHA-256 of `template.tar.zst`, `manifest.json` and `plan.txt` equal the header's (read with
`head-object`, nothing downloaded) and `passed-build.json` passes and names this header. Then it signs `header.json`'s exact bytes
(ECDSA P-256 SHA-256, RAW, DER), checks the signature with the key's public half, and uploads `header.sig`.

## 3. Check it as a host would
```bash
tools/template/template-verify s3://<bucket>/desk/host-template/<version>/<gN>/ --kms-key-id alias/ma-host-template --host-image <version> --had g1
tools/template/template-verify s3://<bucket>/desk/host-template/<version>/<gN>/ --image --host-image <version>   # with the keys the host recipe pins
```
Both must exit 0. `--unpack <new dir>` also unpacks and walks it (about 2.3 GB; run it on a build box, not this workstation).

## 4. Hand it to Platform
Tell the Platform Engineer the artifact's prefix, `gen`, host-image version and `header.json`'s SHA-256 (`template-sign` prints it):
a target names one artifact by those (PU-3). The staging test host takes it first and writes `passed-test.json`; waves follow.
For an urgent fix, say so: Platform opens the target with 1-hour holds (section 5).

## A test build (no release)
```bash
OWNER_TAG=syseng-template image/host/template-build.sh <host AMI> --test-archive --mutations --dev-key <scratch>/dev-p256.pem
```
- `--test-archive`: if `trixie-security` has nothing newer, the full path runs from section 7's local test archive (one small package
  the template has, repacked from Debian's own `.deb` at a higher version, signed by a throwaway OpenPGP key only this builder trusts).
- `--mutations`: section 7's builder mutation pass, each mutation required to fail (template-apt, Debian's signature, nothing else
  changed, the carry with the guard removed, the slot read-back without Cookies, the round trip, the upload).
- `--dev-key`: signs the uploaded artifact with a dev P-256 key (`openssl ecparam -name prime256v1 -genkey -noout -out <scratch>/dev-p256.pem`,
  kept out of git) instead of KMS, and checks it with `template-verify`.
- A test build goes under `desk/host-template-test/`, never `desk/host-template/`; nothing there is ever a target.

## If something is left running
`aws ec2 describe-instances --filters Name=tag:Owner,Values=<your tag> Name=tag:Purpose,Values=desk-image-build Name=instance-state-name,Values=running,stopped`;
terminate it, then delete its security group (`ma-template-build-*`) and key pair. It powers itself off (and is terminated) after
`--keep-minutes` anyway.
