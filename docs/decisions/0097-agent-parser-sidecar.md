# 0097. The Agent's attachment reader runs in a sandbox of its own: uid 1113, no network, no `/data`

**Status:** Proposed (2026-11-12). The System Engineer's half of ISS20-P1, for the Desk Engineer and the Security Analyst. **Built (2026-11-12),** both halves, on no desk yet: the Desk Engineer's on `sub/desk-parse` (`docs/sub-status/desk-parse-sidecar.md`), the System Engineer's on `sub/desk-parse-sys` (`docs/sub-status/desk-parse.md`). What the builds changed here is in "Changes from the build", at the end; the sections below are written as built.
**Date:** 2026-11-12
**Builds on:** the Desk Engineer's proposal "desk-parse: the attachment parser's own sidecar" (2026-11-12): its protocol, flags, image source and checks stay; the dispatcher, the uid and the fallback change ("Answers to the Desk Engineer", below).
**Amends:** [ADR 0049](0049-agent-attachments.md) item 3 (the container-level close it asked of the System Engineer) and [ADR 0072](0072-shared-desk-hosts-host-side.md) section 2 (a seventh sandbox in a slot). Keeps [ADR 0040](0040-desk-services-spring-boot-docker.md)'s container rules and [ADR 0042](0042-llm-keys-sealed-on-the-desk.md)'s "later tools must not run as uid `agent`".

## Context
- `desk-agent` reads PDF, Office and text attachments in a child JVM (`attach/Parsers`, `attach/worker/ParseWorker`): the file on stdin; `OK <note>` or `ERR <reason>`, a newline and the text on stdout; a 72 MiB heap, a 30 s deadline, an empty environment, one child at a time. The child has desk-agent's uid 1103, its `/data/agent` mount (`services/desk-agent/docker/run`) and the host's network. Only `worker/Sandbox`, a Java security manager, stands between a parser bug and `/data/agent/keys`.
- Security, ISS20-P1 (Low, `docs/sub-status/iss20-key-zeroing-finding.md`): "The fix is ADR 0049's parser sidecar: its own uid, no `/data`, no network. It's needed before any move to JDK 24 or later, because that removes the security manager." Image 0.3.6's `ptrace_scope` 2 closed the heap path only. The disk path is still open.
- It has to work in three places. A cloud desk has systemd and Docker. A slot on a shared host has neither inside: each service is a runc sandbox from `svc-spec.py` whose process 1 is `desk-svc`, and desk-host takes no requests from a desk (ADR 0072). A self-hosted desk (`selfhost/`) is the cloud recipe on amd64.

## Shapes compared
Every shape pays the worker JVM's own start, as today's child does; the table gives the cost on top of it. Today's child isn't measured on its own: five 100-page PDFs (12 MiB) read in 2.0 s on x86_64 (desk-agent README, "Footprint"), so at most 0.4 s each, start included. **Docker's share is measured:** on a c7g.large, `docker run` to desk-agent's ready line took 650 to 691 ms (median 681), against 530 to 540 ms (median 540) by the JVM's own clock (same README, five runs, Docker 26.1.5, idle box). That makes about 140 ms Docker's. All other numbers here are estimates.

