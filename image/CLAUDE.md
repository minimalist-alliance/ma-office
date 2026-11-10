# image/ (desk VM image)

Owner: System Engineer. Spec: `docs/interfaces/desk-runtime.md`. Commands: `README.md`.

- `bake.sh <version>` builds, `verify.sh <ami>` proves, `prune.sh` cleans. Run verify before telling anyone an AMI is good.
- `count-address.sh <ami>` counts this workstation's address on a booted copy, counts only. Run it on every bake before the AMI goes on a desk (README, "What the image keeps from its builder"). Section B's record: `docs/sub-status/clean-bake.md`. Section A's: `docs/sub-status/baked-services.md`. Section D's: `docs/sub-status/throttle.md`.
- AWS here is a narrow exception (ADR 0032): us-east-1 default VPC, tags as in `lib.sh`, terminate every instance, delete failed AMIs, keep the newest two good ones, about $3 total per pass. No IAM, DNS, quota or Terraform changes.
- `desk-firstboot` must never format a volume that has a filesystem or any signature. Fresh EBS volumes contain noise at offset 4096 but no signature, so do not add a "first bytes are zero" check (it blocked a blank volume once).
- `recipe/releases.pin` names the releases baked in. Pin only a version with a `passed-test.json`, and never `desk-rtc` 0.2.0 (`build.sh` refuses it). A root swap brings these versions back.
- `.pem` files live only in a temp dir and are shredded on exit. Never commit them.
- Component owners write each release's `run` and `health`; `ma-update` and `/opt/ma/smoke-test` stay generic.
- `desk-units` is a root helper reachable from the `deskd` container. Keep it exactly as narrow as runtime spec section 8.3 says: a new unit or verb there is a spec change first.
- PulseAudio chmods its runtime path to 0700, so its socket has to live outside it for user `stream` to connect.
- uid 1103 (`desk-agent`) reaches only loopback and `desk-agent-filter` (uid 1106), which allows the exact names in `/etc/ma/agent-egress.conf` (ADR 0070). A new provider host goes in that file, or its calls are refused (README, "desk-agent-filter"). `recipe/desk-agent-filter/` changed means a new version and hash in `releases.pin`, or `bake.sh` refuses.
- `desk-data` (`tools/desk-data/`, task 32) is copied into `recipe/files`, from 0.2.6. `tools/desk-data/` stays the source: change it there, test, copy, and `bake.sh` refuses copies that differ (README, "desk-data").
- Edit only `image/` paths; stage them explicitly.
