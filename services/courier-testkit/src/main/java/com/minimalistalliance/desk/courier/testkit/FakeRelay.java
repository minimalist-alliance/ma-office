package com.minimalistalliance.desk.courier.testkit;

import com.minimalistalliance.desk.courier.envelope.BodySource;
import com.minimalistalliance.desk.courier.envelope.Drop;
import com.minimalistalliance.desk.courier.envelope.Envelope;
import com.minimalistalliance.desk.courier.envelope.EnvelopeException;
import com.minimalistalliance.desk.courier.envelope.IdentityKeyPair;
import com.minimalistalliance.desk.courier.envelope.Padding;
import com.minimalistalliance.desk.courier.envelope.PublishedKeys;
import com.minimalistalliance.desk.courier.envelope.Signed;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BiConsumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import tools.jackson.jr.ob.JSON;

/**
 * A fake of Platform's Courier relay (ma-platform contract 0.4.0, {@code docs/contracts/relay.md}, built on
 * {@code sub/courier-relay}): the key directory, the desks' addresses, the sealed relay with its ciphertext drop, the
 * {@code notify relay} push, and a fake of the mail door that seals mail to a desk. One HTTP server on 127.0.0.1, in the
 * test's own JVM. For the desk's {@code ma} and mail-door transports (Wave 2.5) and the soak harness.
 *
 * <p><b>What it matches.</b> Every agent route of §3 with its answers and error codes (§8): keys and lookups, the desk's
 * own address, drops, send with {@code Idempotency-Key}, collect, ack and pending; the caps of §3 and §6 (all settable);
 * the padding checks the relay makes ({@code unpadded}, {@code too_large}); expiry (30 days for {@code ma}, 90 for
 * {@code mail}) against the fake's clock; and no sender stored with an envelope. The presigned S3 URLs of a drop are this
 * server's own {@code /fake-s3/<dropId>}.
 *
 * <p><b>Who's calling.</b> The real relay checks the desk's SigV4 signature. This fake reads the access key id out of the
 * {@code Authorization} header ({@link #addDesk}'s {@code accessKeyId}) without checking the signature, so deskd's own
 * {@code AgentClient} works against it unchanged; a test's own client can send {@value #DESK_HEADER} instead.
 *
 * <p><b>The mail door</b> (0.4.1, not yet written in the contract): {@link #deliverMail} seals the proposed
 * {@code mail} payload (draft ADR "Courier's envelopes") under the door's own key ({@link #doorKey}), with the raw message
 * inline or, past what fits, in a drop. {@code courier-send} (0.4.1): {@code raw} up to 4 MiB inline, larger through
 * {@code POST /v1/agent/courier/uploads} and a presigned PUT to this server's {@code /fake-s3/out/<desk>/<uploadId>}, then
 * {@code {upload}}; {@link #loseNextUploads} plays one that expired before the send.
 *
 * <p><b>Faults:</b> {@link #setDown}, {@link #setPaused}, {@link #setLatency}, {@link #loseNextAcks}, {@link #duplicateNextFetches},
 * {@link #reorderFetches}, {@link #failNextSends}, {@link #swapKeys} (a directory that lies), and the clock.
 */
public final class FakeRelay implements AutoCloseable {

    public static final String DESK_HEADER = "X-MA-Fake-Desk";
    public static final String DOMAIN = "courier.test.invalid";
    static final long MA_DAYS = 30;
    static final long MAIL_DAYS = 90;

    private static final JSON J = JSON.std.with(JSON.Feature.WRITE_NULL_PROPERTIES);
    private static final Pattern CREDENTIAL = Pattern.compile("Credential=([A-Z0-9]{4,128})/");
    private static final Pattern NAME = Pattern.compile("[a-z0-9](?:[a-z0-9]|[.-](?=[a-z0-9])){1,30}[a-z0-9]");
    private static final String CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

    /** Every cap of the contract, settable for a test. Defaults are the contract's. */
    public static final class Caps {
        public int keyChangesPerDay = 3;
        public int lookupsPerHour = 300;
        public int lookupsPerDay = 2000;
        public int sendsPerHour = 300;
        public int sendsPerDay = 2000;
        public int newRecipientsPerDay = 100;
        public int maxPendingEnvelopes = 10_000;
        public long maxPendingBytes = 2L << 30;
    }

    /** What the relay saw of one request: never more than the real one keeps, plus the body for a test's canary search. */
    public record Seen(Instant at, String method, String path, int status, String desk, byte[] body) {}

    private static final class Desk {
        final String id;
        final String accessKeyId;
        String kind = "personal";
        boolean teen;
        boolean connected = true;
        PublishedKeys keys;
        long keysVersion;
        Instant keysUpdatedAt;
        final List<Instant> keyChanges = new ArrayList<>();
        String address;
        Instant addressCreatedAt;
        final List<String[]> closed = new ArrayList<>();
        final List<Instant> lookups = new ArrayList<>();
        final List<Instant> sends = new ArrayList<>();
        final Map<String, Instant> recipientsToday = new HashMap<>();

        Desk(String id, String accessKeyId) {
            this.id = id;
            this.accessKeyId = accessKeyId;
        }
    }

    private static final class Held {
        final String id;
        final String kind;
        final String to;
        final String deskId;
        final Instant receivedAt;
        final Instant expiresAt;
        final String enc;
        final String ct;
        final List<String> drops;

        Held(String id, String kind, String to, String deskId, Instant receivedAt, Instant expiresAt, String enc, String ct, List<String> drops) {
            this.id = id;
            this.kind = kind;
            this.to = to;
            this.deskId = deskId;
            this.receivedAt = receivedAt;
            this.expiresAt = expiresAt;
            this.enc = enc;
            this.ct = ct;
            this.drops = drops;
        }

        long bytes(Map<String, DropObject> drops) {
            long n = ct.length() * 3L / 4;
            for (String d : this.drops) {
                DropObject o = drops.get(d);
                n += o == null ? 0 : o.bytes;
            }
            return n;
        }
    }

    private static final class DropObject {
        final String id;
        final String owner;
        final String recipient;
        final long bytes;
        final Instant reservedAt;
        byte[] content;
        String envelope;

        DropObject(String id, String owner, String recipient, long bytes, Instant reservedAt) {
            this.id = id;
            this.owner = owner;
            this.recipient = recipient;
            this.bytes = bytes;
            this.reservedAt = reservedAt;
        }
    }

    private record Idempotent(String deskId, String body, int status, Map<String, Object> answer, Instant at) {}

    private final ReentrantLock lock = new ReentrantLock();
    private final HttpServer server;
    private final SecureRandom random = new SecureRandom();
    private final IdentityKeyPair door = IdentityKeyPair.generate(random);
    private final Map<String, Desk> desks = new LinkedHashMap<>();
    private final Map<String, Desk> byAccessKey = new HashMap<>();
    /** Every name ever given, open or closed, to the desk that had it: names are never reused. */
    private final Map<String, String> names = new HashMap<>();
    private final TreeMap<String, Held> held = new TreeMap<>();
    private final Map<String, DropObject> drops = new HashMap<>();
    private final Map<String, Idempotent> idempotency = new HashMap<>();
    private final List<Seen> seen = new CopyOnWriteArrayList<>();
    private final List<BiConsumer<String, String>> listeners = new CopyOnWriteArrayList<>();
    private final Caps caps = new Caps();
    private Clock clock = Clock.systemUTC();
    private long lastUlidMillis;
    private long ulidHi;
    private long ulidLo;
    private volatile boolean down;
    private volatile boolean paused;
    private volatile Duration latency = Duration.ZERO;
    private final AtomicInteger loseAcks = new AtomicInteger();
    private final AtomicInteger duplicateFetches = new AtomicInteger();
    private final AtomicInteger failSends = new AtomicInteger();
    private volatile boolean reorder;
    private final Map<String, PublishedKeys> swapped = new HashMap<>();
    private final AtomicInteger sent = new AtomicInteger();
    private final AtomicInteger acked = new AtomicInteger();
    // courier-send, as proposed for 0.4.1 (draft ADR "Courier's transports" §5).
    private volatile boolean courierSendOn = true;
    private volatile boolean doorKeysServed = true;
    private final List<MailSent> mailSent = new CopyOnWriteArrayList<>();
    private final Map<String, String> refuseRecipients = new HashMap<>();
    private final AtomicInteger failCourierSends = new AtomicInteger();
    private final AtomicInteger loseCourierSendAnswers = new AtomicInteger();
    /** courier-send's uploads (0.4.1): a message over 4 MiB, PUT to its presigned link, then sent by its id. */
    private final Map<String, MailUpload> uploads = new HashMap<>();
    private final AtomicInteger uploadsMade = new AtomicInteger();
    private final AtomicInteger loseUploads = new AtomicInteger();

