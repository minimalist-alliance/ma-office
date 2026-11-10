# 0043. Agent limits: the member's local time, desk over account, and the Platform's prices

**Status:** Accepted (the owner, 2026-11-07)
**Date:** 2026-11-07
**Amends:** [0020](0020-agent-runs-and-usage-limits.md), and design §9.9 as below

## Context
- The owner: "For the Agent app, the user should be able to set and configure their own spending limits in the agent app's settings. Daily and time should be based on their local time and region".
- The owner, on prices: "The platform should have its own keys for al supported providers to check daily for price changes and all desk's Agent apps must refer to the platform as the source of truth".
- The owner's settings rule: "configs at the desk level defer to account if not specified or override if set".
- Periods ran in UTC, and `pricing.json` only changed with a release of `desk-agent`.
- A review found that a model missing from the price table had no dollar cap at all: the default policy is dollars only, `agent.bind` takes any model id, and such a model passed every default limit and counted as $0.
- `desk-agent` (uid 1103) can't reach the Platform. `deskd` can.

## Decision
- **Periods are the member's.** Days, weeks from Monday and months begin at midnight in a zone the member picks, an IANA region the JDK knows or `UTC`. A fixed offset in any spelling, `Etc/GMT+5` included, is refused. The ledger keeps `at_ms` and no period, so a changed zone just windows the same rows differently, with no schema change.
- **A new scope, `desk_day`:** the whole desk's spend in the member's current day. None by default.
- **Three values layer, desk then account then default:** `deskDay` (none), `deskMonth` ($20) and `timeZone` (null, which means UTC). The desk's are the member's, set in the Agent app. The account's are `agentDefaults` in `GET /v1/agent/config`. Only what the member set is kept as the desk's. "Nothing set" and "no limit, set here" are kept apart: absent changes nothing, null clears, and a `Limit` with both caps null is a value that beats the layers under it.
- **The Platform's table is the source of truth.** `deskd` fetches `GET /v1/public/model-prices` about every 6 hours with an ETag, keeps the last good one in `/data/desk/model-prices.json` and pushes it to `desk-agent` on every connection and on a change. `desk-agent` holds it in memory, with the bundled `pricing.json` as the seed. A bad table or a missing one never stops an agent, and a settled cost stays as it was charged.
- **An unlisted model counts at the highest listed price.** A dated id takes its undated entry first. Any other model counts at its provider's highest listed price by `output`, or, if the table lists nothing for that provider, at the highest in the whole table, in the reservation and in what's settled. So a dollar limit binds every model. `agent.key.models` still shows such a model's prices as null, so a client can say it has no listed price.
- **Pushes are plain `req`s,** with methods outside `agent.*` that deskd's relay doesn't list, so no client can send them. An older `desk-agent` drops the link on a `t` it doesn't know and answers `not_found` to a method it doesn't know, so a new `t` would break every rollout and a new method can't. An older `deskd` drops the link on an unknown `t` too, so `desk-agent` announces nothing. The account's values reach `deskd` with the config it already fetches, with no poll of their own.

## Consequences
- A limit resets at the member's own midnight. Changing the zone can move what's been spent in or out of the current day, as the ledger only re-windows: it's the member's own setting and their own money.
- Prices can be up to about 6 hours behind the Platform, and an unlisted model's estimate is high on purpose. The provider's bill still counts, and the provider's own spend limit stays the real backstop.
- Until `deskd` has a config, a fresh `desk-agent` has no account values, and for a moment after each connection it hasn't heard them. No client can reach it in the first case, and the second is milliseconds.
- `limits.desk` gained an `own` object beside its old fields, which it still writes, so a rolled-back `desk-agent` starts and enforces what was in force when the row was saved. A `limits.set` made on the older one then drops `deskDay` and `timeZone`, and its `deskMonth` counts as this desk's own.

## What this changes in design §9.9
- **Scopes:** per desk (day and month). Periods are in the member's zone, and `deskDay`, `deskMonth` and the zone go desk, then account, then default.
- **Prices:** "a signed `pricing.json` ships with each desk release, with per-model user overrides" becomes the Platform's table, with the bundled file as the seed. Signing and per-model overrides aren't built.
- **"For an unknown model only token limits apply and $ shows as 'unknown'"** becomes the rule above: dollar limits always bind, and a client says the model has no listed price.