| | (a) systemd per parse (`Accept=yes`), native | (b) one long-lived sandbox; `desk-svc -accept` forks a worker per parse | (c) `docker run` per parse, socket-activated (the Desk Engineer's draft) |
|---|---|---|---|
| Start per parse | the unit's setup, est. 10 to 30 ms | none: `desk-svc` forks the JVM, as `Parsers` does today | about 140 ms (measured idle; more beside a busy Browser), then `--rm`'s teardown after the answer |
| Memory | the worker in its own 160 MiB cgroup (76 MiB RSS at most, measured as the child); 0 when idle | the worker; when idle, `desk-svc` (static Go) plus, on a cloud desk, one containerd shim: est. 10 to 15 MiB | the worker plus the Docker CLI and a shim during a parse, est. 20 to 40 MiB; 0 when idle |
| The wall | `PrivateNetwork`, an empty capability set, `SystemCallFilter=@system-service`, `ProtectSystem=strict`, `InaccessiblePaths=/data`, `MemoryMax`, `RuntimeMaxSec`: the tightest syscall filter | Docker's (cloud, self-hosted) or runc's (slot) namespaces, seccomp and AppArmor; no network, no capabilities, read-only, memory and task limits | as (b) on a cloud desk |
| Jars and JDK, same version as desk-agent | needs desk-agent's image as files on the host. A cloud desk has them only in Docker's store, so `ma-update` would export a root per release (about 386 MB of disk for each release kept); a slot has one (`rel/desk-agent/rootfs`) | desk-agent's own image (`current/image-id`) or, in a slot, its release root; restarted with desk-agent | desk-agent's current image id on every parse |
| Cloud desk | yes, with the export | a Docker container under a unit | yes |
| Shared-host slot | no: no systemd in a slot | a seventh `svc-spec` sandbox, as `desk-data`'s `-accept` already is | no: no Docker in a slot, and desk-host takes no requests from a desk |
| Self-hosted | as cloud | as cloud, with an amd64 `desk-svc` | as cloud |
| What a parse leaves behind | nothing: the unit's cgroup is killed | nothing, because `desk-svc -clean` kills every other process after each parse (section 1) | nothing: a fresh container |
| What the file and its text pass through | the worker only | the worker only: the connection is its stdin and stdout | the Docker CLI, `dockerd` and the shim. The desks' default log driver is journald (`daemon.json`) and the journal is persistent, so without `--log-driver none` the worker's stdout, which is the extracted text, is written to disk |
| What Desk changes | the same in every shape: `ParseWorker --from-stream`, the client in `Parsers`, the marker rule, `parse.options`, `run`'s mount and a health field | | |

## Decision
**Shape (b), with the Desk Engineer's protocol, flags and image source, and `desk-svc` as the dispatcher.** Each desk gets one long-lived `desk-parse` sandbox on desk-agent's own image: uid 1113, no network, no `/data`, no capabilities, a read-only root. Its process 1 is `desk-svc -accept`, which forks one worker JVM per connection, with the connection as the worker's stdin and stdout. It's the one shape that runs the same way in all three places. A parse costs what today's child costs, and the file never passes through Docker or a log.

### 1. The sandbox, in each place
**On a cloud desk or a self-hosted desk.** The image's `desk-parse.service` runs `/usr/local/lib/ma/desk-parse-run`, which holds every flag and reads only the image id from desk-agent's release:
```sh
id=$(cat /opt/ma/desk-agent/current/image-id)   # ma-update's load_image writes it; refused unless ^sha256:[0-9a-f]{64}$
exec docker run --rm --name desk-parse --network none --ipc none --user 1113:1113 --read-only \
  --cap-drop ALL --security-opt no-new-privileges --log-driver journald --log-opt tag=desk-parse \
  --memory 160m --memory-swap 160m --pids-limit 64 --cpu-shares 256 --ulimit core=0 --oom-score-adj 500 \
  -v /run/desk-parse/sock:/run/desk-parse/sock -v /usr/local/lib/ma/desk-svc:/desk-svc:ro \
  --entrypoint /desk-svc "$id" -accept /run/desk-parse/sock/parse.sock -accept-mode 0660 -peer-uid 1103 \
  -max-conn 1 -deadline-sec 35 -conn-stdio -clean -- /opt/java/openjdk/bin/java @/app/parse.options
```
- **The unit:**
  - `PartOf=desk-agent.service`, so an update's restart of desk-agent restarts the sidecar on the new image.
  - `Requires=docker.service` and `ConditionPathExists=/opt/ma/desk-agent/current/image-id`.
  - desk-agent's restart back-off (reliability audit S1), `ExecStartPre=-docker rm -f desk-parse` and `ExecStop=docker stop -t 5 desk-parse`.
  - `desk-agent.service` gains `Wants=desk-parse.service`, not `Requires=`: desk-agent still runs, answers health and runs agents while the sidecar is down. Only reading a file waits for it.
- **`tmpfiles.d`:** `d /run/desk-parse 0750 root agent`, `f /run/desk-parse/required 0444 root root - 1` and `d /run/desk-parse/sock 2750 parse agent`.
- **`nftables.conf`:** `meta skuid 1113 reject` in `output`. The sandbox has no network anyway; this covers a later change that runs uid 1113 in the host's.
- **desk-agent's `run` (Desk's):** adds `--mount type=bind,src=/run/desk-parse,dst=/run/desk-parse,readonly` whenever the directory `/run/desk-parse` exists. Connecting writes only the socket, so read-only is enough.

