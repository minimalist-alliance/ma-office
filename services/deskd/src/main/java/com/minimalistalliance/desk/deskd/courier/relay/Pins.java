package com.minimalistalliance.desk.deskd.courier.relay;

import com.minimalistalliance.desk.courier.envelope.BoxKey;
import com.minimalistalliance.desk.courier.envelope.EnvelopeException;
import com.minimalistalliance.desk.courier.envelope.IdentityKey;
import com.minimalistalliance.desk.courier.envelope.KeyCheck;
import com.minimalistalliance.desk.courier.envelope.PublishedKeys;
import com.minimalistalliance.desk.courier.envelope.Signed;
import com.minimalistalliance.desk.deskd.courier.store.RelayState;
import java.io.IOException;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Duration;
import java.util.Base64;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Who this desk seals to, and who signed what it opens (the plan §1.3; spike Q-C2 to Q-C4; draft ADR "Courier's
 * envelopes" §6, "Courier's transports" §4). <b>Pins are on the identity key</b>, kept in {@code courier.db}
 * ({@link RelayState}): a new box key the same identity binds is the same contact; a new identity is a change, which
 * blocks sending to that address and holds what it sends until the member checks the new safety number.
 *
 * <ul>
 *   <li><b>First contact</b> trusts the directory (TOFU) and pins unverified, unless an invite's fingerprint vouched for the
 *       keys (verified). A first message from someone new lands in Requests, as any stranger's.
 *   <li><b>A message</b> is accepted only under the pinned identity. Signed by another one the directory now gives for that
 *       address, it's held and the pin marked changed; signed by anything else, it's a forgery and refused.
 *   <li><b>The platform's directory is never trusted past first contact:</b> a key it swaps shows as a change.
 * </ul>
 */
final class Pins {

    private static final Logger log = LoggerFactory.getLogger(Pins.class);

    /** How long a pin's keys are sealed to before the directory is asked again (a box key may have rotated). */
    static final Duration LOOKUP_EVERY = Duration.ofHours(6);

    private final RelayState state;
    private final RelayApi api;
    private final Clock clock;
    /** The directory's answers during one drain, by address (a map, or the IOException it gave). */
    private final Map<String, Object> drainLookups = new java.util.concurrent.ConcurrentHashMap<>();
    private volatile boolean rateLimited;
    /** Lasting refusals across drains, at most 1,000 addresses (the oldest go first). */
    private final Map<String, Gone> gone = new java.util.LinkedHashMap<>(16, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Gone> eldest) {
            return size() > 1000;
        }
    };

    Pins(RelayState state, RelayApi api, Clock clock) {
        this.state = state;
        this.api = api;
        this.clock = clock;
    }

    // ---- sending

    /** The keys to seal to, or why not now ({@code problem}) and whether that will pass ({@code lasting}). */
    record SealTo(PublishedKeys keys, String problem, boolean lasting) {
        static SealTo ok(PublishedKeys k) {
            return new SealTo(k, null, false);
        }

        static SealTo no(String problem, boolean lasting) {
            return new SealTo(null, problem, lasting);
        }
    }

    SealTo forSending(String address) throws InterruptedException, SQLException {
        RelayState.Pin pin = state.pin(address);
        if (pin != null && RelayState.CHANGED.equals(pin.state())) {
            return SealTo.no("key_changed", false);
        }
        long now = clock.millis();
        if (pin != null && pin.lookedUpAt() != null && now - pin.lookedUpAt() < LOOKUP_EVERY.toMillis() && now >= pin.lookedUpAt()) {
            PublishedKeys k = keysOf(pin);
            if (k != null) {
                return SealTo.ok(k);
            }
        }
        Map<String, Object> answer;
        try {
            answer = api.lookup(address);
        } catch (RelayApi.Refused r) {
            String code = r.code() == null ? "http_" + r.status() : r.code();
            return switch (code) {
                case "address_unknown", "address_closed", "courier_teen", "desk_kind", "invalid_request" -> SealTo.no(code, true);
                default -> pin != null && keysOf(pin) != null ? SealTo.ok(keysOf(pin)) : SealTo.no(code, false);
            };
        } catch (IOException e) {
            // The platform unreachable: a pin's keys still seal (the relay is then likely down too, and the send waits).
            return pin != null && keysOf(pin) != null ? SealTo.ok(keysOf(pin)) : SealTo.no("unreachable", false);
        }
        PublishedKeys presented;
        try {
            presented = PublishedKeys.fromJson(answer);
        } catch (EnvelopeException e) {
            return pin != null && keysOf(pin) != null ? SealTo.ok(keysOf(pin)) : SealTo.no("keys_invalid", false);
        }
        if (!address.equals(answer.get("address"))) {
            // The directory answered for another address than the one asked: never sealed to.
            return pin != null && keysOf(pin) != null ? SealTo.ok(keysOf(pin)) : SealTo.no("keys_invalid", false);
        }
        IdentityKey pinned = pin == null ? null : identity(pin.identityKey());
        KeyCheck.Verdict v = KeyCheck.check(pinned, pin == null ? -1 : pin.keysVersion(), presented, null);
        switch (v) {
            case FIRST_UNVERIFIED -> {
                state.putPin(newPin(address, presented, RelayState.UNVERIFIED, "directory", now));
                return SealTo.ok(presented);
            }
            case SAME -> {
                state.putPin(pin.withKeys(presented.boxKey().text(), b64(presented.binding()), presented.keysVersion()).lookedUp(now));
                return SealTo.ok(presented);
            }
            case STALE -> {
                state.putPin(pin.lookedUp(now));
                return SealTo.ok(keysOf(pin));
            }
            case CHANGED -> {
                state.putPin(pin.changedTo(presented.identityKey().text(), presented.boxKey().text(), b64(presented.binding()),
                        presented.keysVersion(), now));
                log.info("courier: a contact's identity key changed; sending to them waits for the member");
                return SealTo.no("key_changed", false);
            }
            default -> {
                return pin != null && keysOf(pin) != null ? SealTo.ok(keysOf(pin)) : SealTo.no("keys_invalid", false);
            }
        }
    }

    // ---- receiving

    /** Who signed a message, as far as this desk can tell. */
    enum Outcome {
        /** Signed by the pinned identity (or, at first contact, the directory's, now pinned). */
        ACCEPT,
        /** Signed by a new identity the directory gives for this address: held until the member checks it. */
        HOLD,
        /** Signed by neither: a forgery, refused for good. */
        FORGED,
        /** The address has no keys anyone can check against (unknown, closed before it was pinned): refused for good. */
        UNVERIFIABLE,
        /** Couldn't ask the directory now: tried again at the next drain. */
        WAIT
    }

    record Checked(Outcome outcome, Signed.Verified verified, String reason) {}

    /** A drain begins or ends: what the directory said during the last one is forgotten (lasting answers are kept). */
    void forgetLookups() {
        drainLookups.clear();
        rateLimited = false;
    }

    /** A lasting "no" for an address: closed names are never reused (kept a day here), unknown ones are kept an hour. */
    private record Gone(int status, String code, long until) {}

    private Gone gone(String address) {
        synchronized (gone) {
            Gone g = gone.get(address);
            if (g != null && g.until() <= clock.millis()) {
                gone.remove(address);
                return null;
            }
            return g;
        }
    }

    private void remember(String address, RelayApi.Refused r) {
        long keep = "address_closed".equals(r.code()) ? Duration.ofDays(1).toMillis()
                : "address_unknown".equals(r.code()) ? Duration.ofHours(1).toMillis() : 0;
        if (keep > 0) {
            synchronized (gone) {
                gone.put(address, new Gone(r.status(), r.code(), clock.millis() + keep));
            }
        }
    }

    Checked sender(Signed.Unverified u) throws InterruptedException, SQLException {
        String from = u.from();
        RelayState.Pin pin = state.pin(from);
        if (pin != null) {
            IdentityKey pinned = identity(pin.identityKey());
            Signed.Verified ok = verify(u, pinned);
            if (ok != null) {
                return new Checked(Outcome.ACCEPT, ok, null);
            }
            if (RelayState.CHANGED.equals(pin.state()) && pin.newIdentityKey() != null) {
                Signed.Verified held = verify(u, identity(pin.newIdentityKey()));
                if (held != null) {
                    return new Checked(Outcome.HOLD, held, null);
                }
            }
        }
        Map<String, Object> answer;
        Object looked = drainLookups.get(from);
        try {
            if (looked == null) {
                Gone gone = gone(from);
                if (gone != null) {
                    looked = new RelayApi.Refused(gone.status(), gone.code(), null);
                } else if (rateLimited) {
                    // The directory said "too many" this drain: every other new sender waits, without spending a call.
                    looked = new RelayApi.Refused(429, "rate_limited", null);
                } else {
                    try {
                        looked = api.lookup(from);
                    } catch (RelayApi.Refused r) {
                        looked = r;
                        if (r.status() == 429) {
                            rateLimited = true;
                        }
                        remember(from, r);
                    } catch (IOException e) {
                        looked = e;
                    }
                }
                // One lookup per sender a drain: a flood of envelopes naming one address costs one call, not one each.
                drainLookups.put(from, looked);
            }
            if (looked instanceof IOException e) {
                throw e;
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> m = (Map<String, Object>) looked;
            answer = m;
        } catch (RelayApi.Refused r) {
            String code = r.code() == null ? "http_" + r.status() : r.code();
            // Only what the directory says about the address is lasting: nothing will check the sender later either, so the
            // envelope is refused (Security CT-M1). Anything else (too many, the platform's trouble, this desk's own
            // credentials or clock) waits for the next drain (CT-I6).
            boolean lasting = switch (code) {
                case "address_unknown", "address_closed", "keys_not_set", "courier_teen", "desk_kind", "invalid_request" -> true;
                default -> false;
            };
            if (!lasting) {
                return new Checked(Outcome.WAIT, null, code);
            }
            return new Checked(pin == null ? Outcome.UNVERIFIABLE : Outcome.FORGED, null, code);
        } catch (IOException e) {
            return new Checked(Outcome.WAIT, null, "unreachable");
        }
        PublishedKeys presented;
        try {
            presented = PublishedKeys.fromJson(answer);
        } catch (EnvelopeException e) {
            return new Checked(Outcome.FORGED, null, "keys_invalid");
        }
        if (!from.equals(answer.get("address")) || !presented.bindingValid()) {
            return new Checked(Outcome.FORGED, null, "keys_invalid");
        }
        Signed.Verified v = verify(u, presented.identityKey());
        if (v == null) {
            return new Checked(Outcome.FORGED, null, "bad_signature");
        }
        long now = clock.millis();
        if (pin == null) {
            state.putPin(newPin(from, presented, RelayState.UNVERIFIED, "message", now));
            return new Checked(Outcome.ACCEPT, v, null);
        }
        // Signed by an identity the directory now gives, which isn't the pin: a change, held for the member.
        state.putPin(pin.changedTo(presented.identityKey().text(), presented.boxKey().text(), b64(presented.binding()), presented.keysVersion(),
                now));
        log.info("courier: a message came under a contact's new identity key; held until the member checks it");
        return new Checked(Outcome.HOLD, v, null);
    }

    private static Signed.Verified verify(Signed.Unverified u, IdentityKey key) {
        if (key == null) {
            return null;
        }
        try {
            return u.verify(key);
        } catch (EnvelopeException e) {
            return null;
        }
    }

    // ---- helpers

    static RelayState.Pin newPin(String address, PublishedKeys k, String pinState, String source, long now) {
        return new RelayState.Pin(address, k.identityKey().text(), k.boxKey().text(), b64(k.binding()), k.keysVersion(), null, pinState, source,
                null, null, null, null, now, RelayState.VERIFIED.equals(pinState) ? now : null, null, now);
    }

    /** The pin's keys as sealable keys, or null if they don't read or bind (never sealed to). */
    static PublishedKeys keysOf(RelayState.Pin pin) {
        try {
            PublishedKeys k = new PublishedKeys(IdentityKey.parse(pin.identityKey()), BoxKey.parse(pin.boxKey()),
                    Base64.getUrlDecoder().decode(pin.binding()), pin.keysVersion());
            return k.bindingValid() ? k : null;
        } catch (EnvelopeException | IllegalArgumentException e) {
            return null;
        }
    }

    /** The new identity's keys of a changed pin, or null. */
    static PublishedKeys newKeysOf(RelayState.Pin pin) {
        if (pin.newIdentityKey() == null || pin.newBoxKey() == null || pin.newBinding() == null) {
            return null;
        }
        try {
            PublishedKeys k = new PublishedKeys(IdentityKey.parse(pin.newIdentityKey()), BoxKey.parse(pin.newBoxKey()),
                    Base64.getUrlDecoder().decode(pin.newBinding()), pin.newKeysVersion() == null ? -1 : pin.newKeysVersion());
            return k.bindingValid() ? k : null;
        } catch (EnvelopeException | IllegalArgumentException e) {
            return null;
        }
    }

    static IdentityKey identity(String text) {
        try {
            return text == null ? null : IdentityKey.parse(text);
        } catch (EnvelopeException e) {
            return null;
        }
    }

    static String b64(byte[] b) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }
}
