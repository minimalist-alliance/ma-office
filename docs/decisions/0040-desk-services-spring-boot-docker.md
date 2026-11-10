# 0040. Desk services: Java 21, Spring Boot, Docker

**Status:** Accepted (the owner, 2026-11-05)
**Date:** 2026-11-05
**Supersedes:** [0006](0006-desk-daemon-node-sqlite.md)

## Context
- The owner, 2026-11-05: "I'm expecting everything on the EC2 backend wise to be java 21 spring boot". The owner also wants Docker. [ADR 0032](0032-owners-desk-skeleton-hostname-and-rollout.md) added Docker to the image and left the Java decisions to this ADR.
- ADR 0006 chose Node 24 because Playwright, TipTap's headless schema, Hocuspocus and AI SDK are TypeScript. The owner's direction overrides that reasoning.
- Memory, CPU and wake time must stay as low as possible. They will be measured on c7g.large (arm64, 2 vCPU, 4 GiB), where the browser stream already uses 69–76% of the CPU.

## Decision
- **Scope:** every backend service on the desk EC2 (`deskd`, `desk-agent`, `desk-guildhost`) is Java 21 + Spring Boot in Docker. `desk-rtc` (Go), `desk-stream` (GStreamer), kiosk Chromium and Xorg stay outside this rule as native systemd units. ADR 0009 rejected containerized Chromium over its sandbox.
- **Kept from 0006:**
  - One `deskd` per desk, with app modules.
  - SQLite in WAL mode with one file per app under `/data/desk`, now through `sqlite-jdbc`, with FTS5.
  - Content-addressed blobs, UUIDv7 ids and fractional-index ordering.
  - Migrate at boot and refuse a newer schema.
  - No network listener: frames travel over the Unix socket from `desk-rtc` (ADRs 0022, 0023).
- **Footprint:**
  - No embedded web server, no JPA or Hibernate, no component scanning, and as few dependencies as the job allows. The one `/health` route on `deskd-admin.sock` (`docs/interfaces/desk-runtime.md` §6) is a small handler on a JDK Unix socket.
  - SerialGC, a capped heap, AppCDS plus Spring AOT, and a trimmed JRE.
  - GraalVM native image is still Spring Boot + Java 21. It is evaluated against measurements on c7g.large and is not decided here.
- **Docker:**
  - Host networking is mandatory. IMDS hop limit 1 blocks bridged containers from the desk role, and the per-uid nftables rules do not match forwarded traffic.
  - Docker's own firewall management is off, and there is no bridge.
  - Every container has a read-only root filesystem, a non-root numeric uid, all capabilities dropped, no-new-privileges and the journald log driver (volatile: design §10.2, ADR 0011).
  - Images are baked into the AMI and never pulled at wake. `ma-update` may load a newer image from a checksummed artifact (ADR 0032); that is an update step, not a wake step.
  - Memory and CPU limits are set on the container, because systemd unit limits do not reach it.
  - `deskd` never receives `docker.sock`, which is root-equivalent. Starting `desk-*` units goes through a narrow host helper, to be agreed with the System Engineer.
- **Keys (ADR 0012):** the attach mechanism is disabled, heap dumps are off, and keys are held in byte arrays where the libraries allow. Java strings and GC copies make zeroing weaker than under Node. This is accepted and disclosed.

## Consequences
None of the figures below are measured yet; all are estimates.
- **Cost per primary desk, against the Node design:** +200–400 MB RAM with a tuned JVM, 15–75 CPU-seconds of warm-up after each wake, and +2–7 s stopped-to-ready. The benchmark ran no daemon of any kind, so these sit on top of c7g.large's 69–76% CPU. Real numbers will come from `services/bench` on c7g.large.
- **Sizes:** t4g.micro Guild Desks likely don't fit a tuned JVM, so ADR 0025 needs revisiting.
- **Cost:** no new paid service. If RAM forces a bigger instance (t4g.large, or c7g.large to m7g.large), that's a desk size change for Platform to price.
- **JS-only libraries go:**
  - Playwright for Java runs a bundled Node, so `deskd` drives CDP directly (amends 0009, 0021, 0030).
  - Hocuspocus has no JVM equivalent. The server half of 0015, and 0024, need their own decision: a Yrs binding or a small sidecar. A non-Java sidecar would be an exception to this ADR.
  - AI SDK needs replacing (0018): Spring AI or thin clients.
  - Schemas shared with the TypeScript client need codegen.
- **Also amended:** 0007 (image contents: a JRE and Docker instead of Node), 0011, 0012, 0014, 0019, 0020, 0022, 0023, 0025. Each is updated when the service touching it is built.
- **Alternatives:** Node (0006), not chosen by the owner's direction. Running only part of the backend in Java, rejected for the same reason.

## Addendum, 2026-11-06: core services only
- The owner: "We don't need to use Java 21 spring boot for everything. I mostly just meant that I want core services that make a desk run need to be in java 21 so anyone can understand how the desk works and contribute to it". This closes T56.
- **The rule now:** core services that make a desk run, `deskd` and services like it, stay Java 21 + Spring Boot in Docker. An app's own service, such as Notebook sync, may use the best tool for the job. Whatever it's written in, it keeps the container rules above: read-only root, non-root uid, no capabilities, no `docker.sock`.
- **So:** a non-Java sync server for Notebook (0015, 0024) is no longer an exception to this ADR, and the rejected alternative "only part of the backend in Java" no longer covers apps' own services.
- `desk-agent` and `desk-guildhost`, named in Scope, stay Java as planned unless their own ADR says otherwise.
