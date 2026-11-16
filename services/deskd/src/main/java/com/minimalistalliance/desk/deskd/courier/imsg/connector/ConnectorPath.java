package com.minimalistalliance.desk.deskd.courier.imsg.connector;

import com.minimalistalliance.desk.courier.envelope.BoxKey;
import com.minimalistalliance.desk.courier.envelope.BoxKeyPair;
import com.minimalistalliance.desk.courier.envelope.BodySource;
import com.minimalistalliance.desk.courier.envelope.DeviceEnvelope;
import com.minimalistalliance.desk.courier.envelope.Drop;
import com.minimalistalliance.desk.courier.envelope.Envelope;
import com.minimalistalliance.desk.courier.envelope.EnvelopeException;
import com.minimalistalliance.desk.courier.envelope.IdentityKey;
import com.minimalistalliance.desk.courier.envelope.IdentityKeyPair;
import com.minimalistalliance.desk.deskd.courier.imsg.ImsgMessage;
import com.minimalistalliance.desk.deskd.courier.imsg.ImsgPath;
import com.minimalistalliance.desk.deskd.courier.imsg.ImsgSend;
import com.minimalistalliance.desk.deskd.courier.imsg.ImsgSink;
import com.minimalistalliance.desk.deskd.courier.relay.DeviceInbox;
import com.minimalistalliance.desk.deskd.courier.relay.RelayApi;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.Ulid;
import com.minimalistalliance.desk.deskd.courier.vault.SignIn;
import com.minimalistalliance.desk.deskd.protocol.Json;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * MA Connector for Mac as a path of the {@code imsg} seam ({@code connector}; ma-desk {@code docs/sub-status/imsg-seam.md},
 * draft ADR "Courier's Mac connector"). The member's Mac is a paired device: it pushes its messages up as sealed pages through
 * the relay (the drain hands them here through {@link ConnectorLinks}), and this path seals what the member writes down to it.
 * Nothing here connects to the Mac or anywhere the member didn't name: the only peer is the platform's relay, and everything
 * through it is sealed to one side's box key and signed by the other's identity.
 *
 * <ul>
 *   <li><b>Pinned at pairing:</b> the device's keys are sealed in the account's sign-in (the vault), never in a row. An
 *       envelope that doesn't verify under them is refused.</li>
 *   <li><b>Its place:</b> {@code (epoch, through)} in {@code courier.db}'s cursors, committed with each page's messages by the
 *       sink. A page past the place in the same epoch means one was lost: it isn't stored, and the Mac is asked to go again
 *       from the place ({@code resume}).</li>
 *   <li><b>Sending:</b> one {@code send} per try, answered by the Mac's {@code sent} with the message's guid, recorded before
 *       any page that holds it; no answer in time is "may have gone", and the next try looks on the Mac first.</li>
 * </ul>
 */
public final class ConnectorPath implements ImsgPath {

    private static final Logger log = LoggerFactory.getLogger(ConnectorPath.class);

    public static final String PATH = "connector";
    static final String CURSOR = "mac:place";
    static final String HELLO = "mac:hello";
    static final long DAY = 24L * 3600 * 1000;
    /** How long the relay keeps a device's envelope (relay.md 0.4.3 upTtlDays), plus a day of skew. */
    static final long UP_WAIT = 90 * DAY;
    static final long SKEW = DAY;

    /** The seam's limits on files and the wait for the Mac's answer. */
    public record Settings(Duration answerWait, Duration poke, Duration resumeEvery, int backfillDays) {
        public static final Settings DEFAULT = new Settings(Duration.ofSeconds(60), Duration.ofSeconds(3), Duration.ofMinutes(10), 30);
    }

    /** The paired device, as pinned at pairing. */
    record Device(String deviceId, IdentityKey identity, BoxKey box, String fingerprint, long pairedAt) {}

    private record Pending(ImsgSend send, CompletableFuture<ImsgSend.Result> answer) {}

