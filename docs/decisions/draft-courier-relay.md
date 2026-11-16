# Draft. The sealed relay also carries the mail door's envelopes (amends ADR 0017)

**Status:** Proposed (draft amendment; the integrator numbers it, from the Desk range 0110 to 0119, and adds an "Amended by" line to [0017](0017-sealed-relay-desk-to-desk.md) when it's accepted). Nothing of it is built: the relay, the key directory and the drop are Platform's contract 0.4.0 (`relay.md`, a stub). Platform's own ADR for the mail door is Platform's to write, in `ma-platform`.
**Date:** 2026-11-12
**Amends:** [0017](0017-sealed-relay-desk-to-desk.md). Its decision stands: desks keep their own X25519 and Ed25519 keys, Platform's relay holds only ciphertext, pull then ack, and pending counts for a stopped desk. The task 08 spike's envelope (HPKE, RFC 9180, base mode, X25519 / HKDF-SHA256 / ChaCha20-Poly1305, the sender's Ed25519 signature over the exact payload, sender and recipient bound in) replaces `crypto_box_seal`, as the spike recommends.
**See also:** [draft-courier-channels](draft-courier-channels.md), [draft-courier-address](draft-courier-address.md), [draft-courier-store](draft-courier-store.md).

## Context
Mail to a desk's own address arrives at Platform's mail door while the desk may be asleep, and a new message never wakes a desk. The relay already waits sealed messages for a sleeping desk. Using it for mail too means one way in, one ack and one badge count.

## Decision
1. **The relay also carries mail from Platform's mail door,** sealed to the desk by the door, with the sender recorded as the door and the outside address (plan §2.2). The door seals within seconds of the receipt and deletes the plaintext; a sweep seals or deletes anything a failed run left, and the bucket's lifecycle deletes anything older than a day as the last guard.
2. **Expiry:** member-to-member envelopes wait 30 days (ADR 0017). *Proposed:* mail envelopes wait **90 days**, as a mail server would hold mail for a mailbox that's away. (Not one of the owner's five decisions; Platform's to settle in 0.4.0.)
3. **Padding:** envelopes are padded to size buckets, 256 bytes up to 4 KiB, then powers of two (the spike's Q-C7), so an envelope's size doesn't give its message's length.
4. **The key directory gains a `device` kind** for paired connectors (MA Connector for Mac and for Android), each tied to one desk.
5. **Large messages and attachments use the ciphertext drop,** with a content key in the HPKE envelope and the body as chunked AEAD in the drop (design §8.5's attachment pattern; the plan's team question 4, default).
6. **On the desk, a drain commits what it collected before it acks:** the store's sink takes the batch and the transport's cursor in one transaction ([draft-courier-store](draft-courier-store.md) §3), so an envelope is acked only once its message is on disk, and an envelope collected twice is stored once.
7. **New messages never wake a desk** (`relay.md`: "No relay message wakes a desk"). A running desk gets a `relay` push and collects at once; a sleeping one shows the platform's pending count, and the bell's `courier.waiting` item (Platform's ADR 0125 registry: counts only, collapsed per desk, never by email).
8. **The reserved names** `relay.md` keeps as `/v1/agent/chat-addresses*` become `/v1/agent/courier-addresses*` under the id rule.

## Consequences
- The platform still sees which desk, which sender (an outside address for mail, a desk for member messages), when, and the padded size, and never content once sealed; for mail to a desk's address it sees the plaintext for seconds at the door (ADR 0074's "operator-blind by design, and audited").
- A key Platform swaps is caught by pinning, fingerprints in invites, safety numbers and a block on change (the spike's step 11); a first contact without an invite still trusts the directory.
- The critical path of Courier's launch is this contract: the desk's address and member-to-member messages both need it. Linked mailboxes don't.
