# Runbooks

Step-by-step procedures a successor can follow without other context. One file per runbook; add it here when written.

Planned per design v1 (`docs/desk-design.md` §10.6 and §12). Platform owns the AWS side of each (builds, hosting, rollout); these runbooks cover the Desk side and the handoff.

| Runbook | Purpose | Status |
|---|---|---|
| Local dev build | Build and run the web app, deskd and desk-agent locally, against a dev desk | TBD (Phase 0) |
| AMI build/publish | Change the image recipe in `image/`, tag a release, hand it to Platform's Image Builder pipeline, check the candidate smoke test, promote to canary | TBD (Phase 0) |
| Web app build/deploy handoff to Platform | Build the immutable bundle, declare its `desk_api` range, hand it to Platform for hosting, verify the canary cohort | TBD (Phase 1) |
| [deskd: build, publish, run, roll back](deskd-build-and-run.md) | Build a `deskd` (or `desk-agent`, `desk-notebook`) release on the arm64 box, publish and roll it out through Platform's script, roll back, read logs | In use |
| [A service batch on a shared host](host-batches.md) | ADR 0078: build and sign a batch, the order a host takes, the canary, promote and halt, the kill switches; by hand on a TEST host until Platform's PB-1 to PB-9 | Lab only (not baked; host 0.1.12) |
| [Host template build](host-template-build.md) | ADR 0077: build a shared-host template generation on a temporary builder from its host AMI, sign it on the workstation (KMS), check it as a host would, hand it to Platform; and a test build with the mutation pass | In use (test builds; the KMS key is Platform's PU-9) |
| [Restore rehearsal](restore-rehearsal.md) | TD-110: an image upgrade, a rollback and a snapshot restore on the test desk, with a real session on it (ADR 0035) | Spec, never run |
| Release/rollback | Version and changelog; promote canary → waves; roll back the web app (pointer flip) or the image (root replacement with the previous AMI), and restore the data snapshot if a release migrated data | TBD (Phase 1) |