    private final Context ctx;
    private final ConnectorLinks links;
    private final Settings settings;
    private volatile Device device;
    private volatile String state = "connecting";
    private volatile String reason;
    private volatile Map<String, Object> mac = Map.of();
    private volatile long lastHeardAt;
    private volatile long lastResumeAt;
    private volatile String heldPage;
    private volatile boolean stopped;
    private final Map<String, Pending> pending = new ConcurrentHashMap<>();
    private final Ulid ulid = new Ulid();
    /** Recent sends' messages, by the queue's row: a late answer still records its guid. */
    private final Map<String, String> recent = new ConcurrentHashMap<>();

    ConnectorPath(Context ctx, ConnectorLinks links, Settings settings) {
        this.ctx = ctx;
        this.links = links;
        this.settings = settings;
    }

    String accountId() {
        return ctx.accountId();
    }

    Device device() {
        return device;
    }

    // ---- the seam

    @Override
    public void start() {
        try (SignIn s = ctx.signIn()) {
            device = pinned(s.server());
        } catch (IOException | RuntimeException e) {
            set("needs_you", "signed_out");
            return;
        }
        links.attach(this);
        if (!ctx.receiving()) {
            set("off", "switched_off");
        }
        Thread.ofVirtual().name("courier-mac-hello").start(this::helloIfNew);
    }

    @Override
    public void stop() {
        stopped = true;
        links.detach(this);
        for (Pending p : pending.values()) {
            p.answer().complete(new ImsgSend.Retry("stopping", true));
        }
    }

    /** The member removed the account: the Mac is told, and the platform forgets the device (relay.md 0.4.3 A.6). */
    @Override
    public void removed() {
        Device d = device;
        if (d != null) {
            try {
                sendDown("bye", Map.of());
            } catch (IOException | EnvelopeException | RuntimeException e) {
                // The delete below is what counts: the Mac's next request is refused, and it forgets the pairing.
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            links.forget(d.deviceId());
        }
        stop();
    }

    @Override
    public void poke() {
        links.drainSoon();
        Thread.ofVirtual().name("courier-mac-check").start(() -> {
            if (device != null && !links.stillPaired(device.deviceId())) {
                set("needs_you", "unpaired");
            }
        });
    }

    @Override
    public Map<String, Object> status() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("state", state);
        m.put("reason", reason);
        m.put("path", PATH);
        Device d = device;
        String check = d == null ? null : links.check(d.identity());
        m.put("device", d == null ? null : check == null ? Map.of("fingerprint", d.fingerprint(), "pairedAt", d.pairedAt())
                : Map.of("fingerprint", d.fingerprint(), "pairedAt", d.pairedAt(), "check", check));
        m.put("mac", mac);
        m.put("checkedAt", lastHeardAt == 0 ? null : lastHeardAt);
        return m;
    }

    @Override
    public ImsgSend.Result send(ImsgSend send) throws InterruptedException {
        Device d = device;
        if (d == null || "unpaired".equals(reason)) {
            return new ImsgSend.Failed("unpaired");
        }
        if (!ctx.sending()) {
            return new ImsgSend.Retry("switched_off", false);
        }
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("outboundId", send.outboundId());
        f.put("messageId", send.messageId());
        f.put("medium", send.medium());
        f.put("chatGuid", send.chatGuid());
        f.put("handles", send.handles());
        f.put("text", send.text());
        f.put("attempt", send.attempt());
        f.put("maybeSentBefore", send.maybeSentBefore());
        recent.put(send.outboundId(), send.messageId());
        if (recent.size() > 1000) {
            recent.clear();
        }
        String id;
        CompletableFuture<ImsgSend.Result> answer = new CompletableFuture<>();
        try {
            id = sendDown("send", f, answer, send);
        } catch (RelayApi.Refused r) {
            if ("device_unknown".equals(r.code())) {
                set("needs_you", "unpaired");
                return new ImsgSend.Failed("unpaired");
            }
            return new ImsgSend.Retry(r.code() == null ? "relay" : r.code(), r.status() >= 500 && r.code() == null);
        } catch (IOException e) {
            return new ImsgSend.Retry("relay", false);
        } catch (EnvelopeException e) {
            return new ImsgSend.Failed("too_long");
        }
        // The Mac answers through the relay: drain often while waiting (the gateway's push usually comes first).
        long until = System.nanoTime() + settings.answerWait().toNanos();
        try {
            while (true) {
                long left = until - System.nanoTime();
                if (left <= 0) {
                    return new ImsgSend.Retry("mac", true);
                }
                try {
                    return answer.get(Math.min(left, settings.poke().toNanos()), TimeUnit.NANOSECONDS);
                } catch (TimeoutException e) {
                    links.drainSoon();
                } catch (java.util.concurrent.ExecutionException e) {
                    return new ImsgSend.Retry("mac", true);
                }
            }
        } finally {
            pending.remove(id);
        }
    }