    /** The door's inline cap for {@code raw} (contract 0.4.1), and {@code mail.maxMessageBytes}. */
    public static final int MAIL_INLINE_MAX = 4 * 1024 * 1024;
    public static final int MAIL_MAX = 25 * 1024 * 1024;

    private static final class MailUpload {
        final String deskId;
        final long bytes;
        byte[] content;

        MailUpload(String deskId, long bytes) {
            this.deskId = deskId;
            this.bytes = bytes;
        }
    }

    private FakeRelay(HttpServer server) {
        this.server = server;
    }

    /** Starts on 127.0.0.1, on a port the system picks. */
    public static FakeRelay start() {
        return start(0);
    }

    /** Starts on 127.0.0.1 at {@code port} (0: the system picks), e.g. for a device reaching it through an SSH tunnel. */
    public static FakeRelay start(int port) {
        try {
            HttpServer s = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), port), 64);
            FakeRelay relay = new FakeRelay(s);
            s.createContext("/", relay::handle);
            s.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
            s.start();
            return relay;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** The API base for the agent routes: what deskd's {@code apiBase} is set to. */
    public String baseUrl() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    public Caps caps() {
        return caps;
    }

    /** The clock the relay stamps and expires by. */
    public void setClock(Clock clock) {
        lock.lock();
        try {
            this.clock = clock;
        } finally {
            lock.unlock();
        }
    }

    // ---- desks and addresses (the member routes' effect, without a member)

    /** A desk the relay knows. {@code accessKeyId} is what its SigV4 header names. */
    public void addDesk(String deskId, String accessKeyId) {
        lock.lock();
        try {
            Desk d = new Desk(deskId, accessKeyId);
            desks.put(deskId, d);
            byAccessKey.put(accessKeyId, d);
        } finally {
            lock.unlock();
        }
    }

    /** Makes a desk a Guild Desk ({@code 409 desk_kind}) or a teen's ({@code 403 courier_teen}). */
    public void setDeskKind(String deskId, String kind, boolean teen) {
        lock.lock();
        try {
            Desk d = desk(deskId);
            d.kind = kind;
            d.teen = teen;
        } finally {
            lock.unlock();
        }
    }

    /** Whether the desk has a gateway connection, so a push reaches it. A stopped desk is never woken. */
    public void setConnected(String deskId, boolean connected) {
        lock.lock();
        try {
            desk(deskId).connected = connected;
        } finally {
            lock.unlock();
        }
    }

    /**
     * Gives a desk an address, closing its old one when {@code replace}: a name is never given out twice.
     *
     * @return the canonical address
     */
    public String assignAddress(String deskId, String name, boolean replace) {
        lock.lock();
        try {
            Desk d = desk(deskId);
            String n = name.toLowerCase(Locale.ROOT);
            if (!NAME.matcher(n).matches() || !n.matches(".*[a-z].*")) {
                throw new IllegalArgumentException("invalid_name");
            }
            if (names.containsKey(n)) {
                throw new IllegalStateException("name_taken");
            }
            if (d.address != null && !replace) {
                throw new IllegalStateException("address_exists");
            }
            Instant now = clock.instant();
            if (d.address != null) {
                d.closed.add(0, new String[] {d.address, now.toString()});
            }
            d.address = n + "@" + DOMAIN;
            d.addressCreatedAt = now;
            names.put(n, deskId);
            notify(d, "address");
            return d.address;
        } finally {
            lock.unlock();
        }
    }

    /** Closes a desk's address: from then on it answers {@code 410 address_closed}. */
    public void closeAddress(String deskId) {
        lock.lock();
        try {
            Desk d = desk(deskId);
            if (d.address != null) {
                d.closed.add(0, new String[] {d.address, clock.instant().toString()});
                d.address = null;
                notify(d, "address");
            }
        } finally {
            lock.unlock();
        }
    }

    /** Called with {@code (deskId, reason)} for each {@code notify relay} the gateway would push. */
    public void onNotify(BiConsumer<String, String> listener) {
        listeners.add(listener);
    }

    /** Pushed on a thread of its own, after the caller's lock is let go, so a listener may call the relay at once. */
    private void notify(Desk d, String reason) {
        if (d.connected) {
            String id = d.id;
            for (BiConsumer<String, String> l : listeners) {
                Thread.ofVirtual().start(() -> l.accept(id, reason));
            }
        }
    }

    // ---- the mail door

    /** The door's signing key: what a desk verifies a {@code mail} payload with (its distribution is 0.4.1's). */
    public com.minimalistalliance.desk.courier.envelope.IdentityKey doorKey() {
        return door.publicKey();
    }

    /**
     * Seals one inbound email to an address's desk as the mail door would (the proposed 0.4.1 payload): {@code kind}
     * {@code mail}, signed by the door, the raw message inline as base64url, or in a drop when the envelope can't hold it.
     *
     * @return the relay id of the envelope
     * @throws IllegalStateException with the contract's code when the address can't receive
     */
    public String deliverMail(String rcpt, byte[] raw, String mailFrom, Map<String, Object> verdicts) {
        lock.lock();
        try {
            Desk d = deskForAddress(canonical(rcpt));
            if (d.keys == null) {
                throw new IllegalStateException("keys_not_set");
            }
            Instant now = clock.instant();
            Map<String, Object> p = new LinkedHashMap<>();
            p.put("v", 1);
            p.put("kind", "mail");
            p.put("id", ulid(now));
            // A name the contract reserves (relay.md §1), so no member can hold it (Security CK-L1).
            p.put("from", "mailer-daemon@" + DOMAIN);
            p.put("to", d.address);
            p.put("at", at(now));
            p.put("mailFrom", mailFrom);
            p.put("verdicts", verdicts == null ? Map.of() : verdicts);
            List<String> dropIds = new ArrayList<>();
            String inline = Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
            p.put("raw", inline);
            byte[] plaintext = Signed.wrap(door, p);
            if (Padding.envelopeBucket(plaintext.length) < 0) {
                p.remove("raw");
                Drop.Sealer sealer = Drop.sealer(BodySource.of(raw));
                String dropId = "dr-" + ulid(now);
                ByteArrayOutputStream out = new ByteArrayOutputStream((int) sealer.bucket());
                sealer.write(out);
                DropObject o = new DropObject(dropId, "door", d.address, sealer.bucket(), now);
                o.content = out.toByteArray();
                drops.put(dropId, o);
                p.put("drop", sealer.reference(dropId));
                dropIds.add(dropId);
                plaintext = Signed.wrap(door, p);
            }
            Envelope.Sealed s = Envelope.seal(Envelope.MAIL, d.address, d.keys.boxKey(), plaintext);
            String id = ulid(now);
            Held h = new Held(id, Envelope.MAIL, d.address, d.id, now, now.plus(Duration.ofDays(MAIL_DAYS)),
                    b64(s.enc()), b64(s.ct()), dropIds);
            for (String dropId : dropIds) {
                drops.get(dropId).envelope = id;
            }
            held.put(id, h);
            notify(d, "envelopes");
            return id;
        } catch (EnvelopeException | IOException e) {
            throw new IllegalStateException("the door couldn't seal: " + e.getMessage(), e);
        } finally {
            lock.unlock();
        }
    }

    // ---- courier-send and the door's notes (proposed for 0.4.1)

    /** One message {@code courier-send} took: the desk, its From, the envelope recipients, the bytes, and the key it came with. */
    public record MailSent(String deskId, String from, List<String> to, String rfcMessageId, byte[] raw, String idempotencyKey, Instant at) {}

    /** Whether {@code courier-send} takes mail (and says so in {@code sending.available}); on by default. */
    public void setCourierSend(boolean on) {
        courierSendOn = on;
    }

    /** Whether the addresses answer carries {@code doorKeys}; on by default. Off, a desk can't check the door's mail. */
    public void setDoorKeysServed(boolean served) {
        doorKeysServed = served;
    }

    /** What {@code courier-send} took, in order. */
    public List<MailSent> mailSent() {
        return List.copyOf(mailSent);
    }

    /** {@code courier-send} refuses this recipient with this code (a suppressed address, say) from now on. */
    public void refuseRecipient(String address, String code) {
        lock.lock();
        try {
            refuseRecipients.put(address.toLowerCase(java.util.Locale.ROOT), code);
        } finally {
            lock.unlock();
        }
    }

    /** The next {@code n} submissions answer 503 {@code unavailable}, taking nothing. */
    public void failNextCourierSends(int n) {
        failCourierSends.set(n);
    }

    /** The next {@code n} submissions are taken, and their answer lost (a 504 with no body): the desk can't tell they went. */
    public void loseNextCourierSendAnswers(int n) {
        loseCourierSendAnswers.set(n);
    }

    /**
     * A delivery note on a message a desk sent from its address, sealed to it by the door: {@code status} one of
     * {@code delivered}, {@code bounced}, {@code complained}, {@code deferred}, {@code suppressed}.
     *
     * @return the relay id of the envelope
     */
    public String deliveryNote(String deskAddress, String rfcMessageId, String recipient, String status) {
        return doorNote(deskAddress, m("type", "delivery", "rfcMessageId", rfcMessageId, "recipient", recipient, "status", status));
    }

    /** The door's note that it removed a message to this address (a virus), sealed to the desk. */
    public String removedNote(String deskAddress, String reason) {
        return doorNote(deskAddress, m("type", "removed", "reason", reason));
    }

    private String doorNote(String rcpt, Map<String, Object> note) {
        lock.lock();
        try {
            Desk d = deskForAddress(canonical(rcpt));
            if (d.keys == null) {
                throw new IllegalStateException("keys_not_set");
            }
            Instant now = clock.instant();
            Map<String, Object> p = new LinkedHashMap<>();
            p.put("v", 1);
            p.put("kind", "mail");
            p.put("id", ulid(now));
            p.put("from", "mailer-daemon@" + DOMAIN);
            p.put("to", d.address);
            p.put("at", at(now));
            p.put("note", note);
            Envelope.Sealed s = Envelope.seal(Envelope.MAIL, d.address, d.keys.boxKey(), Signed.wrap(door, p));
            String id = ulid(now);
            held.put(id, new Held(id, Envelope.MAIL, d.address, d.id, now, now.plus(Duration.ofDays(MAIL_DAYS)), b64(s.enc()), b64(s.ct()),
                    new ArrayList<>()));
            notify(d, "envelopes");
            return id;
        } catch (EnvelopeException e) {
            throw new IllegalStateException("the door couldn't seal: " + e.getMessage(), e);
        } finally {
            lock.unlock();
        }
    }

    /** Puts a raw envelope in a desk's queue as if the relay held it: for tests of what a desk does with a bad one. */
    public String inject(String deskAddress, String kind, byte[] enc, byte[] ct) {
        lock.lock();
        try {
            Desk d = deskForAddress(canonical(deskAddress));
            Instant now = clock.instant();
            String id = ulid(now);
            held.put(id, new Held(id, kind, d.address, d.id, now, now.plus(Duration.ofDays("mail".equals(kind) ? MAIL_DAYS : MA_DAYS)), b64(enc),
                    b64(ct), new ArrayList<>()));
            notify(d, "envelopes");
            return id;
        } finally {
            lock.unlock();
        }
    }

    private Object[] courierSend(Desk d, Map<String, Object> b, String idem, String rawBody) throws Answer {
        Instant now = clock.instant();
        if (!courierSendOn) {
            throw new Answer(503, "no_provider");
        }
        if (idem == null || !idem.matches("[A-Za-z0-9_-]{16,64}")) {
            throw new Answer(400, "invalid_request");
        }
        idempotency.values().removeIf(i -> i.at.isBefore(now.minus(Duration.ofDays(5))));
        Idempotent before = idempotency.get(d.id + " send " + idem);
        if (before != null) {
            if (!before.body.equals(rawBody)) {
                // As the relay's send (errors.md): the same key with another body. A desk's retry writes its Date again.
                throw new Answer(422, "idempotency_key_reused");
            }
            return new Object[] {before.status, before.answer};
        }
        if (failCourierSends.get() > 0 && failCourierSends.getAndDecrement() > 0) {
            throw new Answer(503, "unavailable");
        }
        if (d.address == null) {
            throw new Answer(409, "no_address");
        }
        if (!d.address.equals(b.get("from"))) {
            throw new Answer(400, "from_mismatch");
        }
        if (!(b.get("to") instanceof List<?> to) || to.isEmpty() || to.size() > 50) {
            throw new Answer(400, "invalid_request");
        }
        if ((b.get("raw") == null) == (b.get("upload") == null)) {
            throw new Answer(400, "invalid_request");
        }
        byte[] raw;
        String uploadId = null;
        if (b.get("raw") != null) {
            raw = decode(b.get("raw"));
            if (raw == null || raw.length == 0) {
                throw new Answer(400, "invalid_request");
            }
            if (raw.length > MAIL_INLINE_MAX) {
                // As the door: past 4 MiB inline, upload it first.
                throw new Answer(413, "too_large");
            }
        } else {
            uploadId = b.get("upload") instanceof String u && u.matches("up-[0-9A-HJKMNP-TV-Z]{26}") ? u : null;
            if (uploadId == null) {
                throw new Answer(400, "invalid_request");
            }
            MailUpload up = uploads.get(uploadId);
            if (up == null || !up.deskId.equals(d.id) || up.content == null) {
                throw new Answer(409, "upload_missing");
            }
            raw = up.content;
            // Sent or refused, the upload goes (the door deletes it either way, but for a retryable failure).
            uploads.remove(uploadId);
        }
        List<String> accepted = new ArrayList<>();
        List<Object> refused = new ArrayList<>();
        List<String> all = new ArrayList<>();
        for (Object o : to) {
            if (!(o instanceof String a) || a.isEmpty() || a.length() > 320) {
                throw new Answer(400, "invalid_request");
            }
            String lower = a.toLowerCase(java.util.Locale.ROOT);
            if (lower.endsWith("@" + DOMAIN)) {
                // Members' addresses never go through courier-send: they're sealed through the relay.
                refused.add(m("address", a, "code", "member_address"));
            } else if (refuseRecipients.containsKey(lower)) {
                refused.add(m("address", a, "code", refuseRecipients.get(lower)));
            } else {
                accepted.add(a);
                all.add(a);
            }
        }
        String id = "cs-" + ulid(now);
        if (!all.isEmpty()) {
            mailSent.add(new MailSent(d.id, d.address, List.copyOf(all), (String) b.get("rfcMessageId"), raw, idem, now));
        }
        Map<String, Object> answer = m("id", id, "accepted", accepted, "refused", refused);
        idempotency.put(d.id + " send " + idem, new Idempotent(d.id, rawBody, 202, answer, now));
        if (loseCourierSendAnswers.get() > 0 && loseCourierSendAnswers.getAndDecrement() > 0) {
            throw new Answer(504, null);
        }
        return new Object[] {202, answer};
    }

    // ---- faults

    /** courier-send uploads reserved so far. */
    public int uploadsMade() {
        return uploadsMade.get();
    }

    /** Uploads still held (PUT or not, not yet sent): the door deletes each one it sends. */
    public int uploadsHeld() {
        lock.lock();
        try {
            return uploads.size();
        } finally {
            lock.unlock();
        }
    }

    /** The next {@code n} uploads vanish once PUT, as one that expired before the send reached it ({@code upload_missing}). */
    public void loseNextUploads(int n) {
        loseUploads.set(n);
    }

    private Object[] reserveUpload(Desk d, Map<String, Object> b) throws Answer {
        if (!courierSendOn) {
            throw new Answer(503, "no_provider");
        }
        long bytes = number(b, "bytes");
        if (bytes < 1) {
            throw new Answer(400, "invalid_request");
        }
        if (bytes > MAIL_MAX) {
            throw new Answer(413, "too_large");
        }
        Instant now = clock.instant();
        String id = "up-" + ulid(now);
        uploads.put(id, new MailUpload(d.id, bytes));
        uploadsMade.incrementAndGet();
        return new Object[] {201, m("uploadId", id, "url", baseUrl() + "/fake-s3/out/" + d.id + "/" + id, "method", "PUT", "headers",
                m("Content-Length", Long.toString(bytes)), "expiresAt", now.plus(Duration.ofMinutes(5)).toString())};
    }

    private void mailUpload(String method, String key, byte[] body) throws Answer {
        lock.lock();
        try {
            int slash = key.indexOf('/');
            MailUpload up = slash < 0 ? null : uploads.get(key.substring(slash + 1));
            if (up == null || !up.deskId.equals(key.substring(0, slash)) || !"PUT".equals(method)) {
                throw new Answer(403, null);
            }
            if (up.content != null || body.length != up.bytes) {
                throw new Answer(400, null);
            }
            up.content = body;
            if (loseUploads.get() > 0 && loseUploads.getAndDecrement() > 0) {
                uploads.remove(key.substring(slash + 1));
            }
        } finally {
            lock.unlock();
        }
    }

    /** Every request answers 503 with no envelope code, as an unreachable or broken service. */
    public void setDown(boolean down) {
        this.down = down;
    }

    /** The kill switch: every agent route answers {@code 503 courier_paused}. Envelopes already waiting stay. */
    public void setPaused(boolean paused) {
        this.paused = paused;
    }

    public void setLatency(Duration latency) {
        this.latency = latency;
    }

    /** The next {@code n} acks answer as if done but delete nothing, as an ack lost on the way: each envelope comes again. */
    public void loseNextAcks(int n) {
        loseAcks.set(n);
    }

    /** The next {@code n} collects also return the previous page's envelopes again, acked or not. */
    public void duplicateNextFetches(int n) {
        duplicateFetches.set(n);
    }

    /** Collects return each page in a random order (the contract says oldest first; a desk mustn't depend on it). */
    public void reorderFetches(boolean reorder) {
        this.reorder = reorder;
    }

    /** The next {@code n} sends answer 500. */
    public void failNextSends(int n) {
        failSends.set(n);
    }

    /** A directory that lies: lookups of {@code address} answer these keys (null to stop). */
    public void swapKeys(String address, PublishedKeys keys) {
        lock.lock();
        try {
            if (keys == null) {
                swapped.remove(canonical(address));
            } else {
                swapped.put(canonical(address), keys);
            }
        } finally {
            lock.unlock();
        }
    }

    // ---- inspection

    /** Everything the relay was sent, in order. */
    public List<Seen> seen() {
        return Collections.unmodifiableList(seen);
    }

    /** How many envelopes wait for a desk. */
    public int pending(String deskId) {
        lock.lock();
        try {
            expire();
            return (int) held.values().stream().filter(h -> h.deskId.equals(deskId)).count();
        } finally {
            lock.unlock();
        }
    }

    /** The keys the directory holds for a desk, or null. */
    public PublishedKeys keysOf(String deskId) {
        lock.lock();
        try {
            return desk(deskId).keys;
        } finally {
            lock.unlock();
        }
    }

    public long keysVersionOf(String deskId) {
        lock.lock();
        try {
            return desk(deskId).keysVersion;
        } finally {
            lock.unlock();
        }
    }

    public int sentCount() {
        return sent.get();
    }

    public int ackedCount() {
        return acked.get();
    }

    /** How many drop objects are held (reserved, uploaded or linked). */
    public int dropCount() {
        lock.lock();
        try {
            return drops.size();
        } finally {
            lock.unlock();
        }
    }

    // ---- HTTP

    private static final class Answer extends Exception {
        final int status;
        final String code;
        final Long retryAfter;

        Answer(int status, String code) {
            this(status, code, null);
        }

        Answer(int status, String code, Long retryAfter) {
            super(code, null, false, false);
            this.status = status;
            this.code = code;
            this.retryAfter = retryAfter;
        }
    }

    private void handle(HttpExchange x) throws IOException {
        byte[] body = x.getRequestBody().readAllBytes();
        String path = x.getRequestURI().getPath();
        String deskId = null;
        int status;
        byte[] out;
        String contentType = "application/json";
        Long retryAfter = null;
        try {
            Duration wait = latency;
            if (!wait.isZero()) {
                Thread.sleep(wait.toMillis());
            }
            if (down) {
                throw new Answer(503, null);
            }
            if (path.startsWith("/fake-s3/out/")) {
                // courier-send's upload: only its length is signed (the door's presign), and it's never read back here.
                mailUpload(x.getRequestMethod(), path.substring("/fake-s3/out/".length()), body);
                status = 200;
                out = new byte[0];
                contentType = "application/octet-stream";
            } else if (path.startsWith("/fake-s3/")) {
                if ("PUT".equals(x.getRequestMethod()) && !"courier=pending".equals(x.getRequestHeaders().getFirst("x-amz-tagging"))) {
                    // A signed header missing: S3 refuses the presigned PUT.
                    throw new Answer(403, null);
                }
                byte[] s3 = s3(x.getRequestMethod(), path.substring("/fake-s3/".length()), body);
                status = 200;
                out = s3;
                contentType = "application/octet-stream";
            } else if (path.startsWith("/v1/device/")) {
                // A paired device (relay.md 0.4.3): signed with its own key, no SigV4.
                Object[] r = deviceRoute(x, path, body);
                status = (Integer) r[0];
                out = r[1] == null ? new byte[0] : J.asBytes(r[1]);
            } else {
                Desk d = caller(x);
                deskId = d.id;
                Object[] r = route(x.getRequestMethod(), path, query(x.getRequestURI()), body, d, x.getRequestHeaders().getFirst("Idempotency-Key"));
                status = (Integer) r[0];
                out = J.asBytes(r[1]);
            }
        } catch (Answer a) {
            status = a.status;
            retryAfter = a.retryAfter;
            out = a.code == null ? "{\"message\":\"Service Unavailable\"}".getBytes(StandardCharsets.UTF_8)
                    : J.asBytes(Map.of("error", Map.of("code", a.code, "message", a.code)));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            status = 500;
            out = new byte[0];
        } catch (RuntimeException e) {
            status = 400;
            out = J.asBytes(Map.of("error", Map.of("code", "invalid_request", "message", "invalid_request")));
        }
        seen.add(new Seen(Instant.now(), x.getRequestMethod(), path, status, deskId, body));
        x.getResponseHeaders().set("Content-Type", contentType);
        if (retryAfter != null) {
            x.getResponseHeaders().set("Retry-After", Long.toString(retryAfter));
        }
        x.sendResponseHeaders(status, out.length == 0 ? -1 : out.length);
        try (OutputStream o = x.getResponseBody()) {
            o.write(out);
        }
    }

    private Desk caller(HttpExchange x) throws Answer {
        lock.lock();
        try {
            String named = x.getRequestHeaders().getFirst(DESK_HEADER);
            Desk d = named == null ? null : desks.get(named);
            if (d == null) {
                String auth = x.getRequestHeaders().getFirst("Authorization");
                Matcher m = auth == null ? null : CREDENTIAL.matcher(auth);
                d = m != null && m.find() ? byAccessKey.get(m.group(1)) : null;
            }
            if (d == null) {
                throw new Answer(403, null);
            }
            return d;
        } finally {
            lock.unlock();
        }
    }

    private Object[] route(String method, String path, Map<String, String> q, byte[] body, Desk d, String idem) throws Answer {
        lock.lock();
        try {
            if (paused) {
                throw new Answer(503, "courier_paused");
            }
            if (!"personal".equals(d.kind) && !"work".equals(d.kind) && !"custom".equals(d.kind)) {
                throw new Answer(409, "desk_kind");
            }
            expire();
            return switch (method + " " + path) {
                case "PUT /v1/agent/keys" -> putKeys(d, json(body));
                case "GET /v1/agent/keys" -> getKeys(d);
                case "GET /v1/agent/keys/lookup" -> lookup(d, q.get("address"));
                case "GET /v1/agent/courier-addresses" -> addresses(d);
                case "POST /v1/agent/relay/drops" -> reserveDrop(d, json(body));
                case "POST /v1/agent/relay/send" -> send(d, json(body), idem, new String(body, StandardCharsets.UTF_8));
                case "GET /v1/agent/relay" -> collect(d, q);
                case "POST /v1/agent/relay/ack" -> ack(d, json(body));
                case "GET /v1/agent/relay/pending" -> new Object[] {200, pendingOf(d)};
                case "POST /v1/agent/courier/send" -> courierSend(d, json(body), idem, new String(body, StandardCharsets.UTF_8));
                case "POST /v1/agent/courier/uploads" -> reserveUpload(d, json(body));
                case "POST /v1/agent/devices/claim" -> claim(d, json(body));
                default -> {
                    if ("DELETE".equals(method) && path.startsWith("/v1/agent/keys/devices/")) {
                        yield deleteDevice(d, path.substring("/v1/agent/keys/devices/".length()), "desk");
                    }
                    throw new Answer(404, "not_found");
                }
            };
        } finally {
            lock.unlock();
        }
    }

    private Object[] putKeys(Desk d, Map<String, Object> b) throws Answer {
        PublishedKeys k;
        try {
            k = PublishedKeys.fromJson(Map.of("identityKey", b.get("identityKey"), "boxKey", b.get("boxKey"), "binding", b.get("binding")));
        } catch (EnvelopeException | NullPointerException e) {
            throw new Answer(400, e instanceof EnvelopeException ee && ee.getMessage().contains("binding") ? "binding_invalid" : "keys_invalid");
        }
        if (!k.bindingValid()) {
            throw new Answer(400, "binding_invalid");
        }
        Instant now = clock.instant();
        boolean changed = !k.sameKeys(d.keys);
        if (changed) {
            Instant dayStart = now.truncatedTo(ChronoUnit.DAYS);
            d.keyChanges.removeIf(t -> t.isBefore(dayStart));
            if (d.keys != null && d.keyChanges.size() >= caps.keyChangesPerDay) {
                throw new Answer(429, "keys_change_limit", Duration.between(now, dayStart.plus(Duration.ofDays(1))).toSeconds() + 1);
            }
            if (d.keys != null) {
                d.keyChanges.add(now);
            }
            d.keys = k;
            d.keysVersion++;
            d.keysUpdatedAt = now;
        }
        return new Object[] {200, m("keysVersion", d.keysVersion, "fingerprint", k.fingerprint(), "changed", changed, "updatedAt", d.keysUpdatedAt.toString())};
    }

    private Object[] getKeys(Desk d) throws Answer {
        if (d.keys == null) {
            throw new Answer(404, "keys_not_set");
        }
        Map<String, Object> m = new LinkedHashMap<>(d.keys.toJson());
        m.put("fingerprint", d.keys.fingerprint());
        m.put("keysVersion", d.keysVersion);
        m.put("updatedAt", d.keysUpdatedAt.toString());
        List<Object> ds = new ArrayList<>();
        for (PairedDevice v : pairedDevices.values()) {
            if (v.deskId.equals(d.id)) {
                ds.add(m("deviceId", v.id, "identityKey", v.identityKey, "boxKey", v.boxKey, "binding", v.binding, "fingerprint",
                        v.fingerprint, "updatedAt", v.pairedAt.toString(), "kind", v.kind, "name", v.name, "pairedAt", v.pairedAt.toString()));
            }
        }
        m.put("devices", ds);
        return new Object[] {200, m};
    }

    private Object[] lookup(Desk d, String address) throws Answer {
        if (d.teen) {
            throw new Answer(403, "courier_teen");
        }
        Instant now = clock.instant();
        d.lookups.removeIf(t -> t.isBefore(now.minus(Duration.ofDays(1))));
        long lastHour = d.lookups.stream().filter(t -> t.isAfter(now.minus(Duration.ofHours(1)))).count();
        if (lastHour >= caps.lookupsPerHour || d.lookups.size() >= caps.lookupsPerDay) {
            throw new Answer(429, "rate_limited", 60L);
        }
        d.lookups.add(now);
        if (address == null) {
            throw new Answer(400, "invalid_request");
        }
        String a = canonical(address);
        Desk to = deskForAddressAnswer(a);
        PublishedKeys k = swapped.getOrDefault(a, to.keys);
        if (k == null) {
            throw new Answer(404, "keys_not_set");
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("address", a);
        m.putAll(k.toJson());
        m.put("fingerprint", k.fingerprint());
        m.put("keysVersion", to.keysVersion);
        return new Object[] {200, m};
    }

    private Object[] addresses(Desk d) {
        List<Object> closed = new ArrayList<>();
        for (String[] c : d.closed) {
            closed.add(m("address", c[0], "closedAt", c[1]));
        }
        Object open = d.address == null ? null
                : m("address", d.address, "name", d.address.substring(0, d.address.indexOf('@')), "createdAt", d.addressCreatedAt.toString());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("domain", DOMAIN);
        out.put("address", open);
        out.put("closed", closed);
        // Proposed for 0.4.1 (draft ADR "Courier's transports" §5): the door's keys, and whether courier-send takes mail.
        if (doorKeysServed) {
            out.put("doorKeys", List.of(m("key", door.publicKey().text())));
        }
        out.put("sending", m("available", courierSendOn));
        return new Object[] {200, out};
    }

    private Object[] reserveDrop(Desk d, Map<String, Object> b) throws Answer {
        if (b.get("to") instanceof String dv && dv.startsWith("dv-")) {
            PairedDevice v = pairedDevices.get(dv);
            if (v == null || !v.deskId.equals(d.id)) {
                throw new Answer(404, "device_unknown");
            }
            return dropFor(d.id, dv, number(b, "bytes"));
        }
        String to = canonical(string(b, "to"));
        Desk recipient = recipientChecks(d, to);
        long bytes = number(b, "bytes");
        if (!Padding.isDropBucket(bytes)) {
            throw new Answer(400, "unpadded");
        }
        Instant now = clock.instant();
        String id = "dr-" + ulid(now);
        drops.put(id, new DropObject(id, d.id, recipient.address, bytes, now));
        // As staging's presigned PUT: the length and the tagging are signed, so the upload must carry both.
        return new Object[] {201, m("dropId", id, "url", baseUrl() + "/fake-s3/" + id, "method", "PUT", "headers",
                m("Content-Length", Long.toString(bytes), "x-amz-tagging", "courier=pending"),
                "expiresAt", now.plus(Duration.ofMinutes(15)).toString())};
    }

    private byte[] s3(String method, String dropId, byte[] body) throws Answer {
        lock.lock();
        try {
            DropObject o = drops.get(dropId);
            if (o == null) {
                throw new Answer(404, null);
            }
            if ("PUT".equals(method)) {
                if (o.content != null || body.length != o.bytes) {
                    throw new Answer(400, null);
                }
                o.content = body;
                return new byte[0];
            }
            if ("GET".equals(method) && o.content != null && o.envelope != null) {
                return o.content;
            }
            throw new Answer(404, null);
        } finally {
            lock.unlock();
        }
    }

    private Desk recipientChecks(Desk sender, String to) throws Answer {
        if (sender.teen) {
            throw new Answer(403, "courier_teen");
        }
        if (sender.address == null) {
            throw new Answer(409, "no_address");
        }
        if (sender.keys == null) {
            throw new Answer(409, "keys_not_set");
        }
        Desk recipient = deskForAddressAnswer(to);
        if (recipient.keys == null) {
            throw new Answer(404, "keys_not_set");
        }
        return recipient;
    }

    private Object[] send(Desk d, Map<String, Object> b, String idem, String rawBody) throws Answer {
        Instant now = clock.instant();
        if (idem != null) {
            if (!idem.matches("[A-Za-z0-9_-]{16,64}")) {
                throw new Answer(400, "invalid_request");
            }
            idempotency.values().removeIf(i -> i.at.isBefore(now.minus(Duration.ofHours(24))));
            Idempotent before = idempotency.get(d.id + " " + idem);
            if (before != null) {
                if (!before.body.equals(rawBody)) {
                    throw new Answer(422, "idempotency_key_reused");
                }
                return new Object[] {before.status, before.answer};
            }
        }
        if (failSends.get() > 0 && failSends.getAndDecrement() > 0) {
            throw new Answer(500, "internal");
        }
        if ("device".equals(b.get("kind")) || (b.get("to") instanceof String t0 && t0.startsWith("dv-"))) {
            return sendToDevice(d, b, idem, rawBody, now);
        }
        if (!"ma".equals(b.get("kind"))) {
            throw new Answer(400, "kind_not_allowed");
        }
        String to = canonical(string(b, "to"));
        Desk recipient = recipientChecks(d, to);
        byte[] enc = decode(b.get("enc"));
        byte[] ct = decode(b.get("ct"));
        if (enc == null || enc.length != Envelope.ENC_BYTES || ct == null) {
            throw new Answer(400, "invalid_request");
        }
        if (ct.length > Envelope.MAX_CT) {
            throw new Answer(413, "too_large");
        }
        if (!Padding.isEnvelopeBucket(ct.length - Envelope.TAG_BYTES)) {
            throw new Answer(400, "unpadded");
        }
        List<String> dropIds = new ArrayList<>();
        if (b.get("drops") instanceof List<?> list) {
            if (list.size() > 8) {
                throw new Answer(400, "invalid_request");
            }
            for (Object o : list) {
                DropObject drop = o instanceof String s ? drops.get(s) : null;
                if (drop == null || !drop.owner.equals(d.id) || !drop.recipient.equals(recipient.address) || drop.content == null
                        || drop.envelope != null) {
                    throw new Answer(409, "drop_missing");
                }
                dropIds.add(drop.id);
            }
        }
        long waiting = held.values().stream().filter(h -> h.deskId.equals(recipient.id)).count();
        long waitingBytes = held.values().stream().filter(h -> h.deskId.equals(recipient.id)).mapToLong(h -> h.bytes(drops)).sum();
        if (waiting >= caps.maxPendingEnvelopes || waitingBytes >= caps.maxPendingBytes) {
            throw new Answer(409, "recipient_full");
        }
        d.sends.removeIf(t -> t.isBefore(now.minus(Duration.ofDays(1))));
        long lastHour = d.sends.stream().filter(t -> t.isAfter(now.minus(Duration.ofHours(1)))).count();
        Instant dayStart = now.truncatedTo(ChronoUnit.DAYS);
        d.recipientsToday.values().removeIf(t -> t.isBefore(dayStart));
        boolean newRecipient = !d.recipientsToday.containsKey(recipient.address);
        if (lastHour >= caps.sendsPerHour || d.sends.size() >= caps.sendsPerDay
                || (newRecipient && d.recipientsToday.size() >= caps.newRecipientsPerDay)) {
            throw new Answer(429, "rate_limited", 60L);
        }
        d.sends.add(now);
        d.recipientsToday.putIfAbsent(recipient.address, now);
        String id = ulid(now);
        held.put(id, new Held(id, "ma", recipient.address, recipient.id, now, now.plus(Duration.ofDays(MA_DAYS)), b64(enc), b64(ct), dropIds));
        for (String dropId : dropIds) {
            drops.get(dropId).envelope = id;
        }
        sent.incrementAndGet();
        Map<String, Object> answer = m("id", id, "receivedAt", now.toString());
        if (idem != null) {
            idempotency.put(d.id + " " + idem, new Idempotent(d.id, rawBody, 202, answer, now));
        }
        notify(recipient, "envelopes");
        return new Object[] {202, answer};
    }

    private String lastPageAfter;
    private List<Map<String, Object>> lastPage = List.of();

    private Object[] collect(Desk d, Map<String, String> q) throws Answer {
        int limit = 100;
        if (q.get("limit") != null) {
            limit = Integer.parseInt(q.get("limit"));
            if (limit < 1 || limit > 100) {
                throw new Answer(400, "invalid_request");
            }
        }
        String after = q.get("after");
        List<Map<String, Object>> page = new ArrayList<>();
        Iterator<Held> it = (after == null ? held : held.tailMap(after, false)).values().iterator();
        boolean more = false;
        String lastId = null;
        while (it.hasNext()) {
            Held h = it.next();
            if (!h.deskId.equals(d.id)) {
                continue;
            }
            if (page.size() == limit) {
                more = true;
                break;
            }
            page.add(view(h));
            lastId = h.id;
        }
        List<Map<String, Object>> answer = new ArrayList<>(page);
        if (duplicateFetches.get() > 0 && duplicateFetches.getAndDecrement() > 0) {
            answer.addAll(0, lastPage);
        }
        lastPage = page;
        if (reorder) {
            Collections.shuffle(answer, random);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("envelopes", answer);
        out.put("next", more ? lastId : null);
        out.put("pending", held.values().stream().filter(h -> h.deskId.equals(d.id)).count());
        return new Object[] {200, out};
    }

    private Map<String, Object> view(Held h) {
        List<Object> ds = new ArrayList<>();
        for (String id : h.drops) {
            DropObject o = drops.get(id);
            ds.add(m("dropId", id, "bytes", o.bytes, "url", baseUrl() + "/fake-s3/" + id, "urlExpiresAt",
                    clock.instant().plus(Duration.ofMinutes(15)).toString()));
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", h.id);
        m.put("kind", h.kind);
        m.put("to", h.to);
        m.put("receivedAt", h.receivedAt.toString());
        m.put("expiresAt", h.expiresAt.toString());
        m.put("enc", h.enc);
        m.put("ct", h.ct);
        m.put("drops", ds);
        return m;
    }

    private Object[] ack(Desk d, Map<String, Object> b) throws Answer {
        if (!(b.get("ids") instanceof List<?> ids) || ids.isEmpty() || ids.size() > 100) {
            throw new Answer(400, "invalid_request");
        }
        int n = 0;
        boolean lose = loseAcks.get() > 0 && loseAcks.getAndDecrement() > 0;
        for (Object o : ids) {
            Held h = o instanceof String s ? held.get(s) : null;
            n++;
            if (h != null && h.deskId.equals(d.id) && !lose) {
                held.remove(h.id);
                h.drops.forEach(drops::remove);
                acked.incrementAndGet();
            }
        }
        return new Object[] {200, m("acked", n, "pending", held.values().stream().filter(h -> h.deskId.equals(d.id)).count())};
    }

    private Map<String, Object> pendingOf(Desk d) {
        Held oldest = held.values().stream().filter(h -> h.deskId.equals(d.id)).findFirst().orElse(null);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("pending", held.values().stream().filter(h -> h.deskId.equals(d.id)).count());
        out.put("oldestAt", oldest == null ? null : oldest.receivedAt.toString());
        return out;
    }

    /** Expired envelopes and their drops go; unlinked drops go after a day. */
    private void expire() {
        Instant now = clock.instant();
        held.values().removeIf(h -> {
            if (!h.expiresAt.isAfter(now)) {
                h.drops.forEach(drops::remove);
                return true;
            }
            return false;
        });
        drops.values().removeIf(o -> o.envelope == null && o.reservedAt.plus(Duration.ofDays(1)).isBefore(now));
    }

    // ---- paired devices (relay.md 0.4.3): MA Connector for Mac pairs with a code the member types into Courier

    static final String USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
    static final long DEVICE_UP_DAYS = 90;
    static final long DEVICE_DOWN_DAYS = 30;
    static final int DEVICE_CT_MAX = 32_768 + 16;

    private static final class PairedDevice {
        final String id;
        final String deskId;
        final String identityKey;
        final String boxKey;
        final String binding;
        final String fingerprint;
        final String kind;
        final String name;
        final Instant pairedAt;

        PairedDevice(String id, String deskId, Pairing p, Instant at) {
            this.id = id;
            this.deskId = deskId;
            this.identityKey = p.identityKey;
            this.boxKey = p.boxKey;
            this.binding = p.binding;
            this.fingerprint = p.fingerprint;
            this.kind = p.kind;
            this.name = p.name;
            this.pairedAt = at;
        }
    }

    private static final class Pairing {
        final String id;
        final String code;
        final String identityKey;
        final String boxKey;
        final String binding;
        final String fingerprint;
        final String kind;
        final String name;
        final Instant expiresAt;
        String deviceId;
        String deskId;

        Pairing(String id, String code, PublishedKeys k, String kind, String name, Instant expiresAt) {
            this.id = id;
            this.code = code;
            this.identityKey = k.identityKey().text();
            this.boxKey = k.boxKey().text();
            this.binding = k.toJson().get("binding").toString();
            this.fingerprint = k.fingerprint();
            this.kind = kind;
            this.name = name;
            this.expiresAt = expiresAt;
        }
    }

    private final Map<String, PairedDevice> pairedDevices = new LinkedHashMap<>();
    private final Map<String, Pairing> pairings = new LinkedHashMap<>();
    private final Map<String, Instant> deviceNonces = new HashMap<>();
    private volatile boolean devicesOn = true;
    private volatile String lastUserCode;

    /** {@code courier#current.devices.enabled}: false answers {@code 503 courier_paused} on every device route and the claim. */
    public void setDevicesEnabled(boolean on) {
        devicesOn = on;
    }

    /** The code the last pairing showed (a test types it into Courier as the member would). */
    public String lastUserCode() {
        return lastUserCode;
    }

    /** The devices paired with a desk. */
    public List<String> deviceIds(String deskId) {
        lock.lock();
        try {
            return pairedDevices.values().stream().filter(v -> v.deskId.equals(deskId)).map(v -> v.id).toList();
        } finally {
            lock.unlock();
        }
    }

    /** The member's "Remove" in the account site: {@code DELETE /v1/me/courier/desks/{deskId}/devices/{deviceId}}. */
    public void removeDeviceAsMember(String deviceId) {
        lock.lock();
        try {
            PairedDevice v = pairedDevices.get(deviceId);
            if (v != null) {
                deleteDevice(desk(v.deskId), deviceId, "member");
            }
        } catch (Answer a) {
            throw new IllegalStateException(a.code);
        } finally {
            lock.unlock();
        }
    }

    /** Envelopes waiting for a device. */
    public int pendingForDevice(String deviceId) {
        lock.lock();
        try {
            return (int) held.values().stream().filter(h -> h.deskId.equals(deviceId)).count();
        } finally {
            lock.unlock();
        }
    }

    static String normalCode(String code) {
        return code == null ? "" : code.toUpperCase(Locale.ROOT).replace("-", "").replace(" ", "");
    }

    private Object[] claim(Desk d, Map<String, Object> b) throws Answer {
        if (!devicesOn) {
            throw new Answer(503, "courier_paused");
        }
        if (d.teen) {
            throw new Answer(403, "courier_teen");
        }
        if (d.keys == null) {
            throw new Answer(409, "keys_not_set");
        }
        String code = normalCode(b.get("userCode") instanceof String c ? c : null);
        if (code.length() != 8 || !code.chars().allMatch(c -> USER_CODE_ALPHABET.indexOf(c) >= 0)) {
            throw new Answer(400, "invalid_request");
        }
        Instant now = clock.instant();
        Pairing p = pairings.values().stream().filter(x -> x.code.equals(code) && x.deviceId == null && x.expiresAt.isAfter(now))
                .findFirst().orElseThrow(() -> new Answer(404, "pairing_unknown"));
        if (pairedDevices.values().stream().filter(v -> v.deskId.equals(d.id)).count() >= 5) {
            throw new Answer(409, "device_limit");
        }
        StringBuilder id = new StringBuilder("dv-");
        for (int i = 0; i < 12; i++) {
            id.append("abcdefghijklmnopqrstuvwxyz234567".charAt(random.nextInt(32)));
        }
        p.deviceId = id.toString();
        p.deskId = d.id;
        PairedDevice v = new PairedDevice(p.deviceId, d.id, p, now);
        pairedDevices.put(v.id, v);
        return new Object[] {200, m("deviceId", v.id, "kind", v.kind, "name", v.name, "identityKey", v.identityKey, "boxKey", v.boxKey,
                "binding", v.binding, "fingerprint", v.fingerprint, "pairedAt", now.toString())};
    }

    private Object[] deleteDevice(Desk d, String deviceId, String by) throws Answer {
        PairedDevice v = pairedDevices.get(deviceId);
        if (v != null && v.deskId.equals(d.id)) {
            pairedDevices.remove(deviceId);
            held.values().removeIf(h -> {
                if (h.deskId.equals(deviceId)) {
                    h.drops.forEach(drops::remove);
                    return true;
                }
                return false;
            });
            if (!"desk".equals(by)) {
                notify(d, "devices");
            }
        }
        return new Object[] {204, null};
    }

    private Object[] dropFor(String owner, String recipient, long bytes) throws Answer {
        if (!Padding.isDropBucket(bytes)) {
            throw new Answer(400, "unpadded");
        }
        Instant now = clock.instant();
        String id = "dr-" + ulid(now);
        drops.put(id, new DropObject(id, owner, recipient, bytes, now));
        return new Object[] {201, m("dropId", id, "url", baseUrl() + "/fake-s3/" + id, "method", "PUT", "headers",
                m("Content-Length", Long.toString(bytes), "x-amz-tagging", "courier=pending"),
                "expiresAt", now.plus(Duration.ofMinutes(15)).toString())};
    }

    /** One envelope into a device's inbox (the desk's down direction) or a desk's (the device's up direction). */
    private Object[] hold(String sender, String recipientKey, String to, Desk notifyDesk, Map<String, Object> b, String idem, String rawBody,
            Instant now, long days) throws Answer {
        if (idem != null) {
            if (!idem.matches("[A-Za-z0-9_-]{16,64}")) {
                throw new Answer(400, "invalid_request");
            }
            Idempotent before = idempotency.get(sender + " " + idem);
            if (before != null) {
                if (!before.body.equals(rawBody)) {
                    throw new Answer(422, "idempotency_key_reused");
                }
                return new Object[] {before.status, before.answer};
            }
        }
        if (!"device".equals(b.get("kind"))) {
            throw new Answer(400, "kind_not_allowed");
        }
        byte[] enc = decode(b.get("enc"));
        byte[] ct = decode(b.get("ct"));
        if (enc == null || enc.length != Envelope.ENC_BYTES || ct == null) {
            throw new Answer(400, "invalid_request");
        }
        if (ct.length > DEVICE_CT_MAX) {
            throw new Answer(413, "too_large");
        }
        if (!Padding.isEnvelopeBucket(ct.length - Envelope.TAG_BYTES)) {
            throw new Answer(400, "unpadded");
        }
        List<String> dropIds = new ArrayList<>();
        if (b.get("drops") instanceof List<?> list) {
            if (list.size() > 8) {
                throw new Answer(400, "invalid_request");
            }
            for (Object o : list) {
                DropObject drop = o instanceof String s ? drops.get(s) : null;
                if (drop == null || !drop.owner.equals(sender) || !drop.recipient.equals(recipientKey) || drop.content == null
                        || drop.envelope != null) {
                    throw new Answer(409, "drop_missing");
                }
                dropIds.add(drop.id);
            }
        }
        long waiting = held.values().stream().filter(h -> h.deskId.equals(recipientKey)).count();
        if (waiting >= caps.maxPendingEnvelopes) {
            throw new Answer(409, "recipient_full");
        }
        String id = ulid(now);
        held.put(id, new Held(id, "device", to, recipientKey, now, now.plus(Duration.ofDays(days)), b64(enc), b64(ct), dropIds));
        for (String dropId : dropIds) {
            drops.get(dropId).envelope = id;
        }
        sent.incrementAndGet();
        Map<String, Object> answer = m("id", id, "receivedAt", now.toString());
        if (idem != null) {
            idempotency.put(sender + " " + idem, new Idempotent(sender, rawBody, 202, answer, now));
        }
        if (notifyDesk != null) {
            notify(notifyDesk, "envelopes");
        }
        return new Object[] {202, answer};
    }

    private Object[] sendToDevice(Desk d, Map<String, Object> b, String idem, String rawBody, Instant now) throws Answer {
        if (!devicesOn) {
            throw new Answer(503, "courier_paused");
        }
        if (d.keys == null) {
            throw new Answer(409, "keys_not_set");
        }
        String to = b.get("to") instanceof String t ? t : "";
        if (!"device".equals(b.get("kind")) || !to.startsWith("dv-")) {
            throw new Answer(400, "kind_not_allowed");
        }
        PairedDevice v = pairedDevices.get(to);
        if (v == null || !v.deskId.equals(d.id)) {
            throw new Answer(404, "device_unknown");
        }
        return hold(d.id, v.id, v.id, null, b, idem, rawBody, now, DEVICE_DOWN_DAYS);
    }

    private Object[] deviceRoute(HttpExchange x, String path, byte[] body) throws Answer {
        lock.lock();
        try {
            if (paused || !devicesOn) {
                throw new Answer(503, "courier_paused");
            }
            expire();
            String method = x.getRequestMethod();
            String key = x.getRequestHeaders().getFirst("MA-Device-Key");
            String date = x.getRequestHeaders().getFirst("MA-Date");
            String nonce = x.getRequestHeaders().getFirst("MA-Nonce");
            String sig = x.getRequestHeaders().getFirst("MA-Signature");
            Instant now = clock.instant();
            if (key == null || date == null || nonce == null || sig == null || !nonce.matches("[A-Za-z0-9_-]{22}")) {
                throw new Answer(401, "bad_signature");
            }
            Instant when;
            try {
                when = Instant.parse(date);
            } catch (RuntimeException e) {
                throw new Answer(401, "bad_signature");
            }
            if (Duration.between(when, now).abs().toSeconds() > 300) {
                throw new Answer(401, "bad_date");
            }
            String query = x.getRequestURI().getRawQuery() == null ? "" : x.getRequestURI().getRawQuery();
            byte[] signed = ("ma-device-req/v1\n" + method + "\n" + x.getRequestURI().getRawPath() + "\n" + query + "\n" + date + "\n"
                    + nonce + "\n" + java.util.HexFormat.of().formatHex(sha256(body))).getBytes(StandardCharsets.UTF_8);
            try {
                byte[] s = Base64.getUrlDecoder().decode(sig);
                if (!com.minimalistalliance.desk.courier.envelope.IdentityKey.parse(key).verifies(signed, s)) {
                    throw new Answer(401, "bad_signature");
                }
            } catch (EnvelopeException | IllegalArgumentException e) {
                throw new Answer(401, "bad_signature");
            }
            if (!"GET".equals(method)) {
                deviceNonces.values().removeIf(t -> t.isBefore(now.minus(Duration.ofMinutes(15))));
                if (deviceNonces.putIfAbsent(key + " " + nonce, now) != null) {
                    throw new Answer(401, "replay");
                }
            }
            if ("POST".equals(method) && path.equals("/v1/device/pairings")) {
                Map<String, Object> b = json(body);
                PublishedKeys k;
                try {
                    k = PublishedKeys.fromJson(Map.of("identityKey", b.get("identityKey"), "boxKey", b.get("boxKey"), "binding", b.get("binding")));
                } catch (EnvelopeException | NullPointerException e) {
                    throw new Answer(400, "keys_invalid");
                }
                if (!k.bindingValid()) {
                    throw new Answer(400, "binding_invalid");
                }
                if (!key.equals(k.identityKey().text())) {
                    throw new Answer(401, "bad_signature");
                }
                if (pairedDevices.values().stream().anyMatch(v -> v.identityKey.equals(key))) {
                    throw new Answer(409, "device_paired");
                }
                StringBuilder code = new StringBuilder();
                for (int i = 0; i < 8; i++) {
                    code.append(USER_CODE_ALPHABET.charAt(random.nextInt(USER_CODE_ALPHABET.length())));
                }
                String id = "pr-" + ulid(now);
                Pairing p = new Pairing(id, code.toString(), k, "mac", string(b, "name"), now.plus(Duration.ofMinutes(10)));
                pairings.put(id, p);
                lastUserCode = p.code.substring(0, 4) + "-" + p.code.substring(4);
                return new Object[] {201, m("pairingId", id, "userCode", lastUserCode, "expiresAt", p.expiresAt.toString(), "interval", 5)};
            }
            if ("GET".equals(method) && path.startsWith("/v1/device/pairings/")) {
                Pairing p = pairings.get(path.substring("/v1/device/pairings/".length()));
                if (p == null || !p.identityKey.equals(key)) {
                    throw new Answer(404, "not_found");
                }
                if (p.deviceId == null) {
                    if (!p.expiresAt.isAfter(now)) {
                        throw new Answer(410, "pairing_expired");
                    }
                    return new Object[] {200, m("state", "waiting", "expiresAt", p.expiresAt.toString())};
                }
                Desk dk = desk(p.deskId);
                Map<String, Object> deskKeys = new LinkedHashMap<>(dk.keys.toJson());
                deskKeys.put("name", "Personal");
                deskKeys.put("kind", dk.kind);
                deskKeys.put("fingerprint", dk.keys.fingerprint());
                deskKeys.put("keysVersion", dk.keysVersion);
                return new Object[] {200, m("state", "paired", "deviceId", p.deviceId, "pairedAt", now.toString(), "desk", deskKeys)};
            }
            PairedDevice v = pairedDevices.values().stream().filter(dv -> dv.identityKey.equals(key)).findFirst().orElse(null);
            if (v == null) {
                throw new Answer(401, "device_unknown");
            }
            Desk dk = desk(v.deskId);
            String idem = x.getRequestHeaders().getFirst("Idempotency-Key");
            Map<String, String> q = query(x.getRequestURI());
            return switch (method + " " + path) {
                case "POST /v1/device/relay/send" -> hold(v.id, dk.id, v.id, dk, json(body), idem, new String(body, StandardCharsets.UTF_8), now,
                        DEVICE_UP_DAYS);
                case "POST /v1/device/relay/drops" -> dropFor(v.id, dk.id, number(json(body), "bytes"));
                case "GET /v1/device/relay" -> collect(new Desk(v.id, "device"), q);
                case "POST /v1/device/relay/ack" -> ack(new Desk(v.id, "device"), json(body));
                case "GET /v1/device/relay/pending" -> new Object[] {200, pendingOf(new Desk(v.id, "device"))};
                case "DELETE /v1/device/self" -> deleteDevice(dk, v.id, "device");
                default -> throw new Answer(404, "not_found");
            };
        } finally {
            lock.unlock();
        }
    }

    private static byte[] sha256(byte[] b) {
        try {
            return java.security.MessageDigest.getInstance("SHA-256").digest(b);
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    // ---- helpers

    private Desk desk(String deskId) {
        Desk d = desks.get(deskId);
        if (d == null) {
            throw new IllegalArgumentException("no such desk");
        }
        return d;
    }

    private Desk deskForAddress(String address) {
        try {
            return deskForAddressAnswer(address);
        } catch (Answer a) {
            throw new IllegalStateException(a.code);
        }
    }

    private Desk deskForAddressAnswer(String address) throws Answer {
        int at = address.indexOf('@');
        if (at < 1 || !address.substring(at + 1).equals(DOMAIN)) {
            throw new Answer(404, "address_unknown");
        }
        String owner = names.get(address.substring(0, at));
        if (owner == null) {
            throw new Answer(404, "address_unknown");
        }
        Desk d = desks.get(owner);
        if (d == null || !address.equals(d.address)) {
            throw new Answer(410, "address_closed");
        }
        return d;
    }

    /** Lower case, and {@code name+tag@} routed to {@code name@}. */
    static String canonical(String address) {
        String a = address.toLowerCase(Locale.ROOT);
        int plus = a.indexOf('+');
        int at = a.indexOf('@');
        return plus >= 0 && plus < at ? a.substring(0, plus) + a.substring(at) : a;
    }

    /** A ULID: 48 bits of milliseconds, then 80 random bits, the random part counting up within one millisecond. */
    private String ulid(Instant at) {
        long ms = Math.max(at.toEpochMilli(), lastUlidMillis);
        if (ms == lastUlidMillis) {
            ulidLo++;
            if (ulidLo >= (1L << 40)) {
                ulidLo = 0;
                ulidHi = (ulidHi + 1) & ((1L << 40) - 1);
            }
        } else {
            lastUlidMillis = ms;
            ulidHi = random.nextLong() & ((1L << 39) - 1);
            ulidLo = random.nextLong() & ((1L << 39) - 1);
        }
        StringBuilder s = new StringBuilder(26);
        for (int i = 9; i >= 0; i--) {
            s.append(CROCKFORD.charAt((int) ((ms >>> (5 * i)) & 31)));
        }
        for (long part : new long[] {ulidHi, ulidLo}) {
            for (int i = 7; i >= 0; i--) {
                s.append(CROCKFORD.charAt((int) ((part >>> (5 * i)) & 31)));
            }
        }
        return s.toString();
    }

    private static String at(Instant t) {
        Instant ms = t.truncatedTo(ChronoUnit.MILLIS);
        String s = ms.toString();
        return s.contains(".") ? s : s.replace("Z", ".000Z");
    }

    private static Map<String, Object> json(byte[] body) throws Answer {
        try {
            Map<String, Object> m = J.mapFrom(body);
            if (m == null) {
                throw new Answer(400, "invalid_request");
            }
            return m;
        } catch (Answer a) {
            throw a;
        } catch (RuntimeException e) {
            throw new Answer(400, "invalid_request");
        }
    }

    private static String string(Map<String, Object> m, String key) throws Answer {
        if (m.get(key) instanceof String s && !s.isEmpty()) {
            return s;
        }
        throw new Answer(400, "invalid_request");
    }

    private static long number(Map<String, Object> m, String key) throws Answer {
        if (m.get(key) instanceof Number n) {
            return n.longValue();
        }
        throw new Answer(400, "invalid_request");
    }

    private static byte[] decode(Object o) {
        if (!(o instanceof String s) || !s.matches("[A-Za-z0-9_-]+")) {
            return null;
        }
        try {
            return Base64.getUrlDecoder().decode(s);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static String b64(byte[] b) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    private static Map<String, String> query(URI uri) {
        Map<String, String> q = new HashMap<>();
        String raw = uri.getRawQuery();
        if (raw != null) {
            for (String pair : raw.split("&")) {
                int eq = pair.indexOf('=');
                if (eq > 0) {
                    q.put(URLDecoder.decode(pair.substring(0, eq), StandardCharsets.UTF_8), URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8));
                }
            }
        }
        return q;
    }

    private static Map<String, Object> m(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put((String) kv[i], kv[i + 1]);
        }
        return m;
    }

    @Override
    public void close() {
        server.stop(0);
    }
}
