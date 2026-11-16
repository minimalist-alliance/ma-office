package com.minimalistalliance.desk.deskd.courier.keys;

import com.minimalistalliance.desk.courier.envelope.BoxKeyPair;
import com.minimalistalliance.desk.courier.envelope.Envelope;
import com.minimalistalliance.desk.courier.envelope.IdentityKey;
import com.minimalistalliance.desk.courier.envelope.IdentityKeyPair;
import com.minimalistalliance.desk.courier.envelope.PublishedKeys;
import com.minimalistalliance.desk.courier.envelope.SafetyNumber;
import java.io.IOException;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BooleanSupplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The desk's Courier keys (the launch plan's Wave 1.4; draft ADR "Courier's envelopes"): loaded from {@code /data/keys}
 * at start ({@link DeskKeyStore}), rotated, published to the platform's key directory, and handed to the transports to
 * sign and open with ({@code courier-envelope}).
 *
 * <ul>
 *   <li><b>Rotation:</b> the box key is replaced every {@link Settings#rotateEvery} (180 days by default), checked at start
 *       and at Courier's hourly sweep. The identity stays, so contacts, who pin the identity, see no change; the old box key
 *       is kept {@link DeskKeyStore#RETAIN} to open envelopes sealed to it, then deleted. An invite link's fingerprint
 *       covers the box key (contract 0.4.0 §2.1), so one made before a rotation reads as a mismatch, and the member checks
 *       the safety number instead; the long period keeps that rare.
 *   <li><b>Publishing:</b> at start and after every change, {@code PUT /v1/agent/keys}, only while Courier may run on this
 *       desk (not a Guild Desk's, a teen's, or while switched off). One that doesn't land is tried again at the next sweep,
 *       or after the platform's {@code Retry-After}.
 *   <li><b>Opening:</b> {@link #recipient()} tries the open address, then the closed ones, with the current box key and
 *       then the retired ones (envelopes don't name their key, contract 0.4.0 §2.2). The addresses are the platform's
 *       ({@code GET /v1/agent/courier-addresses}), which the transport gives {@link #addresses}.
 * </ul>
 *
 * Nothing here logs a key, a seed or a signature. {@link #available()} is false when there's no {@code /data/keys}.
 */
public final class DeskKeys {

    private static final Logger log = LoggerFactory.getLogger(DeskKeys.class);

    public static final String DEFAULT_DIRECTORY = "/data/keys";

    public record Settings(Path directory, Duration rotateEvery) {
        public static Settings defaults(Path directory) {
            return new Settings(directory, Duration.ofDays(180));
        }
    }

    private final ReentrantLock lock = new ReentrantLock();
    private final DeskKeyStore store;
    private final Settings settings;
    private final Clock clock;
    private final KeyPublisher publisher;
    private final BooleanSupplier mayPublish;

    private IdentityKeyPair identity;
    private long identityCreatedAt;
    private List<BoxKeyPair> boxes = List.of();
    private long replacedAt = -1;
    private String unavailable;
    private PublishedKeys published;
    private long publishedVersion = -1;
    private long publishedAt = -1;
    private String publishProblem;
    private long retryAt;
    private boolean neverPublish;
    private List<String> addresses = List.of();

    public DeskKeys(Settings settings, Clock clock, KeyPublisher publisher, BooleanSupplier mayPublish) {
        this(new DeskKeyStore(settings.directory(), new SecureRandom()), settings, clock, publisher, mayPublish);
    }

    DeskKeys(DeskKeyStore store, Settings settings, Clock clock, KeyPublisher publisher, BooleanSupplier mayPublish) {
        this.store = store;
        this.settings = settings;
        this.clock = clock;
        this.publisher = publisher;
        this.mayPublish = mayPublish;
        load();
    }

    private void load() {
        lock.lock();
        try {
            DeskKeyStore.Loaded loaded = store.load(clock.millis());
            identity = loaded.identity();
            identityCreatedAt = loaded.identityCreatedAt();
            boxes = loaded.boxes();
            replacedAt = loaded.replacedAt();
            unavailable = null;
        } catch (IOException | RuntimeException e) {
            unavailable = e.getMessage() != null && e.getMessage().startsWith("no keys directory") ? "no_directory" : "unreadable";
            log.warn("courier keys aren't usable ({}): member messages and the mail door are unavailable", unavailable);
        } finally {
            lock.unlock();
        }
    }

    /** Whether the keys loaded. */
    public boolean available() {
        lock.lock();
        try {
            return unavailable == null;
        } finally {
            lock.unlock();
        }
    }

    /**
     * At start and at Courier's hourly sweep: rotates the box key when it's due, deletes retired ones kept long enough, and
     * publishes the current keys if the directory doesn't hold them yet. Never throws.
     */
    public void maintain() throws InterruptedException {
        PublishedKeys toPublish;
        lock.lock();
        try {
            if (unavailable != null) {
                return;
            }
            long now = clock.millis();
            BoxKeyPair current = boxes.get(0);
            if (now >= current.createdAt() + settings.rotateEvery().toMillis()) {
                try {
                    BoxKeyPair next = store.rotate(now, current.createdAt());
                    List<BoxKeyPair> all = new ArrayList<>(boxes);
                    all.add(0, next);
                    boxes = List.copyOf(all);
                    log.info("courier keys: the box key rotated");
                } catch (IOException e) {
                    log.warn("courier keys: the box key couldn't rotate ({}); tried again at the next sweep", e.getClass().getSimpleName());
                }
            }
            boxes = store.expire(boxes, now);
            PublishedKeys current0 = PublishedKeys.bind(identity, boxes.get(0).publicKey());
            if (neverPublish || current0.sameKeys(published) || now < retryAt || !mayPublish.getAsBoolean()) {
                return;
            }
            toPublish = current0;
        } finally {
            lock.unlock();
        }
        // The call goes out with no lock held.
        KeyPublisher.Result r = publisher.publish(toPublish);
        lock.lock();
        try {
            long now = clock.millis();
            switch (r.outcome()) {
                case PUBLISHED -> {
                    published = toPublish;
                    publishedVersion = r.keysVersion();
                    publishedAt = now;
                    publishProblem = null;
                    retryAt = 0;
                    if (r.platformFingerprint() != null && !r.platformFingerprint().equals(toPublish.fingerprint())) {
                        // Informational on the platform's side (contract §2.1), so never trusted; but a mismatch means one side
                        // computes it differently, which invite links would show.
                        log.warn("courier keys: the platform's fingerprint differs from this desk's");
                    }
                }
                case LATER -> {
                    publishProblem = r.code();
                    retryAt = r.retryAfter() == null ? 0 : now + r.retryAfter().toMillis();
                }
                case NEVER -> {
                    publishProblem = r.code();
                    neverPublish = true;
                }
            }
        } finally {
            lock.unlock();
        }
    }

    /**
     * A new identity, after a compromise or when the member asks: every contact sees a key change and checks the new
     * safety number. The old box keys stay {@link DeskKeyStore#RETAIN}, to open what was already sealed to them.
     */
    public void resetIdentity() throws IOException, InterruptedException {
        lock.lock();
        try {
            if (unavailable != null) {
                throw new IOException("keys unavailable");
            }
            DeskKeyStore.Loaded loaded = store.resetIdentity(clock.millis(), boxes);
            identity = loaded.identity();
            identityCreatedAt = loaded.identityCreatedAt();
            boxes = loaded.boxes();
            replacedAt = loaded.replacedAt();
            published = null;
            neverPublish = false;
            retryAt = 0;
            log.warn("courier keys: the identity was reset; contacts will see a key change");
        } finally {
            lock.unlock();
        }
        maintain();
    }

    /** The desk's addresses from the platform: the open one (or null) and the closed ones, newest first. Canonical. */
    public void addresses(String open, List<String> closed) {
        List<String> all = new ArrayList<>();
        if (open != null) {
            all.add(open.toLowerCase(Locale.ROOT));
        }
        for (String c : closed) {
            all.add(c.toLowerCase(Locale.ROOT));
        }
        lock.lock();
        try {
            addresses = List.copyOf(all);
        } finally {
            lock.unlock();
        }
    }

    /** The identity to sign with, for the transports. Null when unavailable. */
    public IdentityKeyPair identity() {
        lock.lock();
        try {
            return identity;
        } finally {
            lock.unlock();
        }
    }

    /** The keys as published (or to be): identity, current box key, binding. Null when unavailable. */
    public PublishedKeys publicKeys() {
        lock.lock();
        try {
            return unavailable == null ? PublishedKeys.bind(identity, boxes.get(0).publicKey()) : null;
        } finally {
            lock.unlock();
        }
    }

    /** What opens envelopes to this desk: its addresses and box keys as they are at the call. */
    public Envelope.Recipient recipient() {
        List<String> a;
        List<BoxKeyPair> b;
        lock.lock();
        try {
            a = addresses;
            b = unavailable == null ? boxes : List.of();
        } finally {
            lock.unlock();
        }
        return new Envelope.Recipient() {
            @Override
            public List<String> addresses() {
                return a;
            }

            @Override
            public List<BoxKeyPair> boxKeys() {
                return b;
            }
        };
    }

    /** The 60-digit safety number between this desk and a contact's identity. */
    public String safetyNumber(IdentityKey peer) {
        IdentityKeyPair me = identity();
        return me == null ? null : SafetyNumber.between(me.publicKey(), peer);
    }

    /** {@code courier.keys}' answer (API.md §21): public facts only. */
    public Map<String, Object> status() {
        lock.lock();
        try {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("available", unavailable == null);
            if (unavailable != null) {
                m.put("reason", unavailable);
                return m;
            }
            PublishedKeys k = PublishedKeys.bind(identity, boxes.get(0).publicKey());
            m.put("identityKey", k.identityKey().text());
            m.put("boxKey", k.boxKey().text());
            m.put("fingerprint", k.fingerprint());
            m.put("identityCreatedAt", identityCreatedAt);
            m.put("boxCreatedAt", boxes.get(0).createdAt());
            m.put("boxRotatesAt", boxes.get(0).createdAt() + settings.rotateEvery().toMillis());
            m.put("boxKeysKept", boxes.size());
            m.put("replacedAt", replacedAt < 0 ? null : replacedAt);
            Map<String, Object> pub = new LinkedHashMap<>();
            boolean current = k.sameKeys(published);
            pub.put("current", current);
            pub.put("keysVersion", current ? publishedVersion : null);
            pub.put("at", current ? publishedAt : null);
            pub.put("problem", current ? null : publishProblem);
            m.put("published", pub);
            return m;
        } finally {
            lock.unlock();
        }
    }

    @Override
    public String toString() {
        return "DeskKeys[" + store.directory() + "]";
    }
}