    // ---- envelopes from the Mac (the drain's thread)

    /** One envelope from this path's device. */
    DeviceInbox.Outcome take(String relayId, Map<String, Object> e) throws InterruptedException {
        Device d = device;
        if (d == null) {
            return DeviceInbox.Outcome.WAIT;
        }
        DeviceEnvelope.Payload p;
        Map<String, Object> fields;
        try {
            List<BoxKeyPair> keys = links.boxKeys();
            byte[] enc = ConnectorLinks.b64(e.get("enc"), Envelope.ENC_BYTES);
            byte[] ct = ConnectorLinks.b64(e.get("ct"), Envelope.MAX_CT);
            if (enc == null || enc.length != Envelope.ENC_BYTES || ct == null) {
                return links.refuse(relayId, "format");
            }
            byte[] pt = DeviceEnvelope.open(d.deviceId(), keys, enc, ct);
            p = DeviceEnvelope.unwrap(pt, d.identity(), d.deviceId(), DeviceEnvelope.UP);
            long at = DeviceEnvelope.millis(p.at());
            long now = ctx.clock().millis();
            if (at < now - UP_WAIT - SKEW || at > now + SKEW) {
                return links.refuse(relayId, "stale");
            }
            if (links.state().seen("device", p.id())) {
                return links.refuse(relayId, "duplicate");
            }
            fields = p.fields();
            if ("big".equals(p.type())) {
                fields = big(fields, e);
            }
        } catch (EnvelopeException x) {
            return links.refuse(relayId, x.reason());
        } catch (ImsgSink.TooLarge x) {
            // Past what a page may be (the Mac keeps pages to 4 MiB): refused, never held, so it can't fill the relay (MC-M2).
            return links.refuse(relayId, "too_large");
        } catch (IOException x) {
            return DeviceInbox.Outcome.WAIT;
        } catch (SQLException | RuntimeException x) {
            log.warn("courier mac: an envelope couldn't be read ({})", x.getClass().getSimpleName());
            return links.refuse(relayId, "payload");
        }
        lastHeardAt = ctx.clock().millis();
        String type = fields.get("type") instanceof String t ? t : "";
        if (!ctx.receiving() && ("page".equals(type) || "changes".equals(type))) {
            // iMessage is switched off here: nothing is kept, and the place doesn't move, so the first page once it's back on
            // is a gap and the Mac sends again from the place (Security MC-L2). Refused, not held: held pages would pile up.
            set("off", "switched_off");
            return links.refuse(relayId, "switched_off");
        }
        DeviceInbox.Outcome out;
        try {
            out = switch (type) {
                case "page" -> page(relayId, fields, e);
                case "changes" -> changes(fields);
                case "sent" -> sent(fields);
                case "status" -> status(fields);
                case "bye" -> {
                    set("needs_you", "unpaired");
                    yield DeviceInbox.Outcome.ACK;
                }
                default -> DeviceInbox.Outcome.ACK;
            };
        } catch (SQLException | RuntimeException x) {
            log.warn("courier mac: an envelope couldn't be kept ({})", x.getClass().getSimpleName());
            return DeviceInbox.Outcome.WAIT;
        }
        if (out == DeviceInbox.Outcome.ACK) {
            try {
                links.state().tombstone("device", p.id(), Math.max(DeviceEnvelope.millis(p.at()), ctx.clock().millis()) + UP_WAIT + SKEW);
            } catch (SQLException | EnvelopeException x) {
                // The sink's own keys still keep a second copy from being stored twice.
            }
            if (relayId.equals(heldPage)) {
                heldPage = null;
            }
        }
        return out;
    }

