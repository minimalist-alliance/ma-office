# courier-envelope

Courier's envelopes: the desk's keys, sealing, signing, the drop, pin checks and safety numbers. Package
`com.minimalistalliance.desk.courier.envelope`. deskd ships it (`courier/keys/`); courier-testkit's fake relay and peer
desks use it. The decision is the draft ADR [`draft-courier-envelope`](../../docs/decisions/draft-courier-envelope.md);
the wire format is ma-platform's contract 0.4.0 §2 (`docs/contracts/relay.md`).

**No home-made crypto.** HPKE (RFC 9180), Ed25519 (RFC 8032) and X25519 (RFC 7748) are Bouncy Castle's
(`bcprov-jdk18on` 1.86, MIT). This library builds `info`, `aad`, padding and JSON, as the contract says.

| Class | What |
|---|---|
| `IdentityKeyPair`, `IdentityKey` | The desk's Ed25519 identity: signs envelopes and the box key's binding; what contacts pin. Public keys are checked as prime-order points |
| `BoxKeyPair`, `BoxKey` | An X25519 box key: what senders seal to. Low-order points are refused |
| `PublishedKeys` | `{identityKey, boxKey, binding}` for the key directory; the contract's `fingerprint` (what invite links carry) |
| `Envelope` | The relay's envelope: `info = "ma-courier/v1 " + kind`, `aad = "ma-courier/v1 env\n" + kind + "\n" + to`, `0x80` padding to a bucket, HPKE seal and open (every address and box key the desk keeps) |
| `Signed` | The `{p, s}` payload inside an `ma` envelope (and, as proposed, `mail`): sealed sender, strict reading, `p.to` checked, the signature verified with the pinned key |
| `Drop` | A body too big for an envelope: a random content key, 64 KiB chunks under Bouncy Castle's HPKE `AEAD`, padded to a drop bucket, checked against the signed reference |
| `KeyCheck` | Pin checks on the identity key: `SAME`, `FIRST_VERIFIED`, `FIRST_UNVERIFIED`, `CHANGED`, `INVITE_MISMATCH`, `STALE`, `INVALID` |
| `SafetyNumber` | 60 digits both members compare (Signal's construction over the identity keys) |
| `Padding` | The contract's buckets: envelopes 256 B to 64 KiB, drops 64 KiB to 64 MiB |

## Sending and receiving a member's message

```java
// Send: look the recipient up (GET /v1/agent/keys/lookup), check against the pin, seal, POST /v1/agent/relay/send.
PublishedKeys theirs = PublishedKeys.fromJson(lookupAnswer);
if (!KeyCheck.check(pinned, lastKeysVersion, theirs, inviteFingerprint).usable()) { /* block, ask the member */ }
Envelope.Sealed sealed = Signed.seal(myIdentity, theirs, payload);   // payload: v, kind, id, from, to, at, ...
relaySend(sealed.toJson());

// Receive: open with this desk's addresses and box keys, verify with the sender's pinned identity, store, then ack.
Envelope.Sealed got = Envelope.Sealed.fromJson(relayEnvelope);
Signed.Unverified u = Signed.open(got.kind(), deskKeys.recipient(), got.enc(), got.ct());
Signed.Verified v = u.verify(pinnedIdentityFor(u.from()));            // or look up and pin on first contact
```

A body over 64 KiB goes in the drop: `Drop.sealer(body)`, reserve `bucket()` bytes (`POST /v1/agent/relay/drops`),
`write` it to the presigned URL, then put `reference(dropId)` in the payload. The receiver calls `Drop.open(reference,
bytes, in, out)` into a staged file and uses nothing of it unless that returns.

## Test vectors
`src/test/resources/courier-envelope/vectors.json`: fixed seeds, the published keys and fingerprint, a safety number,
and an inline `ma` envelope, one with a drop and a proposed `mail` one, each from a fixed HPKE ephemeral seed.
`VectorsTest` regenerates it byte for byte; `-Dcourier.envelope.writeVectors=true` writes it after a deliberate change.

## Run
`./mvnw -q -pl courier-envelope test` from `services/`: 32 tests, a few seconds.
