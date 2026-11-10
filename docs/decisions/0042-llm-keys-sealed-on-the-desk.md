# 0042. LLM keys are sealed on the member's desk

**Status:** Accepted
**Date:** 2026-11-07
**Supersedes:** [0012](0012-llm-keys-desk-encrypted-envelopes.md), and the parts of design §9.5 and §10.4 that rest on it

## Context
- `desk-agent` runs a member's agents with the member's own LLM key. Until now a key lived only in `KeyRing`, in RAM, waiting for the KMS envelopes of ADR 0012, which were never built. So any restart, an update included, lost it, and the member had to add it again.
- The owner rejected that as the lazy choice. His requirement: keys are stored encrypted on the member's desk; they survive restarts, updates and reboots; the platform can't read them; nothing depends on a platform-held decryption key, because self-hosted desks have no AWS; keys move with the export and transfer and are deleted with the desk.
- ADR 0012 can't meet that. A key sealed under Platform's `ma-llm-keys` can't be opened on a self-hosted desk, whose role is denied `kms:*`, and it can't be opened anywhere once Platform is gone.

## Decision
- **`desk-agent` keeps its keys in `/data/agent/keys/`,** mode `0700`, owner `agent` (`agent/key/KeyVault`). No KMS, no Platform call, no copy off the desk.
- **`master.key`:** 32 random bytes, mode `0600`, made once. It's in memory only while sealing or opening, in an array zeroed afterwards. `SecretKeySpec` and `Cipher` keep their own copies until the collector reuses the memory: best effort, as with everything on the JVM's heap.
- **`<keyId>.sealed`:** one immutable file per key, mode `0600`. `MAKV`, a version byte (1), a random 12-byte nonce, then AES-256-GCM ciphertext and tag. The AAD is the magic and version, then the key id and the provider, each after its `u16be` length, so a file moved to another row won't open.
- **Every write** goes to a temporary file, is fsynced, renamed atomically, and then the directory is fsynced.
- **The secret is never in `agent.db`, and no SQLite schema changes,** so a rollback to an older `desk-agent` is safe: it sees `no_key`.
- **`agent.db`'s `keys` row stays the commit point:**
  - **Add:** check the format, validate with the provider, seal durably, then insert the row. If sealing fails, the answer is `unavailable` with `reason: storage`, and nothing stays in RAM or on disk. If the insert fails, the sealed file is removed. RAM only is never a fallback.
  - **Delete:** delete the row, which unbinds agents; zero the key in `KeyRing`; unlink the sealed file and fsync the directory; only then answer. If the unlink fails, the answer is `unavailable` with `reason: storage`: the same call finishes it, or the next start does.
  - **Start:** make or tighten the directory and files to the modes above, as a move or a restore may have changed them; remove leftover temporary files; unseal each row's file into `KeyRing`. A sealed file with no row is an orphan from a crash, and is deleted. A row whose file is missing or won't open stays listed with `available: false`, and its file is kept until the member deletes the key.
- **A bad vault never stops `desk-agent` from starting or answering health.**
  - A missing `master.key` is made again. Old sealed files then fail their tag and read as unavailable.
  - A `master.key` that isn't 32 bytes in a regular file is renamed to `master.key.bad-<n>`, never overwritten, and a new one is made.
  - A `master.key` that's there but can't be read is left alone, and adding a key answers `reason: storage`, since fixing its owner brings every key back.
- **`agent.key.list` gains `available`,** whether `KeyRing` holds the key. Sending on an unavailable key still gets `no_key`.
- **Audit:** `key.add` and `key.drop` as before, and one row per start when there's at least one key: `key.restore`, target `keys:all`, decision `restored:<n>:unreadable:<n>`. An unavailable key's delete is `key.drop` with `not_held`.

