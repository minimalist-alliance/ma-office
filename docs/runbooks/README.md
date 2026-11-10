# Runbooks

Step-by-step procedures a successor can follow without other context. One file per runbook; add it here when written.

Planned per design v1 (`docs/desk-design.md` §10.6 and §12). Platform owns the AWS side of each (builds, hosting, rollout); these runbooks cover the Desk side and the handoff.

| Runbook | Purpose | Status |
|---|---|---|
| Local dev build | Build and run the web app, deskd and desk-agent locally, against a dev desk | TBD (Phase 0) |
| AMI build/publish | Change the image recipe in `image/`, tag a release, hand it to Platform's Image Builder pipeline, check the candidate smoke test, promote to canary | TBD (Phase 0) |
| Web app build/deploy handoff to Platform | Build the immutable bundle, declare its `desk_api` range, hand it to Platform for hosting, verify the canary cohort | TBD (Phase 1) |
| [deskd: build, publish, run, roll back](deskd-build-and-run.md) | Build a `deskd` (or `desk-agent`, `desk-notebook`) release on the arm64 box, publish and roll it out through Platform's script, roll back, read logs | In use |
| [Restore rehearsal](restore-rehearsal.md) | TD-110: an image upgrade, a rollback and a snapshot restore on the test desk, with a real session on it (ADR 0035) | Spec, never run |
| Release/rollback | Version and changelog; promote canary → waves; roll back the web app (pointer flip) or the image (root replacement with the previous AMI), and restore the data snapshot if a release migrated data | TBD (Phase 1) |
