# Draft. Courier's envelopes: the desk's keys, sealing, signing and the drop

**Status:** Proposed (draft; numbered from the Desk range 0110 to 0119 when it's accepted). **Built** on `sub/mm-courier-keys` (the launch plan's Wave 1.4): `services/courier-envelope`, deskd's `courier/keys/`, and `/data/keys` on the image recipe. In no release and on no desk. The Courier sandbox, `/data/courier` and now `/data/keys` wait on the image (IMG-0.3.9).
**Date:** 2026-11-14
**Decision:** the owner, Nov 12: Courier is prelaunch at the production bar ("VERY solid and capable... pretty much production ready, no MVP"). The coordinator's brief for CR-1.4: HPKE to seal, Ed25519 to sign, well-reviewed libraries only, no home-made crypto, keys on the desk, rotation, safety numbers, matching Platform's contract 0.4.0.
**Builds on:** [0017](0017-sealed-relay-desk-to-desk.md) as amended by [draft-courier-relay](draft-courier-relay.md); [0042](0042-llm-keys-sealed-on-the-desk.md); [0074](0074-privacy-claim-operator-blind-and-audited.md); [0079](0079-each-desk-has-its-own-chat-address.md) as amended by [draft-courier-address](draft-courier-address.md); [draft-courier-store](draft-courier-store.md); the task 08 spike (`spikes/chat/README.md`).
**Contract:** ma-platform `docs/contracts/relay.md`, 0.4.0 (on `sub/courier-relay`, `0c377924`), §2 (the wire format both sides agree) and §3.1 (keys). This draft is the Desk side of §2; where the two differ in words, §2 says what goes on the wire.

## Context
- Courier carries member-to-member messages sealed desk to desk, and email to the desk's own address sealed by Platform's mail door. Both wait in Platform's relay while a desk sleeps (draft-courier-relay).
- The spike proved the design (HPKE plus Ed25519, 24 of 24 checks) with a hand-written HPKE key schedule over the JDK's DHKEM. Production code may not carry home-made crypto.
- Platform's contract 0.4.0 fixes the outer envelope, the key encoding and binding, the padding and the drop buckets, and writes down the `ma` inner format the Desk side proposed.

## Decisions

### 1. Primitives come from Bouncy Castle
- **HPKE** (RFC 9180, base mode, suite DHKEM(X25519, HKDF-SHA256) `0x0020`, HKDF-SHA256 `0x0001`, ChaCha20-Poly1305 `0x0003`): Bouncy Castle's `org.bouncycastle.crypto.hpke.HPKE`, its sealing context, and its `AEAD` (RFC 9180's nonce sequence) for the drop's chunks.
- **Ed25519** (RFC 8032) and **X25519** (RFC 7748): Bouncy Castle's lightweight API. Public identity keys are checked as full points of the prime-order subgroup; box keys by a trial agreement, which refuses every low-order point.
- **Why Bouncy Castle:** the JDK 21 has DHKEM but not HPKE's key schedule, which is what the spike wrote by hand. Bouncy Castle is MIT-licensed, maintained for 25 years and widely reviewed. `bcprov-jdk18on` 1.86 is managed by the Spring Boot parent; its jar is about 8.6 MB on disk, and only the classes used load.
- **Checked against the RFCs:** RFC 9180 A.2.1 (open and seal from its ephemeral seed), RFC 8032 §7.1 tests 1 and 2, and Bouncy Castle's Ed25519 against the JDK's on random messages (`PrimitiveVectorsTest`).
- **This code only lays bytes out.** `info`, `aad`, padding, the payload's JSON and the drop's layout are the contract's, and nothing in `courier-envelope` combines primitives in a new way.

### 2. The keys
- **An identity key** (Ed25519): what the desk signs with, what contacts pin, what the safety number is made from. Made once; it changes only on a reset (or when its file is lost or damaged), and then every contact sees a key change.
- **A box key** (X25519): what senders seal to, bound to the identity by the contract's `binding` (the identity's signature over `"ma-courier-key/v1 bind\n" + boxKey`, the box key's base64url text). It rotates.
- **Published** with `PUT /v1/agent/keys` (contract §3.1) at every start (the same keys again are `changed: false`) and after every change. Only while Courier may run on the desk: not a Guild Desk's, a teen's, a desk whose band isn't known yet, or while Courier's switched off. A refusal that won't change (`desk_kind`, `keys_invalid`, `binding_invalid`) stops trying until deskd restarts; anything else (`courier_paused`, the platform unreachable, `keys_change_limit`) is tried again at Courier's next hourly sweep, or after the platform's `Retry-After`.