**In a shared-host slot.** `svc-spec.py desk-parse`:
- **Code and identity:** root `rel/desk-agent/rootfs`, the slot's own desk-agent release; uid and gid 1113; no capabilities; the slot's AppArmor profile and seccomp filter.
- **What it's cut off from:** `net="new"` (an empty network namespace), `ipc="new"`, `data=[]` and no `/data` mount at all. Its only share is `desk-parse/sock`, and it gets no writable scratch: no `/tmp` or `/dev/shm` of its own (the read-only root's), and a `/run` that only the sandbox's root can write, holding the share's mount point.
- **Limits:** `mem="160M"`, `pids=64`, `weight=10`, `oom=500`.
- **Command:** `sup` and `argv` as above.

The slot also needs:
- **desk-agent's spec** gains the `desk-parse` share at `/run/desk-parse`, read-only, as its `run` mounts it on a cloud desk.
- **The desk's own container doesn't get either share** (`wallspec.SANDBOX_ONLY`): nothing the desk runs, its root included, can reach the reader's socket or remove its marker.
- **`wallspec.shares()`** gains `desk-parse` (owner 0, group `agent`, 0750, with `required` written by `make_shares`), and inside it `desk-parse/sock` (`parse:agent` 2750).
- **A live switch** of desk-agent (ADR 0078 2.2) switches `desk-parse` with it: `svc_down` takes `desk-parse` down before desk-agent's renames, and `svc_up` makes it again after desk-agent's new sandbox, in a switch, a switch back and a resandbox alike. The host's smoke test for desk-agent also wants `desk-parse`'s sandbox running and its socket there.
- **`desk-host-check`:** `DESK_UIDS` grows to 1113, its `svc-spec` and `oom` checks compare this sandbox as they do the others, and a new `parse` check reads the share, the marker and the sandbox from the host's side.

