# Draft. One address per desk, for email and for members' sealed messages (amends ADR 0079)

**Status:** Proposed (draft amendment; the integrator numbers it, from the Desk range 0110 to 0119, and adds an "Amended by" line to [0079](0079-each-desk-has-its-own-chat-address.md) when it's accepted). The names and the domain are the owner's decision D1 of the Courier launch plan, **open**: this draft writes the recommended default and marks it. Who may send from an address, and how much, is D3, also open.
**Date:** 2026-11-12
**Amends:** [0079](0079-each-desk-has-its-own-chat-address.md). Its decision stands: each desk has its own address, and Personal and Work addresses aren't discoverable.
**See also:** [draft-courier-channels](draft-courier-channels.md), [draft-courier-relay](draft-courier-relay.md), [draft-courier-store](draft-courier-store.md).

## Context
ADR 0079 gave each desk its own chat address, shared only through invite links, with `<handle>.personal` as its example. Courier at launch carries email too ([draft-courier-channels](draft-courier-channels.md)). Two addresses per desk, one for mail and one for members, would be one more thing to explain and to leak.

## Decision
1. **A desk's address is one name on the Courier mail domain, and it does both jobs.** Mail to it from anyone arrives as email, through Platform's mail door. A message to it from another member's desk goes sealed, desk to desk, through the relay, and never through the door. On the desk, an `ma` endpoint and an `email` endpoint with the same address are one contact ([draft-courier-store](draft-courier-store.md) §5).
2. **The names (D1, open).** *Recommended default:* **the member picks each desk's name, with no shared stem between their desks,** so someone with the Work address can't guess the Personal one; ASCII letters, digits, dots and hyphens; **on `courier.minimalistalliance.com`** (no purchase, and it keeps the brand). The alternative is a short separate domain: shorter addresses, and members' mail reputation fully apart from the company's. This replaces ADR 0079's `<handle>.personal` example.
3. **Plus addressing:** `name+shop@` reaches the same desk, with `shop` shown as a label (built in the store).
4. **Names are never reassigned.** A closed account's addresses bounce with "no longer in use", for good. Addresses are never given to anyone else.
5. **Point 2 of ADR 0079 holds:** there's no directory. An address is shared by the member, and an invite link adds the desk key's fingerprint, so a first contact from an invite is verified with no extra step.
6. **Teens have no address** (ADR 0098 decision 7: teens get no private messages). The relay refuses a teen pair, and deskd refuses `courier.*` on a teen's desk.
7. **Sending from an address (D3, open).** *Recommended default:* paid tiers send to anyone, 200 messages a day a desk, 50 new recipients a day, 50 recipients a message; free desks receive, and reply only to people who wrote to that address first, 20 a day; teens, none. All are settings. Mail between two MA addresses never counts here: it's sealed through the relay.
8. **When a membership ends,** the address keeps receiving while the desk exists (a free desk receives). When the desk is deleted, the address closes.

## Consequences
- One address to share per desk, and one thing to revoke.
- The address registry (names, reserved names, never reused, teen pairs refused) is Platform's, in contract 0.4.0 ([draft-courier-relay](draft-courier-relay.md)).
- An attacker can learn that an address exists from a bounce (standard SMTP behaviour); the registry's rate limits bound it.
- **Rejected:** a shared stem between a member's desks (`dana.work`, `dana.personal`): it gives Personal away to every Work contact.
