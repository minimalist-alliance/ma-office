package com.minimalistalliance.desk.deskd.courier.relay;

import com.minimalistalliance.desk.courier.envelope.Drop;
import com.minimalistalliance.desk.courier.envelope.Envelope;
import com.minimalistalliance.desk.courier.envelope.EnvelopeException;
import com.minimalistalliance.desk.courier.envelope.IdentityKey;
import com.minimalistalliance.desk.courier.envelope.Signed;
import com.minimalistalliance.desk.deskd.courier.parse.ParsedMessage;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.ExternalIds;
import com.minimalistalliance.desk.deskd.courier.store.RelayState;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * One drain of the relay (contract 0.4.0 §3.4; draft ADR "Courier's transports" §2): collect a page, open and check each
 * envelope, store what's good in one transaction with its tombstone, then ack. <b>An envelope is acked only once its
 * message is on disk</b> (or it was refused for good, or held); anything that may pass later (the directory unreachable, a
 * drop's link not issued today, the door's key not known yet) stays unacked and comes back at the next drain. Nothing is
 * ever acked that wasn't looked at, and nothing a drain can't keep is acked.
 *
 * <p>Refused for good, acked and counted by reason (never with content): an envelope that doesn't open, isn't for this
 * desk, is too old to be anything but a replay ({@code p.at} past the relay's wait plus a day), a payload that doesn't
 * read, a forged sender, a sender with no keys to check. A second copy of an envelope already taken in is acked without
 * being stored again (its tombstone, or the sink's own key).
 */
final class Drain {

    private static final Logger log = LoggerFactory.getLogger(Drain.class);

    static final long DAY = 24L * 3600 * 1000;
    /** How long the relay keeps an envelope (contract §3.3): a message older than this plus a day of skew is a replay. */
    static final long MA_WAIT = 30 * DAY;
    static final long MAIL_WAIT = 90 * DAY;
    static final long SKEW = DAY;
    static final int PAGE = 100;
    /**
     * Bytes of bodies held before the batch so far is stored and acked (Security CT-M3: deskd's heap is small): 16 MiB, and
     * a body over {@link #BIG_BODY} is stored at once, so the drain holds about one large message at a time.
     */
    static final long BATCH_BYTES = 16L * 1024 * 1024;
    static final long BIG_BODY = 4L * 1024 * 1024;
    /** Drains an envelope may fail in before it's refused for good (Security CT-H1: no envelope stops a drain). */
    static final int MAX_FAILURES = 3;
    /** How long the door's signature may keep failing (the platform's lag in serving a new key) before mail is refused. */
    static final long DOOR_KEY_GRACE = 3600_000L;

    /** What the drain needs of the transport around it. */
    interface Context {
        RelayApi api();

        RelayState state();

        Pins pins();

        Envelope.Recipient recipient();

        /** The desk's addresses: open first, then closed. Empty with none. */
        List<String> addresses();

        /** The door's signing keys (proposed for 0.4.1); empty while the platform gives none. */
        List<IdentityKey> doorKeys();

        /** The Courier domain, whose {@code mailer-daemon@} signs door mail. */
        String domain();

        IdentityKey ownIdentity();

        boolean maOn();

        boolean doorOn();

        long now();

        /** The door's key may have changed: read the addresses again before the next drain. */
        void doorKeyStale();

        /** Where paired devices' envelopes go (relay.md 0.4.3); null with none. */
        default DeviceInbox devices() {
            return null;
        }
    }

    /** What happened to each envelope, for the status and tests. */
    static final class Counts {
        final AtomicLong stored = new AtomicLong();
        final AtomicLong duplicates = new AtomicLong();
        final AtomicLong held = new AtomicLong();
        final AtomicLong notes = new AtomicLong();
        final AtomicLong waiting = new AtomicLong();
        final Map<String, AtomicLong> refused = new ConcurrentHashMap<>();
        final Map<String, AtomicLong> removedByDoor = new ConcurrentHashMap<>();

        void refused(String reason) {
            refused.computeIfAbsent(reason, k -> new AtomicLong()).incrementAndGet();
        }

        Map<String, Object> toMap() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("stored", stored.get());
            m.put("duplicates", duplicates.get());
            m.put("held", held.get());
            m.put("notes", notes.get());
            Map<String, Object> r = new LinkedHashMap<>();
            refused.forEach((k, v) -> r.put(k, v.get()));
            m.put("refused", r);
            Map<String, Object> d = new LinkedHashMap<>();
            removedByDoor.forEach((k, v) -> d.put(k, v.get()));
            m.put("removedByDoor", d);
            return m;
        }
    }

    /** The result of one drain. */
    record Result(int fetched, int acked, int waiting, Integer pending, String problem) {}

    private sealed interface Step permits Store, Ack, Wait {}

    /** Store this message (with a tombstone until {@code until}), then ack. */
    private record Store(String relayId, Courier.Inbound inbound, long until, long bytes) implements Step {}

    /** Ack now: refused for good, held, a note applied, or a copy already taken in. */
    private record Ack(String relayId) implements Step {}

    /** Not now: comes back at the next drain. */
    private record Wait(String relayId, String reason) implements Step {}

    private final Context ctx;
    private final Counts counts;
    /** When each envelope's door signature first failed (the door may be serving a new key late). */
    private final Map<String, Long> doorKeyMisses = new ConcurrentHashMap<>();
    /** Drains each envelope failed in. */
    private final Map<String, Integer> failures = new ConcurrentHashMap<>();

    Drain(Context ctx, Counts counts) {
        this.ctx = ctx;
        this.counts = counts;
    }

    /**
     * Collects and handles everything waiting, a page at a time.
     *
     * @param origin {@code CATCHUP} for the drain after a wake, {@code LIVE} for a push or the poll
     * @throws IOException the relay couldn't be reached or refused the collect (the drain stops; nothing unstored was acked)
     */
    Result run(Courier.Origin origin) throws IOException, InterruptedException, SQLException {
        // A desk with no address of its own still collects its paired devices' envelopes (sealed to its box key).
        DeviceInbox devices = ctx.devices();
        boolean forDevices = devices != null && devices.any();
        if ((ctx.addresses().isEmpty() && !forDevices) || ctx.recipient().boxKeys().isEmpty()) {
            return new Result(0, 0, 0, null, ctx.recipient().boxKeys().isEmpty() ? "keys" : "no_address");
        }
        ctx.pins().forgetLookups();
        String after = null;
        int fetched = 0;
        int acked = 0;
        int waiting = 0;
        Integer pending = null;
        try {
            while (true) {
                Map<String, Object> page = ctx.api().collect(after, PAGE);
                List<Map<String, Object>> envelopes = envelopes(page.get("envelopes"));
                fetched += envelopes.size();
                List<Step> steps = new ArrayList<>();
                long bytes = 0;
                for (Map<String, Object> e : envelopes) {
                    Step s = step(e, origin);
                    steps.add(s);
                    if (s instanceof Store st) {
                        bytes += st.bytes();
                        if (bytes >= BATCH_BYTES || st.bytes() >= BIG_BODY) {
                            acked += commit(steps);
                            steps.clear();
                            bytes = 0;
                        }
                    }
                }
                for (Step s : steps) {
                    if (s instanceof Wait) {
                        waiting++;
                    }
                }
                acked += commit(steps);
                if (page.get("pending") instanceof Number n) {
                    pending = n.intValue();
                }
                Object next = page.get("next");
                if (!(next instanceof String nx) || nx.isEmpty() || envelopes.isEmpty()) {
                    break;
                }
                after = nx;
            }
        } finally {
            ctx.pins().forgetLookups();
        }
        counts.waiting.set(waiting);
        return new Result(fetched, acked, waiting, pending, null);
    }

    /** Stores the batch's messages in one transaction, then acks what's done. */
    private int commit(List<Step> steps) throws IOException, InterruptedException, SQLException {
        List<Courier.Inbound> batch = new ArrayList<>();
        List<Long> until = new ArrayList<>();
        List<String> storeIds = new ArrayList<>();
        List<String[]> relayTombstones = new ArrayList<>();
        List<String> ackIds = new ArrayList<>();
        for (Step s : steps) {
            if (s instanceof Store st) {
                batch.add(st.inbound());
                until.add(st.until());
                storeIds.add(st.relayId());
                relayTombstones.add(new String[] {st.relayId(), Long.toString(st.until())});
            } else if (s instanceof Ack a) {
                ackIds.add(a.relayId());
            }
        }
        if (!batch.isEmpty()) {
            // Throws on a full disk or a store that can't write: nothing of the batch is kept, and none of it is acked.
            List<Courier.Accepted> answers = ctx.state().accept(batch, until, List.of(), relayTombstones);
            for (int i = 0; i < answers.size(); i++) {
                Courier.Accepted a = answers.get(i);
                switch (a.kind()) {
                    case STORED, PENDING -> counts.stored.incrementAndGet();
                    case DUPLICATE -> counts.duplicates.incrementAndGet();
                    case REFUSED -> counts.refused("store_" + a.reason());
                }
                ackIds.add(storeIds.get(i));
                failures.remove(storeIds.get(i));
            }
        }
        int acked = 0;
        for (int i = 0; i < ackIds.size(); i += PAGE) {
            List<String> chunk = ackIds.subList(i, Math.min(ackIds.size(), i + PAGE));
            ctx.api().ack(new ArrayList<>(chunk));
            acked += chunk.size();
        }
        return acked;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> envelopes(Object o) throws IOException {
        if (!(o instanceof List<?> l)) {
            throw new IOException("the relay's page has no envelopes");
        }
        List<Map<String, Object>> out = new ArrayList<>(l.size());
        for (Object e : l) {
            if (e instanceof Map<?, ?> m) {
                out.add((Map<String, Object>) m);
            }
        }
        return out;
    }

    private Step step(Map<String, Object> e, Courier.Origin origin) throws InterruptedException, SQLException {
        String relayId = e.get("id") instanceof String s && Signed.ULID.matcher(s).matches() ? s : null;
        if (relayId == null) {
            // An envelope without an id can't be acked; the relay is wrong. Skipped.
            counts.refused("no_id");
            return new Wait(null, "no_id");
        }
        String kind = e.get("kind") instanceof String k ? k : "";
        if (Envelope.MA.equals(kind) && !ctx.maOn()) {
            return new Wait(relayId, "switched_off");
        }
        if (Envelope.MAIL.equals(kind) && !ctx.doorOn()) {
            return new Wait(relayId, "switched_off");
        }
        if (ctx.state().seen("relay", relayId)) {
            counts.duplicates.incrementAndGet();
            return new Ack(relayId);
        }
        try {
            Step s = switch (kind) {
                case Envelope.MA -> member(relayId, e, origin);
                case Envelope.MAIL -> mail(relayId, e, origin);
                case com.minimalistalliance.desk.courier.envelope.DeviceEnvelope.KIND -> device(relayId, e, origin);
                default -> refuse(relayId, "kind");
            };
            if (!(s instanceof Wait)) {
                failures.remove(relayId);
            }
            return s;
        } catch (EnvelopeException x) {
            return refuse(relayId, x.reason());
        } catch (Payloads.Bad x) {
            return refuse(relayId, "payload");
        } catch (IOException x) {
            // A drop that didn't come down (the network, S3): the next drain tries again.
            return new Wait(relayId, "drop");
        } catch (RuntimeException x) {
            // Whatever one envelope holds, it never stops the drain for the others (Security CT-H1).
            Drain.log.warn("courier relay: an envelope failed ({})", x.getClass().getSimpleName());
            return failed(relayId, "error");
        }
    }

    /**
     * A paired device's envelope: the device path reads it and keeps what it holds itself (with its place in Messages), so
     * here it's only acked or left. With no device path (an image without it), it's refused.
     */
    private Step device(String relayId, Map<String, Object> e, Courier.Origin origin) throws InterruptedException, SQLException {
        DeviceInbox devices = ctx.devices();
        if (devices == null) {
            return refuse(relayId, "kind");
        }
        return devices.take(relayId, e, origin) == DeviceInbox.Outcome.ACK ? new Ack(relayId) : new Wait(relayId, "device");
    }

    /** An envelope that failed this drain: it waits, and after {@link #MAX_FAILURES} drains it's refused for good. */
    private Step failed(String relayId, String reason) throws SQLException {
        if (failures.size() > 10_000) {
            failures.clear();
        }
        int n = failures.merge(relayId, 1, Integer::sum);
        if (n >= MAX_FAILURES) {
            failures.remove(relayId);
            return refuse(relayId, reason);
        }
        return new Wait(relayId, reason);
    }

    private Step refuse(String relayId, String reason) throws SQLException {
        counts.refused(reason);
        // A copy of this envelope from the relay is refused at once, without opening it again.
        ctx.state().tombstone("relay", relayId, ctx.now() + MAIL_WAIT + SKEW);
        return new Ack(relayId);
    }

    // ---- a member's message

    private Step member(String relayId, Map<String, Object> e, Courier.Origin origin)
            throws EnvelopeException, Payloads.Bad, IOException, InterruptedException, SQLException {
        Envelope.Sealed sealed = Envelope.Sealed.fromJson(e);
        Signed.Unverified u = Signed.open(Envelope.MA, ctx.recipient(), sealed.enc(), sealed.ct());
        if (!Payloads.MESSAGE.equals(u.kind())) {
            return refuse(relayId, "kind");
        }
        long now = ctx.now();
        long at = Payloads.millis(u.at());
        if (at < now - MA_WAIT - SKEW) {
            return refuse(relayId, "stale");
        }
        if (at > now + SKEW) {
            // From the future: its tombstone would never expire (Security CT-I5).
            return refuse(relayId, "future");
        }
        if (ctx.domain() == null) {
            return new Wait(relayId, "domain");
        }
        if (!u.from().endsWith("@" + ctx.domain())) {
            // Only a member's address on the Courier domain has keys to check; nothing else is looked up (Security CT-M1).
            return refuse(relayId, "foreign_from");
        }
        String externalId = "ma1:" + u.from() + ":" + u.id();
        if (ctx.state().seen("ma", externalId)) {
            counts.duplicates.incrementAndGet();
            ctx.state().tombstone("relay", relayId, now + MA_WAIT + SKEW);
            return new Ack(relayId);
        }
        long until = Math.max(at, now) + MA_WAIT + SKEW;
        boolean own = ctx.addresses().contains(u.from());
        Signed.Verified v;
        Pins.Outcome outcome;
        if (own) {
            // From this desk's own address: only this desk's identity signs those.
            IdentityKey me = ctx.ownIdentity();
            v = me == null ? null : verifyOrNull(u, me);
            outcome = v == null ? Pins.Outcome.FORGED : Pins.Outcome.ACCEPT;
        } else {
            Pins.Checked checked = ctx.pins().sender(u);
            v = checked.verified();
            outcome = checked.outcome();
            if (outcome == Pins.Outcome.WAIT) {
                return new Wait(relayId, checked.reason());
            }
        }
        if (outcome == Pins.Outcome.FORGED || outcome == Pins.Outcome.UNVERIFIABLE || v == null) {
            return refuse(relayId, outcome == Pins.Outcome.UNVERIFIABLE ? "unverifiable" : "forged");
        }
        Payloads.Message m = Payloads.readMessage(v.payload());
        byte[] body = null;
        if (m.drop() != null) {
            body = dropBody(e, m.drop(), Payloads.MAX_TEXT * 4L);
            if (body == null) {
                return new Wait(relayId, "drop_link");
            }
        }
        if (outcome == Pins.Outcome.HOLD) {
            RelayState.Hold h = ctx.state().hold(u.from(), externalId, v.signer().text(), v.p(), body, until);
            if (h == RelayState.Hold.FULL) {
                // Past the held caps: it waits in the relay rather than being lost (Security CT-L1).
                return new Wait(relayId, "held_full");
            }
            if (h == RelayState.Hold.HELD) {
                counts.held.incrementAndGet();
            }
            ctx.state().tombstone("relay", relayId, now + MA_WAIT + SKEW);
            return new Ack(relayId);
        }
        Courier.Inbound in = inbound(v.payload(), m, body, externalId, origin, own);
        return new Store(relayId, in, until, body == null ? 0 : body.length);
    }

    private static Signed.Verified verifyOrNull(Signed.Unverified u, IdentityKey key) {
        try {
            return u.verify(key);
        } catch (EnvelopeException e) {
            return null;
        }
    }

    /** A verified member message as the sink takes it: a chat-like message, or an email-shaped one with its ids. */
    static Courier.Inbound inbound(Map<String, Object> p, Payloads.Message m, byte[] body, String externalId, Courier.Origin origin,
            boolean own) throws Payloads.Bad {
        String text = m.text();
        if (body != null) {
            text = utf8(body);
        }
        String from = (String) p.get("from");
        long at = Payloads.millis((String) p.get("at"));
        List<ParsedMessage.Address> to = new ArrayList<>();
        if (m.members() != null) {
            for (String a : m.members()) {
                to.add(new ParsedMessage.Address(null, a));
            }
        } else {
            to.add(new ParsedMessage.Address(null, (String) p.get("to")));
        }
        List<String> inReplyTo = m.inReplyTo() == null ? List.of() : List.of(m.inReplyTo());
        ParsedMessage parsed = new ParsedMessage(new ParsedMessage.Address(null, from), List.of(), to, List.of(), List.of(), m.subject(), at,
                m.rfcMessageId(), inReplyTo, m.references() == null ? List.of() : m.references(), null, false, null, null, text, false, null,
                List.of());
        Courier.Inbound in = new Courier.Inbound(RelayTransport.MA_ACCOUNT, "ma", externalId, origin, null, parsed, null, false, false, List.of(),
                at);
        return own ? in.asOutgoing() : in;
    }

    private static String utf8(byte[] body) throws Payloads.Bad {
        try {
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(body)).toString();
        } catch (CharacterCodingException e) {
            throw new Payloads.Bad("text");
        }
    }

    // ---- the mail door's

    private Step mail(String relayId, Map<String, Object> e, Courier.Origin origin)
            throws EnvelopeException, Payloads.Bad, IOException, InterruptedException, SQLException {
        Envelope.Sealed sealed = Envelope.Sealed.fromJson(e);
        // Signed.open refuses a mail envelope whose payload isn't the door's kind, and the reverse (Security CK-L1).
        Signed.Unverified u = Signed.open(Envelope.MAIL, ctx.recipient(), sealed.enc(), sealed.ct());
        if (ctx.domain() == null || !("mailer-daemon@" + ctx.domain()).equals(u.from())) {
            return refuse(relayId, "door_from");
        }
        List<IdentityKey> doorKeys = ctx.doorKeys();
        if (doorKeys.isEmpty()) {
            return new Wait(relayId, "door_key");
        }
        Signed.Verified v = null;
        for (IdentityKey k : doorKeys) {
            v = verifyOrNull(u, k);
            if (v != null) {
                break;
            }
        }
        if (v == null) {
            // The door may have a new key this desk hasn't read yet: read the addresses again and wait. Only the door writes a
            // mail envelope, so a bad signature is the platform's lag, never an attack: it's refused only after an hour of
            // misses across reads of the addresses (Security CT-L2).
            if (doorKeyMisses.size() > 10_000) {
                doorKeyMisses.clear();
            }
            long first = doorKeyMisses.computeIfAbsent(relayId, k -> ctx.now());
            if (ctx.now() - first < DOOR_KEY_GRACE) {
                ctx.doorKeyStale();
                return new Wait(relayId, "door_key");
            }
            doorKeyMisses.remove(relayId);
            return refuse(relayId, "bad_signature");
        }
        doorKeyMisses.remove(relayId);
        long now = ctx.now();
        long at = Payloads.millis(v.at());
        if (at < now - MAIL_WAIT - SKEW) {
            return refuse(relayId, "stale");
        }
        if (at > now + SKEW) {
            return refuse(relayId, "future");
        }
        long until = Math.max(at, now) + MAIL_WAIT + SKEW;
        Payloads.Mail mail = Payloads.readMail(v.payload());
        if (mail.note() != null) {
            String noteId = "note1:" + v.id();
            if (!ctx.state().seen("mail", noteId)) {
                note(mail.note());
                ctx.state().tombstone("mail", noteId, until);
            }
            ctx.state().tombstone("relay", relayId, until);
            return new Ack(relayId);
        }
        byte[] raw = mail.raw();
        if (raw == null) {
            raw = dropBody(e, mail.drop(), Drop.MAX_BODY);
            if (raw == null) {
                return new Wait(relayId, "drop_link");
            }
        }
        String externalId = ExternalIds.email(RelayTransport.DESK_ACCOUNT, null, raw);
        if (ctx.state().seen("email", externalId)) {
            counts.duplicates.incrementAndGet();
            ctx.state().tombstone("relay", relayId, until);
            return new Ack(relayId);
        }
        Map<String, Object> vd = mail.verdicts();
        Courier.Verdicts verdicts = new Courier.Verdicts(Boolean.TRUE.equals(vd.get("spam")), Boolean.TRUE.equals(vd.get("virus")),
                (String) vd.get("spf"), (String) vd.get("dkim"), (String) vd.get("dmarc"), (String) vd.get("dmarcDomain"), null);
        Courier.Inbound in = Courier.Inbound.email(RelayTransport.DESK_ACCOUNT, externalId, raw, origin).withVerdicts(verdicts);
        return new Store(relayId, in, until, raw.length);
    }

    private void note(Payloads.Note n) throws SQLException {
        counts.notes.incrementAndGet();
        if ("removed".equals(n.type())) {
            counts.removedByDoor.computeIfAbsent(n.reason(), k -> new AtomicLong()).incrementAndGet();
            return;
        }
        String status = switch (n.status()) {
            case "suppressed" -> "refused";
            default -> n.status();
        };
        ctx.state().deliveryNote(RelayTransport.DESK_ACCOUNT, n.rfcMessageId(), n.recipient(), status);
    }

    // ---- drops

    /**
     * Downloads and opens the drop a verified payload names, which must be one of the envelope's own drops at the size the
     * relay gave. Null when the relay gave no link today (its daily cap): the envelope waits.
     *
     * @throws EnvelopeException the drop doesn't match its reference (refused for good)
     * @throws IOException it didn't come down (tried again at the next drain)
     */
    private byte[] dropBody(Map<String, Object> e, Map<String, Object> ref, long max) throws EnvelopeException, IOException, InterruptedException {
        Object id = ref.get("id");
        Map<String, Object> drop = null;
        if (e.get("drops") instanceof List<?> drops) {
            for (Object o : drops) {
                if (o instanceof Map<?, ?> d && id != null && id.equals(d.get("dropId"))) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> dm = (Map<String, Object>) d;
                    drop = dm;
                }
            }
        }
        if (drop == null || !(drop.get("bytes") instanceof Number size)) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "the payload names a drop the envelope doesn't carry");
        }
        if (!(drop.get("url") instanceof String url)) {
            return null;
        }
        if (!(ref.get("len") instanceof Number len) || len.longValue() <= 0 || len.longValue() > max) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "the drop's body length is out of range");
        }
        // Exactly the body's size, no doubling and no copy (Security CT-M3); Drop.open checks the length it writes.
        Exact body = new Exact((int) len.longValue());
        try (InputStream in = ctx.api().download(url, size.longValue())) {
            Drop.open(ref, size.longValue(), in, body);
        }
        return body.bytes();
    }

    /** A body of a known length, written once into an array of exactly that size. */
    private static final class Exact extends java.io.OutputStream {
        private final byte[] buf;
        private int n;

        Exact(int length) {
            buf = new byte[length];
        }

        @Override
        public void write(int b) throws IOException {
            if (n >= buf.length) {
                throw new IOException("the drop's body is longer than it said");
            }
            buf[n++] = (byte) b;
        }

        @Override
        public void write(byte[] b, int off, int len) throws IOException {
            if (len > buf.length - n) {
                throw new IOException("the drop's body is longer than it said");
            }
            System.arraycopy(b, off, buf, n, len);
            n += len;
        }

        byte[] bytes() throws IOException {
            if (n != buf.length) {
                throw new IOException("the drop's body is shorter than it said");
            }
            return buf;
        }
    }

    /** No message text in logs. */
    @Override
    public String toString() {
        return "Drain";
    }

    static Logger log() {
        return log;
    }
}
