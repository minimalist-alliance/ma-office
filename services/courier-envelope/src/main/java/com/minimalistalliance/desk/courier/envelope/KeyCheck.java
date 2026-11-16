package com.minimalistalliance.desk.courier.envelope;

/**
 * Whether to seal to keys the directory handed out, and whether an envelope's signer is who it says, given what this desk
 * pinned for that address (the spike's step 11 and Q-C4; the plan's §1.3: "keys are pinned on first contact, invite links
 * carry the key's fingerprint, the contact view shows a safety number, and a changed key blocks sending until the member
 * checks it").
 *
 * <p><b>Pins are on the identity key.</b> A new box key under the same identity, bound by that identity's signature, is
 * the same contact: it reads {@link Verdict#SAME} and the caller stores the new box key, so a desk's routine box key
 * rotation never asks a member to re-check anyone. Only a new identity key is a change. Where pins live (the contact's
 * endpoint in {@code courier.db}) is the transport's (Wave 2.5).
 */
public final class KeyCheck {

    public enum Verdict {
        /** The pinned identity with a valid binding (the box key may be new): seal and accept as usual. */
        SAME(true),
        /** No pin yet, and the invite's fingerprint matches these keys: pin them, as checked. */
        FIRST_VERIFIED(true),
        /** No pin yet and no invite: trust on first use. Pin it, unchecked; the contact view offers the safety number. */
        FIRST_UNVERIFIED(true),
        /** A different identity from the pin: block sending and offer no default until the member checks the new number. */
        CHANGED(false),
        /** No pin yet, and an invite's fingerprint doesn't match the directory's keys: refuse; the invite wins. */
        INVITE_MISMATCH(false),
        /** The pinned identity, but an answer older (by the platform's counter) than one already used: keep the newer. */
        STALE(false),
        /** The binding doesn't verify, or there are no keys. */
        INVALID(false);

        private final boolean usable;

        Verdict(boolean usable) {
            this.usable = usable;
        }

        /** Whether a sender may seal to these keys without the member doing anything. */
        public boolean usable() {
            return usable;
        }
    }

    private KeyCheck() {}

    /**
     * @param pinned the identity pinned for this address, or null if none yet
     * @param lastKeysVersion the {@code keysVersion} of the newest answer used for the pin, or -1
     * @param presented what the directory (or an invite flow) gave
     * @param inviteFingerprint the invite link's {@code #k=}, or null
     */
    public static Verdict check(IdentityKey pinned, long lastKeysVersion, PublishedKeys presented, String inviteFingerprint) {
        if (presented == null || !presented.bindingValid()) {
            return Verdict.INVALID;
        }
        if (pinned == null) {
            if (inviteFingerprint == null) {
                return Verdict.FIRST_UNVERIFIED;
            }
            return presented.matches(inviteFingerprint) ? Verdict.FIRST_VERIFIED : Verdict.INVITE_MISMATCH;
        }
        if (!pinned.equals(presented.identityKey())) {
            return Verdict.CHANGED;
        }
        return presented.keysVersion() >= 0 && presented.keysVersion() < lastKeysVersion ? Verdict.STALE : Verdict.SAME;
    }

    /**
     * For a received message: whether the identity that verified its signature is the one pinned for the address it's
     * from. A first message from an address with no pin is {@code FIRST_UNVERIFIED} (it lands in Requests, plan §2.4).
     */
    public static Verdict sender(IdentityKey pinned, IdentityKey signer) {
        if (pinned == null) {
            return Verdict.FIRST_UNVERIFIED;
        }
        return pinned.equals(signer) ? Verdict.SAME : Verdict.CHANGED;
    }
}