### 3. Where the keys live
```
/data/keys/                 0700, uid 1100 (deskd); desk-datadirs makes it, deskd never does
  identity.key              0600  "MAIK" || 0x01 || i64be createdAt || seed (32) || SHA-256 of the 45 bytes before
  box-<id hex>.key          0600  "MABK" || 0x01 || i64be createdAt || secret (32) || SHA-256 of the 45 bytes before
```
- **Design §10.4 reserved `/data/keys/` for this.** It's its own mount in deskd's container (`docker/run`, `MA_KEYS_DIR` for tests), made by `desk-datadirs` and checked by `verify.sh` (1100:1100 0700, nothing inside but uid 1100's 0600 files).
- **Writes:** a temporary file, fsync, an atomic rename, the directory fsynced. **Reads:** without following links, a regular file of exactly 77 bytes, magic, version and digest checked. The digest catches a cut or changed file by accident only: whoever can write here can write a key.
- **At start:** modes tightened to 0700 and 0600, a crash's temporary files removed.
- **A file that's provably not a key** (a link, the wrong type or size, the wrong magic, a bad digest) **is renamed aside** (`.bad-N`), never overwritten.
  - **A key file in a later release's format** (the right magic, another version, of any size) leaves the keys unavailable and the file as it is, so a rollback after a format change waits for that release instead of making a new identity (Security CK-I1).
  - **A missing identity beside kept box keys** is a lost identity, not a first start: a new one is made and `replacedAt` says so (CK-I2). `replacedAt` lives in memory, so it shows until deskd restarts.
  - **A damaged identity means a new identity.** Contacts then see a key change, which is the truth. `courier.keys` says `replacedAt`. The old box keys stay, to open what's already waiting, and a new box key bound by the new identity becomes current.
  - **An identity file there but not ours to read** (`AccessDeniedException`) is left as it is, and the keys are unavailable: fixing its owner brings the same identity back.
- **No `/data/keys`** (an image before this one): `courier.keys` answers `unavailable`, `reason: keys`, nothing is published, member messages and the mail door can't be used, and nothing else in deskd changes.
- **Never in a download** (`tools/desk-data`: `keys` is a machine part, as `rtc` is; `desk-move` lists it as one too, CK-I7): a file holding them would let whoever has it sign as the desk and open what's sealed to it. **A move doesn't carry them yet** (Wave 3.3, as the vault): the moved desk makes new keys, its contacts see a key change, and envelopes sealed to the old box key are lost unless collected before the move.
- **The honest limit** (ADR 0042, ADR 0074): the keys sit on the volume in the clear. Root on the running desk, or whoever holds the volume or a snapshot, can read them.

### 4. Rotation
- **The box key rotates every 180 days** (`DeskKeys.Settings.rotateEvery`), checked at start and at Courier's hourly sweep (no timer of its own). The identity stays.
- **Retired box keys are kept 97 days** after the next one replaced them (the relay's 90-day mail wait, plus a week), then deleted. The current one is never deleted, however old.
- **Contacts don't notice a rotation:** they pin the identity, and a new box key the same identity binds is the same contact (decision 6).
- **Why 180 days, not 30:** the contract's `fingerprint`, which invite links carry, covers the box key, so an invite made before a rotation reads as a mismatch afterwards (and the member checks the safety number instead). A long period keeps that rare; rotating faster buys little, because the box key and the identity key sit side by side on the same disk.
- **A reset** (`DeskKeys.resetIdentity`): a new identity and a box key it binds; the old box keys stay 97 days. Not offered to the member yet (question 4).
- **What rotation doesn't do** (Security CK-I5): a binding carries no date and `keysVersion` is the platform's, unsigned, so the directory (or a replayed lookup) could still serve an older box key the same identity once bound, and it reads as the same contact. Mail sealed to a box key the desk already deleted is lost; one sealed to an old key whose secret leaked (an old snapshot, say) is readable by whoever holds it. The platform can drop mail anyway, which is why rotation is about bounding a leak, not about trust. A later contract can put `createdAt` in the binding.

### 5. The envelope (contract §2.2)
```
info = "ma-courier/v1 " + kind                         kind: ma (a member's desk) or mail (the mail door)
aad  = "ma-courier/v1 env\n" + kind + "\n" + to         to: the recipient's canonical address
pt   = plaintext || 0x80 || 0x00... to a bucket        256, 512 ... 4,096, then 8,192, 16,384, 32,768, 65,536
enc, ct = HPKE.Seal(boxKey, info, aad, pt)             the relay refuses a ct whose length less 16 isn't a bucket
relay   = {to, kind, enc, ct, drops?}                  enc and ct base64url
```
- **Opening is strict:** the bucket, then HPKE with each of the desk's addresses (the open one, then the closed ones, newest first: a sender may have looked it up before a rename) and each box key it keeps (the current one first). The padding must be `0x80` then zeros, and the shortest that fits. A low-order `enc` is refused.
- **Envelopes don't say which box key they were sealed to** (the contract's outer shape has no key id), so a desk tries each one it keeps: one X25519 agreement per key, and a handful of keys at most.

### 6. The payload, and who sent it (contract §2.2, "Inner, kind ma")
```
plaintext = {"p": <payload, a JSON object as a string>, "s": <Ed25519 signature, base64url>}
p         at least v (1), kind, id (a ULID), from, to (canonical addresses), at (RFC 3339 with milliseconds)
s         Ed25519 by the sender's identity over "ma-courier/v1 sig\n" + p
```
- **Sealed sender:** the sender's address is only inside the seal, never on the relay's record.
- **Read strictly:** exactly `{p, s}`, one JSON object, no repeated key, shallow, short strings, nothing after it. Every required field is checked for shape before anything else is read: the kind, a ULID, lower-case canonical addresses with no tag, a time with milliseconds.
- **`p.to` must be the address that opened it,** so a payload signed for someone else and sealed again to this desk is refused (`not_for_me`).
- **The signer's key isn't in the envelope:** the receiver takes the identity pinned for `p.from`, or looks it up on first contact (`GET /v1/agent/keys/lookup`) and pins it, then verifies `s` over `p`'s exact bytes. Duplicates are dropped by `p.id` (the store's sink, keyed on `(ma, from + id)`, Wave 2.5).
- **Replay is the transport's to stop** (Wave 2.5; Security CK-I6): the relay keeps every envelope's ciphertext until it's acked or expires, so it could hand one back after the member deleted the message. The transport refuses a `p.at` older than the relay's wait (30 days for `ma`, 90 for `mail`) plus clock skew, and keeps the `(from, id)` key as a tombstone at least that long after a delete.
- **Pins are on the identity key** (`KeyCheck`):

