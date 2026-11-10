# 0011. Desk data location and privacy posture

**Status:** Proposed (pending the owner's approval of design v1)
**Date:** 2026-11-04
**Amended:** 2026-11-04 by [0022](0022-desk-connectivity-hybrid-webrtc.md) (what Platform sees) and [0024](0024-guild-host-and-member-sync.md) (guild content)

## Context
- Privacy is the selling point. Desk content must survive image upgrades and resizes. The drafts disagreed on the path and size (`/var/lib/desk` 10 GB vs `/data` 20 GB); Platform's draft ADR 0023 sizes Standard desks at 20 GB total (root 12 + data 8) and its ADR 0015 uses `aws/ebs` encryption.
- The AWS account owner controls KMS and EC2, and Platform serves the SPA's JavaScript, so "Platform cannot see" has limits.
- Platform's draft ADR 0009 allows consented support sessions and allow-listed SSM break-glass; the VM draft wanted no SSM in production.
- Design Q1 is resolved by the approved hybrid (ADR 0022): client ⇄ desk traffic is DTLS end to end, and Platform relays only signaling.

## Decision
- **All persistent desk content lives on a separate encrypted gp3 data volume mounted at `/data`** (SQLite and blobs, Chromium profile, agent state, the desk's DTLS certificate, desk keys, guild data). The root volume is disposable and holds no persistent content by design, but a running desk's RAM or a stray temp file could reach it, so it gets the same encryption, is never snapshotted, and replaced roots are deleted (`DeleteReplacedRootVolume=true`). No hibernation (ADR 0007). v1 uses Platform's sizes; Phase 0 measures real use.
- **Encryption at rest** on both volumes and snapshots. Desk recommends one customer-managed KMS key per member (KMS bills each key monthly) for crypto-shredding at account closure; `aws/ebs` also meets v1 needs. Platform decides.
- **Backups:** DLM daily snapshots of the data volume, keep 7; guild hosts also every 6 h, keep 4 (ADR 0024).
- **What Platform sees:** metadata (existence, state, size, hours, versions), badge counts, usage totals per LLM key, relay metadata, ciphertext, guild roster and host assignment, and signaling metadata: which client connects to which desk and when, and SDP with the desk's address, ports and both DTLS fingerprints (the client sends no candidates). For relayed sessions, TURN also sees client and desk addresses and byte counts. Never content: guild content lives on the guild host and members' Guild Desks (ADR 0024). VPC Flow Logs (or REJECT only) and Resolver query logs stay off for desk subnets.
- **Support:** SSM agent installed for Platform's smoke tests and break-glass. It runs commands as root, so an account admin can read a running desk's memory, decrypted keys and logged-in sessions; the allow-list of Run Command documents is Platform IAM policy that an admin can bypass, not something the desk enforces. This capability is disclosed (design §10.4, Q2), and every run is recorded outside the desk (CloudTrail, Platform's Object Lock `audit_log`), alarmed and shown to the member. `scope=support` sessions are least-privilege, enforced by deskd: health, logs and settings by default; content apps, the Browser and approvals only for apps the member's grant names; never key management. The member is notified live.
- **Claim:** "operator-blind by design, and audited", not "zero-knowledge" (design Q2). "Audited" depends on Platform's CloudTrail trail with immutable storage and alarms on key-policy changes, desk-volume attach or snapshot restore and SSM commands (design §13.1 need #15; no trail exists today). A user-held-key vault mode is a later opt-in.

## Consequences
- Upgrades and restores never touch content; a lost volume without snapshots is permanent loss.
- Supersedes the drafts' `/var/lib/desk` path, 10/20 GB sizes and the VM draft's "no SSM in prod". The desk's own Activity log is not the record of SSM runs, because root could rewrite it.
- Marketing must use the precise wording; the AWS root account needs MFA (Platform risk).
