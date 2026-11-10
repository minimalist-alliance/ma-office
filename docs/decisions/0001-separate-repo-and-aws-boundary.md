# 0001. Separate repo and AWS boundary

**Status:** Accepted
**Date:** 2026-11-04

## Context
Minimalist Alliance has a Platform repo, `ma-platform`, owned by the Platform Engineer, who also owns all AWS infra. The Desk app is a separate product built by a different session.

## Decision
1. The Desk app lives in its own repo, `git@github.com:minimalist-alliance/ma-desk.git`, separate from `ma-platform`.
2. The Desk app never creates AWS resources or DNS itself. All AWS needs go to the Platform Engineer. API/auth contracts the Desk app consumes are published in `ma-platform` under `docs/contracts/` and are read-only for Desk.

## Consequences
- Desk work can't change infra directly; AWS needs must be requested and may wait on the Platform Engineer.
- One owner for AWS keeps spend and security in one place.
- Contract changes originate in `ma-platform`; the Desk app tracks them rather than defining them.