**`desk-svc`** (`image/host/desk-svc`, built static for arm64 desks and hosts and for amd64 self-hosted desks, its hash pinned as the host's is) gains these flags:
- **`-conn-stdio`:** the connection becomes the worker's stdin and stdout, its stderr goes to `/dev/null`, and its environment is empty, as today's child's. Without the flag, `desk-data` keeps its current stdio. A worker that can't be started is answered one `ERR unavailable` line (the worker's own answer form), so desk-agent says `unavailable`, not `too_complex`.
- **`-deadline-sec N`:** SIGKILL to the worker's group N seconds after it starts.
- **`-clean`:** after each worker ends, `desk-svc`, as process 1:
  1. kills every other process in the sandbox (`kill(-1, SIGKILL)`) and reaps them;
  2. removes anything in its socket's directory but the socket;
  3. checks that the path is still its own listener (device and inode), and binds a new one if not.

  Only then does it serve again. `desk-svc` keeps its own copy of the connection open until the three steps are done, so desk-agent sees the answer end only once the sandbox is clean: the next file can't reach a stand-in listener the last worker left. Nothing a parse starts or leaves behind lives to see the next file: no forked process, no stand-in listener, no file.
- **One at a time:** `-clean` needs `-max-conn 1`, and runs only as process 1 (it refuses to start otherwise). A connection that comes while a worker runs gets `err busy`; one that comes while `desk-svc` cleans up waits for it, so a message's files sent one after another never see `busy`.

### 2. The contract between desk-agent and desk-parse
- **Where:** `/run/desk-parse/sock/parse.sock`, owner `parse` (1113), group `agent`, mode 0660. It sits in `/run/desk-parse/sock` (`parse:agent` 2750), which sits in `/run/desk-parse` (`root:agent` 0750). **Only uid 1103 is served.** The group admits only `agent`, which has no other member, and `desk-svc` checks `SO_PEERCRED` and answers anyone else `err denied`.
- **The marker:** `/run/desk-parse/required`, `root:root` 0444. The image (`tmpfiles.d`) or the host (`make_shares`) makes it. The sandbox can't write there.
- **Request:**
  1. One ASCII line of at most 64 bytes: `parse1 <kind> <maxChars> <maxPages>\n`. `kind` is one of `text pdf docx xlsx pptx`, `maxChars` is 1 to 2000000 and `maxPages` is 1 to 500 (what desk-agent's `files_read` asks for; ADR 0049's attachment ceilings, 400000 and 400, are within them). A line that doesn't fit gets `ERR bad_request`.
  2. The file's bytes: at most 20 MiB, the per-file ceiling. The worker keeps its own 40 MiB guard.
  3. desk-agent shuts down its write side.

  Nothing from desk-agent reaches a command line.
- **Answer:** the same as today. `OK[ <note>]` or `ERR <reason>`, a newline, then the text, and the stream ends when the worker exits. desk-agent reads at most `maxChars × 4 + 1024` bytes, as today.
- **Limits:**
  - One parse at a time: desk-agent's semaphore, and `-max-conn 1`.
  - desk-agent's own 30 s deadline, after which it closes the connection. `desk-svc` kills the worker at 35 s whatever desk-agent does.
  - 160 MiB (128 until the 20 MiB ceiling was measured: see Changes) and 64 tasks for the sandbox; the worker keeps `-Xmx72m`.
  - CPU weight as desk-agent's.
  - `oom_score_adj` +500: under memory pressure, a parse goes before a Browser renderer, because losing one costs only a retry.
- **What desk-agent sees when something fails:**

  | What happens | desk-agent answers |
  |---|---|
  | `err busy` | waits and retries within its existing 15 s busy window, then `busy` |
  | no socket, a refused connection, `err denied`, or a first line that isn't `OK` or `ERR ` | `unavailable` (a new reason word; the Agent app gets its sentence) |
  | the stream ends before a line (the worker ran out of memory or was killed) | `too_complex`, as today |
  | its own deadline | `timeout`, as today |
- **Fails closed:**
  - desk-agent starts the in-container child only when neither the marker nor the socket exists, which means an image from before this ADR.
  - Once it has seen either one, it never starts a child for the rest of that process's life. A missing, stopped or broken `desk-parse` means `unavailable`.
  - desk-agent's health reports `parse: sidecar` or `parse: child`.
  - Where the marker exists, the image's smoke test fails unless health says `sidecar` and a one-line text parse as uid 1103 answers `OK`. So an update that breaks the sidecar rolls back.

### 3. The new uid: `parse`, 1113
`parse`, **1113**, group 1113, no home, `nologin`. The number is free in all three places:
- **The desk image** has 1100 to 1106 and 1110 (`image/recipe/build.sh`).
- **The shared host** adds 1107 to 1109, 1112 and group 1111 (`image/host/recipe/build.sh`); `desk-host-check`'s `DESK_UIDS` stops at 1112.
- **A self-hosted desk** has 1100 to 1106 and 1110 (`selfhost/install.sh`).
- **Contract apps** take 2000 to 2999 (`HelperAppHost`).

It's added in the desk image's `build.sh`, so a host's templates have it too, and in `install.sh`. It's a fixed uid, not `DynamicUser`: a slot has no systemd, and one number lets every check name it.

**What it can read:**
- **Inside its sandbox:** the read-only root of desk-agent's own image (the JRE, `/app`'s jars and the base system's files, none of them secret), `desk-svc`, its socket directory and its own `/proc`.
- **Not:** `/data`, `/run/desk*`, `/opt/ma`, `/etc/ma`, or anything else of the host's.
- **Outside the sandbox:** it owns no file on the host and runs no process.

**The checks** go in a new `verify.sh` section. They read configuration and attempt no escape, per the team's rule. Each has a mutation, as the existing sections do: either a throwaway `desk-parse-mut` started from a copy of `desk-parse-run` with one flag changed, or one value changed and put back.

| Check | Passes when | The mutation that must fail it |
|---|---|---|
| No `/data` | `docker inspect desk-parse`'s mounts are exactly the socket directory and `desk-svc`, and the sandbox's `/proc/self/mountinfo` (`desk-svc check`) has no `/data` or `/run/desk` | the copy with `-v /data/agent:/data/agent:ro` |
| No network | network mode `none`, the sandbox's `/sys/class/net` holds only `lo`, and `output` has the uid 1113 reject | the copy with `--network host`; the reject rule deleted, then put back |
| Identity and wall | user 1113:1113, `CapEff` 0, a read-only root, `no-new-privileges`, 160 MiB, 64 tasks; uid 1113 owns no file outside its socket directory, and group `agent` has no members | the copy with `--user 1103:1103` |
| The socket | `/run/desk-parse` is `root:agent` 0750, `required` is root's 0444, `sock` is `parse:agent` 2750, `parse.sock` is `parse:agent` 0660 | `chmod 0666 parse.sock`, then put back |
| A parse, end to end | as uid 1103 (`setpriv`), a text fixture and a small PDF fixture come back `OK` with their text. Afterwards, uid 1113 runs only `desk-svc`, and `journalctl -t desk-parse` holds no word of either fixture | `systemctl stop desk-parse` fails the same check; after a start it passes |
| Fails closed | desk-agent's health says `parse: sidecar` | desk-agent's unit tests prove the rest: `unavailable` with the marker and no socket, and no child started |

The shared host gets the same rows from `desk-host-check svc-spec` and from `image/host/verify.sh` in a slot. The self-hosted end-to-end test (`selfhost/e2e/`) reads them the same way it reads `desk-notebook`'s.

### 4. Who builds what, in order
Estimates are agent hours from this team's pace (ADR 0036's throttle took 7.5, ADR 0078's build 13 to 17). The only floors are a desk bake (about 20 minutes), a host bake and Security's read.
1. **Desk Engineer, 4 to 6 hours, first.** Its release works on every image, so it goes first:
   - `ParseWorker --from-stream`, which reads the `parse1` line strictly.
   - `/app/parse.options`: today's `Parsers.command` flags, classpath and main class, plus `--from-stream`.
   - The socket client in `Parsers`, with the failure table and the marker rule above.
   - The `/run/desk-parse` mount in `run`, and the `parse` field in health.
   - Tests that no child starts once the marker has been seen.
   - `measure-attach.sh` on a c7g.large, sidecar against child.
   - The ADR 0049 addendum, the README and `services/CLAUDE.md`.
2. **System Engineer, 9 to 13 hours:**
   - `desk-svc`'s three flags, with Go tests and a mutation for `-clean`: 2 to 3.
   - The desk image: the user, `tmpfiles.d`, the unit and `desk-parse-run`, `desk-svc` built at bake, the `nftables` line, the smoke-test check, the `verify.sh` section, then a bake and the test desk: 3 to 4.
   - The shared host: `svc-spec`, shares, the live switch, `desk-host-check`, `verify.sh`, then a bake: 3 to 4.
   - Self-hosted: `install.sh`, `build-bundle.sh`'s checks of `run`, an amd64 `desk-svc` and the end-to-end test: 1 to 2.
   - Docs: `desk-runtime.md` sections 1, 2, 5 and 11, both `RELEASES.md` files, and the image and `selfhost` READMEs.
3. **Security, 1 to 2 hours:** a configuration read of the sandbox in all three places, of `desk-svc -clean` and of the contract, before a member's desk takes it.

Together, about 15 to 21 agent hours.

**Rollout:**
1. **desk-agent release N (Desk's)** carries the client, the marker rule, `parse.options` and `run`'s mount. On today's images it sees no marker and keeps its child, so members see no change.
2. **The images then pin N:** the first desk image baked after the System Engineer's part lands (0.3.8 or later), the next host image after 0.1.15, and the next self-hosted bundle. The image's `verify.sh` and smoke test need N, so the image comes after N.
3. **A newer image with an older desk-agent:** the old desk-agent ignores the marker and keeps its child, as today, and the sidecar sits idle.
4. **A desk-agent newer than its image:** on an image without the marker it keeps the child, while it runs on JDK 21. The JDK 24 move removes the child, and in the sidecar the worker's refusal to run without a security manager. That release waits until every place has the sidecar: Platform's `desk_image#current` and `desk_image#guild`, the host image and the self-hosted bundle. If it ever lands on an image without the sidecar, documents answer `unavailable`. Pictures aren't parsed, so they still work.

## Answers to the Desk Engineer
1. **This shape or another:** your socket, header line, container flags, image source and checks stay. The dispatcher changes, for four reasons:
   - **A slot can't run (c).** It has neither Docker nor systemd, and desk-host takes no requests from a desk. So the dispatcher is `desk-svc -accept` in one long-lived `desk-parse` sandbox, the same on a cloud desk, in a slot and on a self-hosted desk.
   - **Cost:** on a cloud desk, `docker run` per file adds about 140 ms (measured idle, from your README's numbers), on top of a JVM start that both shapes pay.
   - **Logs:** the desks' default log driver is journald, and the journal is persistent. Unless the draft added `--log-driver none`, it would have written each file's extracted text to disk, and the file passes through the Docker CLI and `dockerd` either way.
   - **Two faults in the draft.** `MaxConnections=1` together with `--rm`'s teardown would refuse the next file of a five-file message, which desk-agent reads as `too_complex`. And `RuntimeMaxSec=` stops the Docker CLI, not the container, so a looping parser would keep running.
2. **The uid:** not 1105, which is `notebook` (`desk-notebook`). It's **1113**, `parse`.
3. **Where desk-agent's image id lives:** `/opt/ma/desk-agent/current/image-id`, which `ma-update`'s `load_image` writes (`sha256:` and 64 hex digits; `desk-parse-run` checks the form). In a slot the sandbox runs on `rel/desk-agent/rootfs` instead. The unit is `PartOf=desk-agent.service`, so an update restarts both on the same release.
4. **The fallback:** the rule is no longer "no socket, so use the child". desk-agent uses the child only when the image has neither the marker nor the socket. With either, a failure is `unavailable`, and that holds for the rest of the process's life.
5. **What I need from you** is section 4's first item. Keep the security manager in the worker while desk-agent is on JDK 21.

## Consequences
- **An escaped parser reaches nothing that matters.** A parser that gets out of the JVM finds uid 1113 in an empty network, with no `/data`, no desk socket and no capabilities. Without a kernel bug, the keys, the agent's data and the providers are out of its reach. The security manager stays as a second layer until JDK 24.
- **Memory moves out of desk-agent's container.** It no longer holds the child, so its peak drops by up to 76 MiB (the measured child), and its `--memory` might come down from 320m: the Desk Engineer's call, after measuring. The desk's limits add up to 128 MiB more, but real use grows only by the idle sandbox, est. 10 to 15 MiB on a cloud desk (to be measured).
- **A parse takes the same time as today,** the same JVM start, one at a time.
- **A broken sidecar stops document reading** on that desk (`unavailable`) instead of reopening the hole, and the smoke test rolls back the update that broke it.
- **Honest limits:**
  - The sandbox shares the desk's kernel, so a kernel exploit from the worker escapes every shape here.
  - One long-lived sandbox serves many parses. Keeping one file's reader from seeing the next file rests on `desk-svc -clean` and on `ptrace_scope` 2. A bug there would let a hostile file watch later files on that desk, which on a Guild Desk means other members' files.
  - Root on the desk can still read everything, as before (ADR 0042).

## Changes from the build (2026-11-12)
What building both halves changed above, and why:
- **The ceilings are 2,000,000 characters and 500 pages,** not ADR 0049's 400,000 and 400: desk-agent's `files_read` (the Agent's reader for a document from Files) asks for those, and would otherwise be cut short without saying so (the Desk Engineer's finding). desk-agent's half as merged (`469eb6cb`) still holds 400,000 and 400 in `ParseRequest` and clamps `files_read` to them; raising that one constant is the Desk Engineer's. The sandbox's 128 MiB fit while a file over about 16 MiB could not be read at all (superseded just below: 160 MiB). The worker's heap is capped at 72 MiB whatever the ceilings, and the worst a file can do is fill it. On a c7g.large the sandbox's `memory.peak` over a 100-page PDF, 16 MiB of text and 18 MiB of text (past what the heap holds: the worker ends on its own out-of-memory exit) was 88 MiB of 128, with no kill by the kernel (one run, `docs/sub-status/desk-parse.md`).
- **`desk-svc` answers `ERR unavailable` when it can't start a worker,** where it closed the connection, which desk-agent read as `too_complex` (the Desk Engineer's finding).
- **`-clean` never says `busy` between two files,** and holds the answer open until it has cleaned up. A worker's stream ends as it exits, a moment before `desk-svc` reaps it; without this, desk-agent's next file could get `err busy` (the Desk Engineer's finding) or, after a hostile worker, reach a stand-in listener it left before `desk-svc` killed it (the build's own finding).
- **desk-agent's `run` mounts `/run/desk-parse` read-only whenever the directory exists,** not only with the marker: the Desk Engineer's choice, which keeps the socket visible to desk-agent even if the marker were missing. A slot's desk-agent gets the share read-only to match.
- **`--ipc none` on a cloud and a self-hosted desk:** Docker gives every container a writable 64 MiB `/dev/shm` otherwise, and the slot's sandbox has none.
- **The desk's own container in a slot gets neither `desk-parse` share,** so the desk's root can't remove the marker (on a cloud desk the marker is the host's root's, which the desk's root is).
- **The smoke test passes a desk-agent whose health names no reader** (a release from before this ADR), with a line saying so, so that rollout step 3 (a newer image with an older desk-agent) and a rollback to an older desk-agent still pass. A desk-agent that names one must say `sidecar` and answer a parse as uid 1103.
- **A self-hosted desk's `desk-svc`** is the bundle's: `build-bundle.sh` builds it for amd64 from the bundle's own commit, it is a file of the installer (`selfhost/files/usr/local/lib/ma/desk-svc`, placed there before `installer.sha256` is made, so the signature already covers it; `--sign` builds it again from the commit and refuses any other), not a `bundle.pin` line. It first was a line, which release 2's installed checker (it checks an update) refuses as unknown, so no desk on release 1 or 2 could update; `install.sh` and `ma-selfhost-bundle` require the file.
- **The worker's own JVM output goes to stderr** (Desk's `parse.options`), which `-conn-stdio` sends to `/dev/null`: it reaches neither the answer nor `desk-svc`'s log (a Go test and `verify-parse.sh parse`'s journal check).
- **The sandbox is 160 MiB, not 128 (2026-11-12, the System Engineer, after the Desk Engineer's fix `05485c8b`, which lets every kind read at the 20 MiB ceiling within `-Xmx72m`).** The worker no longer runs out of heap at 17 MiB, so the cgroup is what limits it, and the worst case is a 20 MiB text PDF at `files_read`'s ask (2,000,000 characters, 500 pages): on a c7g.large the worker JVM's RSS reached 141 to 143 MiB, and in a 128 MiB sandbox the kernel killed it in 5 of 6 runs (the answer ended after its first line); the sixth peaked at 126.5 MiB. (The 500-page text PDF the Desk Engineer named is not the worst: its peak was 92 to 97 MiB. A 20 MiB PDF of dense text reads 500 pages out of about 4,000 and costs more.) At 160 MiB the same file reads in 5 of 5 runs, `memory.peak` 130.5 to 132.5 MiB (about 17% free), no kill; the figures are in `docs/sub-status/desk-parse.md`. The same value on a cloud desk (`desk-parse-run`), a slot (`svc-spec.py`) and a self-hosted desk (the same `desk-parse-run`). The kill order is unchanged: the sandbox stays at +500, first under memory pressure, and 32 MiB more adds under 1% of a 3.8 GB desk's score. A desk's total is not raised (the sandbox is inside the slot's own `memory.max` on a host); on a cloud desk its idle cost is still the idle `desk-svc` and shim. The cap on pages is not the answer: the owner's ceilings stand.

