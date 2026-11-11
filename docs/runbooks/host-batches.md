# Runbook: a service batch on a shared host (ADR 0078)

A shared host takes the same signed batch as a desk of its own (`docs/interfaces/desk-runtime.md` §6.1 and §13; `image/host/README.md`,
"Service batches"). Platform names it to hosts in waves (PB-3), the staging test host first. Until Platform's PB-1 to PB-9 exist, this is
how the System Engineer runs one by hand on a TEST host (a lab box or the staging test host), never on a member's host.

## 1. Build and sign the batch (workstation)
```bash
tools/batch/batch-build --seq <n> --id <id> -o manifest.json deskd@<version> desk-agent@<version>   # published and passed only
tools/batch/batch-sign manifest.json --kms-key-id alias/ma-desk-batch                               # writes manifest.json.sig
```
- `seq` must be above every batch any desk has seen; going back is a higher `seq` naming the older versions (the host's store still has
  them as `previous`, so nothing is downloaded).
- A batch naming `desk-agent-filter` (other than the template's) or an `image` applies its services; the host reports `templatePending` or
  `imagePending` until a host image carries them.

## 2. The order (until Platform sends it)
`image/lab/host-batches/mkbatch.sh --seq <n> --id <id> --kms --out <dir> <component>@<version>...` does step 1 and writes
`order-<n>.json`: `{op: batch_target, id: batch_target:<targetId>, targetId, seq, sha256, manifest (base64), signature (base64), urls
(presigned GETs), expiresAt, urgent}`. On a TEST host with the lab's fake Platform: `bsteps.sh order order-<n>.json`.

## 3. Watch it
- The report's `batchFetch` (`downloading`, `verifying`, `installing`, `installed`, `failed`, `refused`, `urlsWanted`) and `batches`
  (`candidate` with its `trialSlot`). `desk-host-batch state`; `desk-host-release list` (the store's links); `/var/log/desk-host/batch.log`.
- **The canary:** the first slot that's idle (live switches on) or stopped (off) takes the candidate; its smoke tests are
  `/var/log/desk-host/link-host.log` (live) or `switch-<k>.log` (the stop path's first run). Each slot's `batch` in the report.
- **Promote** once the canary's desk heartbeats the new `deskd` healthy (PB-3; no wait on the test host): `batch_promote {seq}`
  (`bsteps.sh promote <n>`). The host applies it once its canary passed. Every other slot then moves at its own idle (or stop).
- **Halt** a batch found bad: `batch_halt {seq}` (`bsteps.sh halt <n>`). A slot's own rollback halts it on its host by itself.

## 4. Kill switches
The reply's `updates.batches: false` stops fetches and switches; `updates.liveSwitches` must be `true` for live switches (off until the
Security Analyst has read ADR 0078 §2.2), else batches go by the stop path. The link writes them to `/run/desk-host/link/updates.json`.

## 5. If a switch was cut off
Nothing by hand: a stopped slot is put back by renames before its next start; a running one resumes at its next switch. `desk-host-check
releases` then finds every slot's `rel/` equal to its record by tree hash.