| What the directory gives, against the pin | Verdict | What the desk does |
|---|---|---|
| The pinned identity, binding valid (the box key may be new) | `SAME` | Seal; store the new box key |
| No pin, an invite's fingerprint matches | `FIRST_VERIFIED` | Pin, checked |
| No pin, no invite | `FIRST_UNVERIFIED` | Pin, unchecked (TOFU); the first message lands in Requests (plan §2.4) |
| Another identity | `CHANGED` | Block sending and offer no default until the member checks the new safety number (spike Q-C4) |
| No pin, an invite's fingerprint doesn't match | `INVITE_MISMATCH` | Refuse; the invite wins |
| The pinned identity, an older `keysVersion` than one already used | `STALE` | Keep the newer |
| A binding that doesn't verify | `INVALID` | Refuse |

### 7. Safety numbers and fingerprints
- **The safety number** (`SafetyNumber`) is Signal's displayable fingerprint construction, unchanged but for its inputs: for each desk, SHA-512 iterated 5,200 times over a version, its identity key and the identifier `ma-desk`; the first 30 bytes as six 5-digit groups; the two desks' 30 digits in a fixed order. Both members see the same 60 digits. It covers the identity keys only, so a box key's rotation never changes it. `courier.keys {peer}` gives it for a contact (API.md §21).
- **The fingerprint** is the contract's (§2.1): SHA-256 over `"ma-courier-key/v1\n"`, the identity key and the box key, its first 16 bytes as 8 groups of 4 hex. What invite links carry (`ma://courier/<address>#k=<fingerprint>`). Computed on the desk; the platform's copy is informational, and the desk logs a warning if the two ever differ.

### 8. The drop (contract §2.3; Desk-owned)
- **For a body too big for an envelope** (the mail door's large mail; later a member's attachment): a random 44-byte content key, a ChaCha20-Poly1305 key and a base nonce, for this one body.
- **Chunks of 64 KiB,** each sealed by Bouncy Castle's HPKE `AEAD` (RFC 9180's `base_nonce XOR seq` and its counter) with `aad = "ma-courier/v1 drop\n" || u64be index || last (0 or 1)`; then zeros up to the drop bucket (powers of two from 64 KiB to 64 MiB). At most 48 MiB of body (the store keeps raw mail up to that), so always one drop.
- **The reference in the signed payload:** `drop: {id, key, len, sha256, bytes}`. The sender reserves the drop first (`POST /v1/agent/relay/drops`), so its id is known before signing. The receiver checks the sizes agree with the relay's, opens each chunk in order, and checks the body's SHA-256; nothing it wrote may be used until that passes (write it staged). A drop cut, grown, reordered, swapped for another body's or under another key fails.

