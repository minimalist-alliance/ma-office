# 0074. The privacy claim is "operator-blind by design, and audited", never "zero-knowledge"

**Status:** Accepted (the owner accepted design Q2's default; recorded in the handover of 2026-11-05). Written up 2026-11-11 (TD-49).
**Date:** 2026-11-11

## Context
Design v1.1 asked, as Q2: is "operator-blind by design, and audited" an acceptable privacy claim for v1, or must Minimalist Alliance be unable, even in principle, to read desk data and keys? Privacy is what the product sells, so the words have to be true.

What holds by design:
- A desk's content (notes, chats, agent prompts and replies, files, browsing) lives on that desk's data volume and nowhere in the platform ([ADR 0011](0011-desk-data-location-and-privacy.md); design §10.4).
- Everything between the member's browser and their desk is DTLS end to end, through TURN too. The gateway carries only control and signaling, and logs neither SDP bodies nor tokens ([ADR 0022](0022-desk-connectivity-hybrid-webrtc.md)).
- LLM keys are sealed on the member's desk and never leave it, not even as an envelope ([ADR 0042](0042-llm-keys-sealed-on-the-desk.md), which replaced 0012's KMS envelopes).

What doesn't, because whoever controls the AWS account controls EC2, EBS and SSM:
- **SSM Run Command is root on a running desk:** its memory, its unsealed keys and its signed-in browser sessions.
- **A data volume, or a snapshot of it, can be attached elsewhere and read,** `/data/agent/keys/master.key` with it: volumes are encrypted with a key the account manages.
- **On a shared host** ([ADR 0072](0072-shared-desk-hosts-host-side.md)), the host's root controls every desk's container.
- **The platform serves the Desk app's JavaScript,** so a malicious bundle could read what the member sees.

Access that is impossible even in principle needs a key only the member holds ("vault mode": LUKS on `/data`, unlocked by the member). Its costs: a lost key loses the desk, and a stopped desk, its agents included, can't start until the member unlocks it.

## Decision
The owner accepted the default.

1. **The claim is "operator-blind by design, and audited".** Never "zero-knowledge", "we can't read your data" or "encrypted end to end" for storage. "Encrypted end to end" may describe only the connection between the member's browser and their desk.
2. **Operator-blind by design:** no platform service stores or receives desk content or LLM keys. The platform sees metadata only, as design §10.4's table lists.
3. **Audited:** every deliberate access path is recorded outside the desk, where the desk's own root can't rewrite it: SSM commands to desks, a desk volume attached to another instance, a volume made from a desk snapshot, a snapshot of a root volume, and a change to a key policy. Each is shown to the affected member as access history (design §13.1, need #15).
4. **Disclosed to members:** account admins can run root commands on a running desk through SSM break-glass, and can restore or attach a volume. Every such action is recorded and shown.
5. **Vault mode** is a later opt-in, not part of v1.

## Where it stands (2026-11-11)
- **Built:** content and keys stay on the desk (ADRs 0011, 0022, 0042). CloudTrail has one multi-region trail of management events with log-file validation, kept 365 days (`ma-platform` ADR 0037, `terraform/cloudtrail.tf`). It records the API calls in point 3.
- **Not built:** storage the account's own admins can't delete (the trail's bucket is versioned SSE-S3, not Object Lock), alarms on those events, and showing them to the member. Until those exist, "audited" can only mean "recorded in CloudTrail", and public copy should claim no more than that.
- **Shared hosts** add the host's root to the same disclosed class of access (ADR 0072).

## Consequences
- The landing page, the privacy page and support replies use these words. Platform's member-facing access history becomes a requirement for the claim, not an extra.
- The audit has to live outside the desk, because the desk's root could rewrite the desk's own Activity log (design §10.2).
- Nothing changes on the desk. Need #15 (alarms, Object Lock, the member's access history) stays open with the Platform Engineer.
- **Rejected:** zero-knowledge for everyone from v1, which would mean vault mode on every desk: a forgotten key would lose the desk, and unattended agent runs and wakes couldn't work.