    /** A payload too big for an envelope came whole in a drop, its digest in the signed reference. */
    private Map<String, Object> big(Map<String, Object> outer, Map<String, Object> e)
            throws EnvelopeException, IOException, InterruptedException {
        if (!(outer.get("drop") instanceof Map<?, ?> refRaw)) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "no drop");
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> ref = (Map<String, Object>) refRaw;
        byte[] body = links.download(ref, e, 8L * 1024 * 1024);
        Map<String, Object> inner = DeviceEnvelope.parse(body);
        if ("big".equals(inner.get("type"))) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "a big payload inside a big one");
        }
        return inner;
    }

    private DeviceInbox.Outcome page(String relayId, Map<String, Object> f, Map<String, Object> e)
            throws InterruptedException, SQLException {
        String epoch = DevicePayloads.str(f.get("epoch"), 64);
        if (epoch == null || !(f.get("after") instanceof Number a) || !(f.get("through") instanceof Number t)) {
            return links.refuse(relayId, "payload");
        }
        long after = a.longValue();
        long through = t.longValue();
        // A page that waited this drain holds the ones after it: they'd look like a gap.
        if (heldPage != null && !heldPage.equals(relayId)) {
            return DeviceInbox.Outcome.WAIT;
        }
        String[] place = place();
        if (place != null && place[0].equals(epoch)) {
            long have = Long.parseLong(place[1]);
            if (through <= have) {
                return DeviceInbox.Outcome.ACK;
            }
            if (after > have) {
                resume(epoch, have);
                return links.refuse(relayId, "gap");
            }
        }
        List<DevicePayloads.Item> items = DevicePayloads.messages(f.get("messages"));
        List<ImsgMessage> page = new ArrayList<>(items.size());
        Map<String, Map<String, Object>> drops = new HashMap<>();
        for (DevicePayloads.Item it : items) {
            page.add(it.message());
            drops.putAll(it.drops());
        }
        String account = ctx.accountId();
        try {
            ctx.sink().store(account, page, n -> {
                if (n <= 0) {
                    return null;
                }
                long seq = n >= items.size() ? through : items.get(n - 1).seq();
                return new Courier.CursorUpdate(account, CURSOR, epoch + ":" + seq);
            }, (file, max) -> {
                Map<String, Object> ref = drops.get(file.guid());
                if (ref == null) {
                    throw new ImsgSink.TooLarge();
                }
                Object len = ref.get("len");
                if (len instanceof Number n && n.longValue() > max) {
                    throw new ImsgSink.TooLarge();
                }
                return links.download(ref, e, max);
            }, ctx.clock().millis() - DAY);
        } catch (ImsgSink.Hold h) {
            heldPage = relayId;
            return DeviceInbox.Outcome.WAIT;
        } catch (IOException x) {
            heldPage = relayId;
            return DeviceInbox.Outcome.WAIT;
        }
        if (!"needs_you".equals(state) && !"off".equals(state)) {
            set("live", null);
        }
        return DeviceInbox.Outcome.ACK;
    }

    private DeviceInbox.Outcome changes(Map<String, Object> f) throws InterruptedException, SQLException {
        List<ImsgMessage> page = new ArrayList<>();
        for (DevicePayloads.Item it : DevicePayloads.messages(f.get("messages"))) {
            if (it.message() != null) {
                page.add(it.message());
            }
        }
        try {
            ctx.sink().store(ctx.accountId(), page, n -> null, (file, max) -> {
                throw new ImsgSink.TooLarge();
            }, ctx.clock().millis() - DAY);
        } catch (ImsgSink.Hold | IOException x) {
            return DeviceInbox.Outcome.WAIT;
        }
        return DeviceInbox.Outcome.ACK;
    }

    private DeviceInbox.Outcome sent(Map<String, Object> f) throws SQLException {
        String outbound = DevicePayloads.str(f.get("outboundId"), 128);
        String replyTo = DevicePayloads.str(f.get("replyTo"), 26);
        String result = DevicePayloads.str(f.get("result"), 16);
        String guid = DevicePayloads.str(f.get("guid"), 200);
        String error = DevicePayloads.str(f.get("error"), 32);
        if (guid != null && !ImsgSink.GUID.matcher(guid).matches()) {
            guid = null;
        }
        Pending p = replyTo == null ? null : pending.get(replyTo);
        String messageId = p != null ? p.send().messageId() : outbound == null ? null : recent.get(outbound);
        if ("sent".equals(result) && guid != null && messageId != null) {
            // Before any page that holds it (the seam's recordSent): the echo is the same message.
            ctx.recordSent(guid, messageId);
        }
        if (p != null && (outbound == null || outbound.equals(p.send().outboundId()))) {
            ImsgSend.Result r = switch (result == null ? "" : result) {
                case "sent" -> new ImsgSend.Sent(guid);
                case "failed" -> new ImsgSend.Failed(error == null ? "refused" : error);
                default -> new ImsgSend.Retry(error == null ? "mac" : error, Boolean.TRUE.equals(f.get("unclear")));
            };
            if ("permission".equals(error)) {
                set("needs_you", "automation");
            }
            p.answer().complete(r);
        }
        return DeviceInbox.Outcome.ACK;
    }

    private DeviceInbox.Outcome status(Map<String, Object> f) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("app", DevicePayloads.str(f.get("app"), 32));
        m.put("os", DevicePayloads.str(f.get("os"), 16));
        m.put("fullDisk", Boolean.TRUE.equals(f.get("fullDisk")));
        m.put("automation", f.get("automation") instanceof Boolean b ? b : null);
        m.put("paused", Boolean.TRUE.equals(f.get("paused")));
        mac = m;
        if (!Boolean.TRUE.equals(f.get("fullDisk"))) {
            set("needs_you", "full_disk");
        } else if (Boolean.FALSE.equals(f.get("automation"))) {
            set("needs_you", "automation");
        } else if (Boolean.TRUE.equals(f.get("paused"))) {
            set("waiting", "paused");
        } else if (!"off".equals(state)) {
            set("live", null);
        } else {
            ctx.changed();
        }
        return DeviceInbox.Outcome.ACK;
    }

    // ---- down to the Mac

    private void helloIfNew() {
        long backoff = 2_000;
        while (!stopped) {
            try {
                if (ctx.store().cursor(ctx.accountId(), HELLO) != null) {
                    if ("connecting".equals(state)) {
                        set(lastHeardAt == 0 ? "waiting" : "live", lastHeardAt == 0 ? "mac" : null);
                    }
                    return;
                }
                Map<String, Object> f = new LinkedHashMap<>();
                f.put("account", ctx.accountId());
                f.put("backfillDays", settings.backfillDays());
                sendDown("hello", f);
                ctx.store().accept(List.of(), new Courier.CursorUpdate(ctx.accountId(), HELLO, Long.toString(ctx.clock().millis())));
                set("waiting", "mac");
                return;
            } catch (RelayApi.Refused r) {
                if ("device_unknown".equals(r.code())) {
                    set("needs_you", "unpaired");
                    return;
                }
            } catch (InterruptedException e) {
                return;
            } catch (IOException | SQLException | EnvelopeException | RuntimeException e) {
                // Tried again below.
            }
            try {
                Thread.sleep(backoff);
            } catch (InterruptedException e) {
                return;
            }
            backoff = Math.min(backoff * 2, 600_000);
        }
    }

    private void resume(String epoch, long after) {
        long now = ctx.clock().millis();
        if (now - lastResumeAt < settings.resumeEvery().toMillis()) {
            return;
        }
        lastResumeAt = now;
        Thread.ofVirtual().name("courier-mac-resume").start(() -> {
            try {
                sendDown("resume", Map.of("epoch", epoch, "after", after));
            } catch (Exception e) {
                lastResumeAt = 0;
            }
        });
    }

    private String sendDown(String type, Map<String, Object> fields) throws IOException, InterruptedException, EnvelopeException {
        return sendDown(type, fields, null, null);
    }

    /** Signs, seals and sends one payload down; a send's answer is waited for under the payload's own id. */
    private String sendDown(String type, Map<String, Object> fields, CompletableFuture<ImsgSend.Result> answer, ImsgSend send)
            throws IOException, InterruptedException, EnvelopeException {
        Device d = device;
        IdentityKeyPair me = links.identity();
        if (d == null || me == null) {
            throw new IOException("keys");
        }
        String id = ulid.next(ctx.clock().millis());
        byte[] pt = DeviceEnvelope.wrap(me, d.deviceId(), DeviceEnvelope.DOWN, type, fields, id, millisRfc(ctx.clock().millis()));
        List<String> drops = new ArrayList<>();
        if (pt.length >= DeviceEnvelope.MAX_PLAINTEXT_BUCKET) {
            Map<String, Object> inner = new LinkedHashMap<>(fields);
            inner.put("type", type);
            byte[] body = Json.bytes(inner);
            Drop.Sealer sealer = Drop.sealer(BodySource.of(body));
            Map<String, Object> r = links.api().reserveDrop(d.deviceId(), sealer.bucket());
            ByteArrayOutputStream out = new ByteArrayOutputStream((int) sealer.bucket());
            sealer.write(out);
            @SuppressWarnings("unchecked")
            Map<String, String> headers = r.get("headers") instanceof Map<?, ?> h ? (Map<String, String>) h : Map.of();
            links.api().upload((String) r.get("url"), headers, out.toByteArray());
            String dropId = (String) r.get("dropId");
            drops.add(dropId);
            pt = DeviceEnvelope.wrap(me, d.deviceId(), DeviceEnvelope.DOWN, "big", Map.of("drop", sealer.reference(dropId)), id,
                    millisRfc(ctx.clock().millis()));
        }
        Envelope.Sealed sealed = DeviceEnvelope.seal(d.deviceId(), d.box(), pt);
        Map<String, Object> env = new LinkedHashMap<>(sealed.toJson());
        if (!drops.isEmpty()) {
            env.put("drops", drops);
        }
        if (answer != null) {
            pending.put(id, new Pending(send, answer));
        }
        try {
            links.api().send(env, "dv" + id);
        } catch (IOException | RuntimeException x) {
            pending.remove(id);
            throw x;
        }
        return id;
    }

    static String millisRfc(long ms) {
        return java.time.format.DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(java.time.ZoneOffset.UTC)
                .format(Instant.ofEpochMilli(ms));
    }

    // ---- helpers

    private String[] place() throws SQLException {
        String v = ctx.store().cursor(ctx.accountId(), CURSOR);
        if (v == null) {
            return null;
        }
        int i = v.lastIndexOf(':');
        if (i <= 0) {
            return null;
        }
        try {
            Long.parseLong(v.substring(i + 1));
        } catch (NumberFormatException e) {
            return null;
        }
        return new String[] {v.substring(0, i), v.substring(i + 1)};
    }

    void set(String s, String r) {
        boolean changed = !s.equals(state) || !java.util.Objects.equals(r, reason);
        state = s;
        reason = r;
        if (changed) {
            ctx.changed();
        }
    }

    /** The device pinned in the sealed sign-in's server settings. */
    static Device pinned(String server) throws IOException {
        try {
            Map<String, Object> srv = Json.parseObject(server.getBytes(StandardCharsets.UTF_8));
            if (!PATH.equals(srv.get("path"))) {
                throw new IOException("not the connector's");
            }
            String id = (String) srv.get("deviceId");
            if (id == null || !DeviceEnvelope.DEVICE_ID.matcher(id).matches()) {
                throw new IOException("no device");
            }
            IdentityKey identity = IdentityKey.parse(srv.get("identityKey"));
            BoxKey box = BoxKey.parse(srv.get("boxKey"));
            long paired = srv.get("pairedAt") instanceof Number n ? n.longValue() : 0;
            return new Device(id, identity, box, String.valueOf(srv.get("fingerprint")), paired);
        } catch (EnvelopeException | ClassCastException | NullPointerException | com.minimalistalliance.desk.deskd.protocol.JsonFormatException e) {
            throw new IOException("sealed sign-in unreadable");
        }
    }

    /** No text in logs. */
    @Override
    public String toString() {
        Device d = device;
        return "ConnectorPath[" + (d == null ? "unpaired" : d.deviceId()) + ", " + state + "]";
    }
}
