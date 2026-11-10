# 0017. Desk-to-desk messaging through a sealed Platform relay

**Status:** Proposed (pending the owner's approval of design v1)
**Date:** 2026-11-04
**Amended:** 2026-11-04 by [0022](0022-desk-connectivity-hybrid-webrtc.md) (context, push) and [0024](0024-guild-host-and-member-sync.md) (guild channels)

## Context
- Desks idle-stop, so direct desk-to-desk delivery would drop messages, and a desk exposes only ICE ports that accept signaled, token-bound sessions (ADR 0022).
- Member-to-member chat, guild channels and (later) agent-to-agent asks all need store-and-forward. Platform's draft already has a `desk_inbox` for stopped desks.
- The Chat draft capped guild fan-out at 100; Platform's draft caps guilds at 25 members in v1.

## Decision
- Each desk generates X25519 and Ed25519 keypairs on first boot, keeps the private halves on `/data`, and registers the public halves in Platform's key directory.
- Messages are `crypto_box_seal(recipient_pk, payload ‖ ed25519_sig)` (libsodium) envelopes addressed desk to desk. Attachments are encrypted with a random key and stored in a Platform ciphertext drop; the key rides in the envelope.
- Platform's relay (`desk_inbox`) holds only envelopes: pull and ack, 30-day expiry for chat (7 days for agent-to-agent), sender authorization, rate limits, and pending counts for stopped desks.
- **Guild channels** moved to the guild host (ADR 0024): no per-member fan-out through the relay. The relay carries member-to-member chat outside the guild and agent-to-agent asks.
- **Agent-to-agent** (Phase 4) uses the same relay, only between the member's own desks, and only under a grant the member created with step-up auth.

## Consequences
- Platform learns who talks to whom, when and how much, but never content. The privacy promise must say so.
- Platform's key directory is a trust anchor; key-fingerprint verification in the UI comes later.
- A lost data volume without snapshots loses that member's chat history.
- The gateway pushes `inbox` to a running recipient's desk link, so delivery doesn't wait for a poll. The relay is desk → Platform API traffic (SigV4) and is not affected by the client data path.
- Alternatives rejected: direct desk-to-desk delivery with retries, a central plaintext chat store, a Platform-held guild chat copy.
