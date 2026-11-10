# 0012. LLM provider keys: desk-encrypted KMS envelopes, Platform-blind

**Status:** Superseded by [0042](0042-llm-keys-sealed-on-the-desk.md) (2026-11-07; noted 2026-11-09)
**Date:** 2026-11-04
**Amended:** 2026-11-04 by [0022](0022-desk-connectivity-hybrid-webrtc.md) (key entry path)

## Context
- Members bring their own provider API keys. A desk may use its own key or reuse one the account already has, including while the source desk is stopped.
- The Agent draft proposed desk-side envelope encryption with a KMS key that only the member's desk roles can use. Platform's draft ADR 0018 already has one CMK (`ma-llm-keys`), desk-side Decrypt bound to the role's `UserId` tag, and assignment per desk, but its API encrypts, so plaintext passes through Platform. The VM draft's "no instance profile" would have ruled out KMS on the desk.

## Decision
- A key is entered only in the Desk app's Agent settings and goes only to deskd, over the desk's DTLS data channel, end to end; the gateway and TURN never see it (ADR 0022).
- deskd validates it with a free model-list call, then calls `kms:GenerateDataKey` on `ma-llm-keys` with encryption context `{UserId, KeyId}` and encrypts with AES-256-GCM. The envelope plus metadata (provider, label, last 4, created-by desk) is stored in Platform's `llm_keys` and cached on the desk.
- A new key is assigned to **this desk only**; "use on my other desks" adds assignments with step-up auth.
- deskd decrypts with the desk role and passes the plaintext to the agent runtime over a local socket. Plaintext exists only in RAM: briefly in deskd (validation and decrypt, zeroed after hand-off, best effort in Node) and in the agent runtime while in use. No swap (zram only), no core dumps and no hibernation (ADR 0007), so a key never reaches a disk without a logged `kms:Decrypt`. Platform's API roles have no Decrypt.
- Delete and rotate need step-up auth; desks wipe on a `notify keys` push or a heartbeat signal; the UI tells the member to revoke at the provider too.

## Consequences
- A Platform database or API compromise yields only ciphertext. Cost: Platform's one CMK, $1/month total.
- Amends Platform's draft ADR 0018: the desk role needs `GenerateDataKey`, and the API never receives plaintext (design §13.2). Under the hybrid, Platform's API would otherwise be the only place a key's plaintext touched Platform.
- AWS admins could still rewrite the key policy, or read a running desk's memory through SSM; CloudTrail with a policy-change alarm and SSM-command alarms make that visible, once Platform's trail exists (design §13.1 need #15; none today).
- Alternatives rejected: desk-only storage (re-paste per desk), a Platform-decryptable secret store (one breach leaks every key; Secrets Manager at $0.40/secret/month), a separate `ma-desk-secrets` key (duplicates Platform's CMK).
