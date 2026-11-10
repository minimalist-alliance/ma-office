# 0016. Chat model: channels, medium separate from author, default = last medium received

**Status:** Proposed (pending the owner's approval of design v1)
**Date:** 2026-11-04

## Context
- The vision: one channel per person or persons carrying every medium (text, email, agentic), the sender choosing the medium per message, "the default being the last comm received". Integrations come once the foundation exists.
- Credentials and plaintext must stay on the desk VM.

## Decision
- **Channels:** `direct`, `group`, `guild` and `self`; contacts with many endpoints, scoped per desk; unknown senders go to Requests.
- **Every message has a `medium`** (`local`/`ma`/`email`/`sms`/`matrix`, an open string) **and an `author_kind`** (`human`/`agent`/`system`). "Agentic" is an author kind on a real medium and always carries the provider badge.
- **Default delivery** = the medium of the most recent message received from the other party (any member, in a group), if that adapter is healthy and reaches everyone; else the channel's preferred medium; else `ma` if everyone has an MA address; else the user picks. The composer shows the medium and why.
- **Transport adapters run in deskd.** Phase 2: `local` and `ma`. Phase 4: email with the member's own IMAP/SMTP. Later: Matrix and SMS with the member's own accounts.

## Consequences
- The default follows where the other person is now; fallbacks are predictable and visible.
- "Text a family member" works only once SMS or Matrix arrives (or email in Phase 4); iMessage is impossible.
- Alternatives rejected: "agent" as a medium (conflates author and transport); the user's own last-sent medium as default; a Platform-hosted Matrix homeserver or SES mailboxes (Platform would touch plaintext; operating cost).