## Amendment proposed: Courier's mode (2026-11-14, Courier's Wave 1.2)
The draft ADR "Courier's store" §4 proposes, and `sub/mm-courier-parse` builds the code half of, a second instance of this sandbox for deskd: `desk-parse-courier`. It has the same wall and limits, the same image (desk-agent's, which carries `services/courier-parse` in `/app/lib`) and the same `desk-svc -accept`. What differs:
- **Its socket:** `/run/desk-parse-courier/sock/parse.sock`, serving uid 1100 (deskd) only (`-peer-uid 1100`).
- **Its command:** `java @/app/courier-parse.options`, the same JVM flags with the main `CourierWorker`, and a 15 s deadline.
- **The order of deadlines** (Security CP-L1): the worker ends itself at 10 s, `desk-svc` kills it at 15 s and cleans up, and deskd gives up only at 20 s. So a stream always ends by `desk-svc`'s close after `-clean`, and a worker that stays silent can never be there for deskd's next request. desk-agent's instance has the same order to keep (Security CP-I1: `Parsers` gives up at 30 s, `desk-svc` kills at 35 s), which is the Desk Engineer's to change.
- **One mount more:** the image's tracker list (ADR 0076's pinned EasyPrivacy, as hosts), read-only.

It's a second instance, not a mode of this one, because this one serves uid 1103 alone and one file at a time: a mailbox's first sync would starve the Agent's attachments. The exact image change (unit, `tmpfiles.d`, deskd's mount, the slot's `svc-spec`, `verify.sh` rows) is in `docs/sub-status/mm-courier-parse.md`, for the System Engineer. Until it's baked, deskd finds no socket, and mail waits as `pending`, raw bytes kept.