### 9. The mail door's `mail` payload (proposed for 0.4.1, CR-2.3)
The contract leaves it to 0.4.1. Proposed, and what courier-testkit's fake door does:
- **The same `{p, s}` layout, signed by the door's own Ed25519 key under its own signing domain,** `"ma-courier/v1 mail sig\n" + p`, so a door's signature and a desk's can never stand for each other.
- **`p.kind` is `mail`; `p.from` is `mailer-daemon@<courier domain>`,** a name the contract already reserves (relay.md §1), so no member can hold it. Then `mailFrom`, `verdicts` (`spf`, `dkim`, `dmarc`, `spam`, `virus`) and the raw message, inline as base64url (`raw`) or in a drop (`drop`).
- **A `mail` payload only in a `mail` envelope, and a `mail` envelope only with one** (`Signed.open` refuses either mismatch; Security CK-L1). A desk verifies a `mail` payload with the door's key only, never a key looked up for its `from`. Without this, a member could seal an ordinary `ma` envelope holding a "mail" payload with made-up verdicts, signed by their own key.
- **Desks learn the door's key from the platform** (proposed: `GET /v1/agent/courier-addresses` gains `doorKeys`); the platform reads that mail in the clear anyway, so trusting it for the key adds nothing.
- **Wave 2.5 adds** (draft-courier-transports §9): `verdicts.dmarcDomain`, and a third form beside `raw` and `drop`, `note` (a delivery note or a removal); built on the desk and in the test kit's door.

### 10. Test vectors
`services/courier-envelope/src/test/resources/courier-envelope/vectors.json`: fixed seeds for a recipient, a sender and the door; the bytes of a published key set, its fingerprint and a safety number; an inline `ma` envelope, one with a drop (the drop's key, length and SHA-256) and a proposed `mail` one, each from a fixed HPKE ephemeral seed (`ikmE`, RFC 9180's DeriveKeyPair). `VectorsTest` regenerates the file and fails on any byte of difference. Platform's door (TypeScript) can build against it.

## Consequences
- Every desk-to-desk and door-to-desk delivery shares one sealed, padded, signed format, and the relay sees only the recipient, the time and a bucket's size.
- deskd carries Bouncy Castle's provider jar (about 8.6 MB on disk). Loading the keys, an X25519 agreement and an Ed25519 signature cost well under a millisecond each on the build box.
- A desk that loses `/data/keys` gets a new identity, and its contacts see a key change: honest, and recoverable only by the members checking safety numbers.
- An invite link made before a box key rotation reads as a mismatch afterwards (decision 4).
- **Rejected:** the spike's own HPKE key schedule (home-made); Google Tink (its hybrid API has no separate AAD, and it brings protobuf); pinning both keys (every rotation would ask every contact to re-check); a key id in the envelope (the contract's outer shape has none).

## Questions, each with the default taken
1. **The contract's wording (Platform):** §2.1 says the safety number "is built from" the fingerprint, and §3.1 that contacts who pinned the old keys see a key change on any change. Desks build the safety number from the identity keys and pin the identity, so a box key rotation is invisible to contacts. *Default:* as built; Platform updates the two sentences in its next contract edit.
2. **The fingerprint covers the box key (Platform, Desk):** invite links made before a rotation then mismatch. *Default:* keep the contract's fingerprint and rotate every 180 days. The alternative is a fingerprint over the identity only.
3. **The `mail` payload and the door's key (Platform, CR-2.3):** decision 9. *Default:* as proposed.
4. **A member-facing "Reset this desk's keys" (Product Designer):** `DeskKeys.resetIdentity` exists. *Default:* not offered until the Designer specs it with the safety-number words.
5. **A move carrying `/data/keys` (Wave 3.3):** *Default:* not yet; the moved desk makes new keys. A move should carry them under its own protection, as the vault's sign-ins.
6. **Drop buckets cost Platform's storage up to twice the body** (powers of two). *Default:* as the contract says; Padmé (at most 12% over) is the cheaper option if storage matters.