## Honest limit
`master.key` sits on the desk's own disk, beside what it seals. **No Platform service or API can read a key. Someone with root on that machine or its volume could,** which is the same limit as everything else on a desk (design §9.5 "Honest limit", §10.4). In particular:
- **Root on a running desk:** SSM break-glass, and the automated updates that run as root.
- **Whoever holds the volume or a snapshot:** the sealing keeps a key out of a casual read of `agent.db` and out of logs, and adds nothing against someone holding the whole disk. A DLM snapshot holds both files for its 7 days, so restoring one brings back a key deleted since.
- **Whoever controls Platform's token signing:** a forged `owner` or `export` token could call `data.read` on `agent/keys`, as it could on the Browser's cookies (§10.4).
- **Delete means unlinked,** not erased from the disk's blocks or from a snapshot. Revoking at the provider is the only real revocation, as before.
- **`deskd` sees a key on its way in** and can ask `desk-data` for any part of `/data`, so a compromised `deskd` can read them too.

## Consequences
- **Self-hosted and cloud desks work the same,** and a key no longer depends on AWS or on Platform existing.
- **A key belongs to one desk.** Using it on another desk means entering it there. ADR 0012's "use on my other desks" and reading a key while its source desk is stopped are gone, since Platform holds no envelope to hand over.
- **Keys move with the desk.** `tools/desk-data` excludes nothing from the `agent` part, so an export and a move carry `master.key` and the sealed files. The export's ZIP therefore holds working keys, as it already holds the Browser's saved passwords, and must say so. A move leaves the source desk's copy in place until that desk is removed.
- **Platform's `ma-llm-keys` CMK, its `llm_keys` envelopes and `notify keys` have no user on the desk side.** Metadata and limits are a separate question for the Platform Engineer.
- **Later tools must not run as uid `agent`,** or see `/data/agent/keys`: a tool that can read that directory can read every key.
- **Amended (task 49 fix pass, 2026-11-08): the workspace tools do run inside `desk-agent`, as uid `agent`, beside `/data/agent/keys`.** They are the one exception to the line above, and they are not a shell or a program an agent runs: each call is a few methods of `workspace/Workspaces`, in the service's own process.
  - **What holds the two apart:** the workspaces live in `/data/workspaces/<agentId>/`, a different tree from `/data/agent/keys`. Every path is relative and checked before use: no empty, `.` or `..` component, no absolute path, backslash, control, Unicode format or bidi character, at most 16 components. It is walked one component at a time without following links, and a link met on the way or at the end is refused. A file with more than one hard link is refused for reading and writing, so a hard link to a key file can't be read through a workspace name. The last component is opened without following links, and a write goes to a temporary file and is moved over the name. No tool of an agent makes a link, renames a folder or runs a program, so nothing inside a workspace can point at the key folder. A shared workspace is read-only, and a message-started run can't read one.
  - **What remains:** it is one process and one uid, so a flaw in `Workspaces` would reach the keys, not the kernel's permissions. Java has no `openat`: a folder swapped for a link between the check and the use would be followed. Nothing swaps one today, because `desk-agent` is the only writer and the calls of one agent are serialised, but a second writer into `/data/workspaces` (a restored backup, a tool added later, an import) would reopen that gap. A hard link made outside `desk-agent` onto a file the workspace later holds is caught by the link count only if it is made before the check.
  - **The rule stands for everything else:** any tool that runs code or a shell, or reads files by a name an agent chooses outside `Workspaces`, must run as another uid with no access to `/data/agent/keys`.
- **A key added before this, on a desk that had the RAM-only `desk-agent`,** has a row and no file, so it reads as unavailable. The member adds it again and binds the agent to it.

## Alternatives rejected
- **A platform-held KMS key (ADR 0012):** breaks self-hosted desks, which have no AWS, and privacy, since the platform holds what opens the key.
- **A member passphrase:** typing it after every restart is what the owner rejected, and an update restarts the service on its own.
- **A TPM:** a desk moves between machines, and the sealed key would stay behind on the old one.
- **A client-held wrapping key:** agents couldn't run unattended while no client is connected, and a lost secret loses the keys.
- **The secret in `agent.db`:** a rollback would leave it in a file the older version doesn't know is sensitive, and SQLite's WAL and free pages keep old copies after a delete.
