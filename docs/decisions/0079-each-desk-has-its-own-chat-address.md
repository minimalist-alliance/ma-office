# 0079. Each desk has its own chat address

**Status:** Accepted (the owner accepted design Q3's default; recorded in the handover of 2026-11-05). Written up 2026-11-11 (TD-49). ADR 0080 changed the guild half after the acceptance: see "Since then".
**Date:** 2026-11-11

## Context
Design v1.1 asked, as Q3: when another member messages you, which desk receives it? Each desk could have its own chat address, or each member could have one address that routes to a single desk.

The vision's first pillar is compartmentalization: Work and Personal stay apart. Chat contacts are already scoped to a desk (design §8.1), and member-to-member mail between desks goes through the sealed relay, addressed to a desk's own key ([ADR 0017](0017-sealed-relay-desk-to-desk.md), design §8.5). One address per member would need a rule for which desk receives it, and would mix the member's contexts in one inbox.

## Decision
The owner accepted the default:
1. **Each desk has its own address,** for example `<handle>.personal` and `<handle>.work`. A custom desk gets its own too. A message sent to an address reaches that desk only. There is no member-wide address that routes to one of the member's desks.
2. **Personal and Work addresses aren't discoverable.** They're shared only through invite links.
3. **A guild desk's address is visible to guildmates.** This was the v1.1 default, written when each member had a Guild Desk of their own (see "Since then").

## Since then
[ADR 0080](0080-guild-shared-desk.md) (accepted 2026-11-07) replaced members' own Guild Desks with one shared Guild Desk per guild. Guild chat is the thread in each Commons channel on that desk, and direct messages between guildmates go between members' own desks, never through the guild's desk. So point 3 has no desk to name any more. Which of a member's own addresses their guildmates see is **open**. It's decided with the relay and the address registry, not here.

## Where it stands (2026-11-11)
Nothing is built. The address registry, the desk key directory and the sealed relay are Platform's `relay.md`, a stub for contract 0.4.0 (design §13.1, needs #21, #22 and #25). Guild chat in Commons is built (`apps/commons`, ADR 0080).

## Consequences
- A member hands out each desk's address separately, and Work contacts never see the Personal address unless the member shares it.
- The key directory registers keys per desk, and a message waits in the relay while its desk is stopped (design §8.5).
- The handle's format, its uniqueness and the invite links are Platform's, in the registry (need #25).
- **Rejected:** one address per member routed to a chosen desk. It mixes contexts, and a member would have to pick, and keep changing, which desk is "the" inbox.
