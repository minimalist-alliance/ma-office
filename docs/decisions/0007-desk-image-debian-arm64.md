# 0007. Desk image: Debian 13 arm64, recipe in ma-desk, built and rolled out by Platform

**Status:** Proposed (pending the owner's approval of design v1)
**Date:** 2026-11-04
**Amended:** 2026-11-04 by [0022](0022-desk-connectivity-hybrid-webrtc.md) (no web server; desk-rtc)

## Context
- The image must run headful, sandboxed Chromium with Playwright, a software video encoder, deskd and the agent runtime on the cheapest viable instance.
- Amazon Linux 2023 (Platform's draft image contract) has no Chromium package. Ubuntu 24.04 ships Chromium only as a snap and restricts the user namespaces Chromium's sandbox needs.
- The VM draft proposed Packer run from this repo's GitHub Actions; Platform's draft ADR 0015 builds with EC2 Image Builder in the Platform account. ADR 0001 says Desk never creates AWS resources.

## Decision
- **Base:** official Debian 13 (trixie) arm64 AMI with Debian's security-supported `chromium`, Node 24 LTS, GStreamer, desk-rtc (our own Pion v4 service, modeled on Neko v3, built for arm64 in this repo's CI, ADR 0022), nftables, zram, unattended-upgrades and the SSM agent. No web server and no TLS certificate.
- **Graviton (t4g) only;** no x86 in v1.
- **Ownership:** Desk owns the recipe in `ma-desk/image/` (Image Builder components calling plain scripts) and the smoke tests. Platform's Image Builder pipeline builds it, runs the candidate smoke test, and owns rollout (candidate → canary → waves) and rollback via root-volume replacement.
- **No hibernation in v1; plain stop only** (Platform ADR 0016's default). A hibernation image would write desk-agent's plaintext LLM keys and decrypted content to the root volume, readable without a logged `kms:Decrypt`. Tabs survive a stop through Chromium session restore instead (ADR 0009). If the owner later picks Platform's hibernation price-down option, Desk first adds a pre-hibernate hook that stops desk-agent and drops deskd's key cache (`init_on_free=1`), and re-decrypts on resume.
- Root replacement uses `DeleteReplacedRootVolume=true`, so old roots are not kept.

## Consequences
- 20–24% cheaper compute than x86 and full-core vCPUs; no Widevine DRM or Google-branded Chrome.
- Platform's image contract must change from AL2023 to Debian 13 (design §13.2).
- ADR 0001's AWS boundary holds: no AWS credentials in this repo's CI.
- Alternatives rejected: Ubuntu 24.04 (snap Chromium), AL2023 (no Chromium), x86 with Google Chrome (+12–24% cost), Packer from Desk CI (Desk would create AWS resources).
