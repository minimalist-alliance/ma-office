# 0032. The owner's desk: walking skeleton at `office.`, fast rollout

**Status:** Accepted for the owner's desk (`~/ma-coord/owners-desk.md`, 2026-11-05)
**Date:** 2026-11-05
**Amended:** 2026-11-05 by the owner: no personal subdomains at all, the owner included; `desk.` renamed `office.` (see Decision)

## Context
- The owner wants his own real desk, first asked for at `<name>.desk.minimalistalliance.com`, with fast iterations, ahead of the landing page and platform management.
- ADR 0022 says desks have no hostname, certificate or inbound HTTPS, and Platform's `hostnames.md` removed `*.desk.` for that reason.
- ADR 0007 has Platform's Image Builder pipeline build the image and ADR 0001 keeps Desk out of AWS. That pipeline doesn't exist yet, and neither does the gateway.
- Root-volume replacement (`desk-endpoint.md` §5.1) takes too long for a backend change that should reach the owner soon after a UI change.

## Decision
- **Build a walking skeleton first:** sign-in, the real React app, and Spring Boot on a real EC2, connected through the real WebRTC path. Video comes next, then the apps.
- **Nobody has a personal subdomain, the owner included.** `<name>.desk.`, first built as an app alias, is removed: "We don't need owner.desk at all actually", and "I'll go to my office at https://office.minimalistalliance.com just like everyone else." The desk stays hostname-free and all content still goes over WebRTC, so ADR 0022 holds.
- **Members and officers** "just go to the landing page and click on 'My Desk' if they are signed in or 'Login' if not. custom subdomains will be for guild dashboards (later feature we can talk about)".
- **The Desk app's host is `office.`, with `desk.` redirecting to it (the owner):** "we should rename the 'desk' subdomain to 'office' because an office will have multiple desks."
- **Everything reaches a `DeskKind=test` desk first,** then the owner's, gated by one end-to-end test.
- **Two rollout speeds:**
  - UI: upload an immutable bundle, then move the release pointer, test cohort first. Rollback moves it back.
  - Backend: `ma-update` through SSM Run Command with a presigned URL (`docs/interfaces/desk-runtime.md` §6). Rollback swaps one symlink.
  - AMIs are only for OS-level changes.
- **The System Engineer bakes AMIs from a temporary builder EC2** until Platform's pipeline exists. Builders are tagged `Purpose=desk-image-build`, sit in the default VPC and are terminated after use. This is a narrow, temporary exception to ADR 0001 and ADR 0007.
- **Add Docker to the image and run backend services in it** (the owner's decision, which supersedes ADR 0006; Java ADRs come from the Desk Engineer). `desk-rtc`, `desk-stream` and Chromium stay native.

## Consequences
- Each team can work against a stub and integrate early, which exposes contract problems sooner.
- Platform's hostname contract changes, and `ma-update` becomes a second upgrade path beside root replacement. Long term, `ma-update` carries fast fixes and a new AMI folds them in.
- Members reach the Desk app at `office.` through the landing page, so nothing per-member is needed in DNS, certificates or Cognito.
- Root replacement stays the path for member rollouts. The fast path isn't member-ready until Platform adds canary waves to it.

Addendum 2026-11-07 (task 45): "Members and officers" is now Officers and Founders.
