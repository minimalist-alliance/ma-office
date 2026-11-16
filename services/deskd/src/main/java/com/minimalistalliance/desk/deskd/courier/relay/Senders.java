package com.minimalistalliance.desk.deskd.courier.relay;

import com.minimalistalliance.desk.courier.envelope.BodySource;
import com.minimalistalliance.desk.courier.envelope.Drop;
import com.minimalistalliance.desk.courier.envelope.Envelope;
import com.minimalistalliance.desk.courier.envelope.EnvelopeException;
import com.minimalistalliance.desk.courier.envelope.IdentityKeyPair;
import com.minimalistalliance.desk.courier.envelope.Padding;
import com.minimalistalliance.desk.courier.envelope.PublishedKeys;
import com.minimalistalliance.desk.courier.envelope.Signed;
import com.minimalistalliance.desk.deskd.courier.linked.MimeWriter;
import com.minimalistalliance.desk.deskd.courier.store.Outbox;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The relay's sending halves in the outbound queue (draft ADR "Courier's transports" §4 and §5):
 *
 * <ul>
 *   <li><b>{@code ma}</b>: one envelope per recipient, sealed to the keys pinned for that address, signed by this desk, its
 *       text in the drop when it won't fit. A recipient whose pinned key changed waits ({@code key_changed}) until the
 *       member checks the new safety number.
 *   <li><b>{@code email} from this desk's own address</b>: members' addresses (the Courier domain) get it sealed, as
 *       {@code ma}, never through {@code courier-send} (the plan §2.10); everyone else gets it through {@link CourierSend}.
 * </ul>
 *
 * <p><b>No double sends.</b> The payload's {@code id} is the message's own id, the same on every try, so a receiving desk
 * stores a resend once; each envelope's {@code Idempotency-Key} is the queue row's and the recipient's, so the relay keeps
 * one within a day, and its {@code idempotency_key_reused} (an earlier try got through) counts as sent. A submission to
 * {@code courier-send} carries the queue row's id as its key, and an answer lost on the way is a retry marked unclear.
 */
final class Senders {

    private static final Logger log = LoggerFactory.getLogger(Senders.class);

    /** What the senders need of the transport around them. */
    interface Context {
        RelayApi api();

        Pins pins();

        CourierSend courierSend();

        IdentityKeyPair identity();

        /** The desk's open address, or null. */
        String address();

        String domain();

        boolean maSending();

        boolean doorSending();

        long now();
    }

    private final Context ctx;

    Senders(Context ctx) {
        this.ctx = ctx;
    }

    /** One recipient's outcome: sent, refused for good (with a code), or to try again (with a code, perhaps unclear). */
    private record One(String status, String code, boolean unclear) {
        static final One SENT = new One("sent", null, false);

        static One refused(String code) {
            return new One("refused", code, false);
        }

        static One retry(String code, boolean unclear) {
            return new One(null, code, unclear);
        }

        boolean retry() {
            return status == null;
        }
    }

    // ---- ma

    Outbox.Result sendMa(Outbox.Outgoing item) throws InterruptedException {
        if (!ctx.maSending()) {
            return new Outbox.Retry("switched_off");
        }
        String from = ctx.address();
        IdentityKeyPair identity = ctx.identity();
        if (from == null) {
            return new Outbox.Retry("no_address");
        }
        if (identity == null) {
            return new Outbox.Retry("keys");
        }
        List<String> members = new ArrayList<>();
        for (Outbox.Recipient r : item.to()) {
            String a = Invite.canonical(r.value());
            if (a != null && !members.contains(a)) {
                members.add(a);
            }
        }
        Map<String, One> outcomes = new LinkedHashMap<>();
        for (Outbox.Recipient r : item.to()) {
            String to = Invite.canonical(r.value());
            outcomes.put(r.endpointId(), to == null ? One.refused("address")
                    : sealAndSend(item, identity, from, to, new Payloads.Message(item.text(), item.subject(), members, null, null, null, null)));
        }
        return result(outcomes);
    }

    // ---- email from this desk's address

    Outbox.Result sendEmail(Outbox.Outgoing item) throws InterruptedException {
        if (!ctx.doorSending()) {
            return new Outbox.Retry("switched_off");
        }
        String from = ctx.address();
        String domain = ctx.domain();
        if (from == null || domain == null) {
            return new Outbox.Retry("no_address");
        }
        List<Outbox.Recipient> members = new ArrayList<>();
        List<Outbox.Recipient> outside = new ArrayList<>();
        for (Outbox.Recipient r : item.to()) {
            String a = Invite.canonical(r.value());
            if (a != null && domain.equals(a.substring(a.indexOf('@') + 1))) {
                members.add(r);
            } else {
                outside.add(r);
            }
        }
        Map<String, One> outcomes = new LinkedHashMap<>();
        if (!members.isEmpty()) {
            IdentityKeyPair identity = ctx.identity();
            List<String> all = new ArrayList<>();
            for (Outbox.Recipient r : item.to()) {
                String a = Invite.canonical(r.value());
                all.add(a != null ? a : r.value());
            }
            List<String> group = new ArrayList<>();
            for (String a : all) {
                if (Invite.canonical(a) != null && domain.equals(a.substring(a.indexOf('@') + 1)) && !group.contains(a)) {
                    group.add(a);
                }
            }
            for (Outbox.Recipient r : members) {
                String to = Invite.canonical(r.value());
                if (identity == null) {
                    outcomes.put(r.endpointId(), One.retry("keys", false));
                    continue;
                }
                // An email between two members' addresses goes sealed, as a member's message that keeps its subject and its
                // place in the email conversation (the plan §2.10: never through courier-send).
                outcomes.put(r.endpointId(), sealAndSend(item, identity, from, to, new Payloads.Message(item.text(), item.subject(), group,
                        item.rfcMessageId(), item.inReplyTo(), item.references(), null)));
            }
        }
        if (!outside.isEmpty()) {
            outcomes.putAll(submit(item, from, outside));
        }
        return result(outcomes);
    }

    private Map<String, One> submit(Outbox.Outgoing item, String from, List<Outbox.Recipient> outside) throws InterruptedException {
        Map<String, One> out = new LinkedHashMap<>();
        CourierSend send = ctx.courierSend();
        List<String> to = new ArrayList<>();
        Map<String, String> endpointOf = new LinkedHashMap<>();
        for (Outbox.Recipient r : outside) {
            String a = MimeWriter.address(r.value());
            if (a == null) {
                out.put(r.endpointId(), One.refused("address"));
            } else {
                to.add(a);
                endpointOf.put(a, r.endpointId());
            }
        }
        if (to.isEmpty()) {
            return out;
        }
        if (!send.available()) {
            for (String a : to) {
                out.put(endpointOf.get(a), One.retry("no_provider", false));
            }
            return out;
        }
        byte[] raw = MimeWriter.write(from, item, Instant.ofEpochMilli(ctx.now()));
        try {
            CourierSend.Accepted a = send.submit(new CourierSend.Submission(from, to, item.rfcMessageId(), raw, "s" + item.outboundId()));
            for (String addr : a.accepted()) {
                out.put(endpointOf.get(addr), One.SENT);
            }
            a.refused().forEach((addr, code) -> out.put(endpointOf.get(addr), One.refused(code)));
        } catch (RelayApi.Refused r) {
            String code = r.code() == null ? "http_" + r.status() : r.code();
            if ("idempotency_key_reused".equals(code)) {
                // An earlier try of this send was taken (this one wrote its Date again): sent.
                for (String addr : to) {
                    out.put(endpointOf.get(addr), One.SENT);
                }
                return out;
            }
            if (r.code() == null && r.status() >= 500) {
                // A gateway's own error (a timeout behind it): it may have gone. The next try carries the same key.
                for (String addr : to) {
                    out.put(endpointOf.get(addr), One.retry("unreachable", true));
                }
                return out;
            }
            boolean lasting = r.status() == 400 || r.status() == 413 || "from_mismatch".equals(code) || "courier_teen".equals(code)
                    || "desk_kind".equals(code);
            for (String addr : to) {
                out.put(endpointOf.get(addr), lasting ? One.refused(code) : One.retry(code, false));
            }
        } catch (IOException e) {
            // No answer: it may have gone. The next try carries the same key, and the platform keeps one.
            for (String addr : to) {
                out.put(endpointOf.get(addr), One.retry("unreachable", true));
            }
        }
        return out;
    }

    // ---- sealing one envelope

    private One sealAndSend(Outbox.Outgoing item, IdentityKeyPair identity, String from, String to, Payloads.Message message)
            throws InterruptedException {
        if (to.equals(from)) {
            return One.SENT;
        }
        Pins.SealTo keys;
        try {
            keys = ctx.pins().forSending(to);
        } catch (SQLException e) {
            return One.retry("storage", false);
        }
        if (keys.keys() == null) {
            return keys.lasting() ? One.refused(keys.problem()) : One.retry(keys.problem(), false);
        }
        try {
            Map<String, Object> envelope = envelope(item, identity, from, to, keys.keys(), message);
            ctx.api().send(envelope, idempotencyKey(item.outboundId(), to));
            return One.SENT;
        } catch (RelayApi.Refused r) {
            if (r.code() == null && r.status() >= 500) {
                return One.retry("unreachable", true);
            }
            String code = r.code() == null ? "http_" + r.status() : r.code();
            return switch (code) {
                // An earlier try with this key got through: the same message, sent.
                case "idempotency_key_reused" -> One.SENT;
                case "address_unknown", "address_closed", "courier_teen", "desk_kind", "unpadded", "too_large", "kind_not_allowed",
                        "invalid_request" -> One.refused(code);
                default -> One.retry(code, false);
            };
        } catch (EnvelopeException e) {
            return One.retry("recipient_key", false);
        } catch (IOException e) {
            return One.retry("unreachable", true);
        }
    }

    /** The envelope for one recipient: inline, or with the text in a drop when the signed payload won't fit 64 KiB. */
    private Map<String, Object> envelope(Outbox.Outgoing item, IdentityKeyPair identity, String from, String to, PublishedKeys keys,
            Payloads.Message message) throws EnvelopeException, IOException, InterruptedException {
        long now = ctx.now();
        String text = message.text() == null ? "" : message.text();
        if (text.length() > Payloads.MAX_TEXT) {
            text = text.substring(0, Payloads.MAX_TEXT);
        }
        Payloads.Message inline = new Payloads.Message(text, message.subject(), message.members(), message.rfcMessageId(),
                message.inReplyTo(), message.references(), null);
        Map<String, Object> payload = Payloads.message(item.messageId(), from, to, now, inline);
        byte[] plaintext = Signed.wrap(identity, payload);
        List<String> drops = new ArrayList<>();
        if (text.length() > Payloads.INLINE_TEXT || Padding.envelopeBucket(plaintext.length) < 0) {
            java.util.Arrays.fill(plaintext, (byte) 0);
            byte[] body = text.getBytes(StandardCharsets.UTF_8);
            Drop.Sealer sealer = Drop.sealer(BodySource.of(body));
            Map<String, Object> reserved = ctx.api().reserveDrop(to, sealer.bucket());
            if (!(reserved.get("dropId") instanceof String dropId) || !(reserved.get("url") instanceof String url)) {
                throw new IOException("the relay's drop reservation has no id or link");
            }
            ByteArrayOutputStream bytes = new ByteArrayOutputStream((int) sealer.bucket());
            sealer.write(bytes);
            java.util.Arrays.fill(body, (byte) 0);
            Map<String, String> headers = new LinkedHashMap<>();
            if (reserved.get("headers") instanceof Map<?, ?> h) {
                h.forEach((k, v) -> {
                    if (k instanceof String ks && v instanceof String vs) {
                        headers.put(ks, vs);
                    }
                });
            }
            ctx.api().upload(url, headers, bytes.toByteArray());
            Payloads.Message dropped = new Payloads.Message(null, message.subject(), message.members(), message.rfcMessageId(),
                    message.inReplyTo(), message.references(), sealer.reference(dropId));
            plaintext = Signed.wrap(identity, Payloads.message(item.messageId(), from, to, now, dropped));
            drops.add(dropId);
        }
        Envelope.Sealed sealed;
        try {
            sealed = Envelope.seal(Envelope.MA, to, keys.boxKey(), plaintext);
        } finally {
            java.util.Arrays.fill(plaintext, (byte) 0);
        }
        Map<String, Object> env = new LinkedHashMap<>(sealed.toJson());
        if (!drops.isEmpty()) {
            env.put("drops", drops);
        }
        return env;
    }

    /** The relay's {@code Idempotency-Key} for one recipient of one queue row: {@code o<row>-<16 hex of the address>}. */
    static String idempotencyKey(String outboundId, String to) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(to.getBytes(StandardCharsets.UTF_8));
            return "o" + outboundId + "-" + HexFormat.of().formatHex(d, 0, 8);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** All recipients sent: sent. Any to try again: retry (unclear if any try may have gone). Else refused for good. */
    private static Outbox.Result result(Map<String, One> outcomes) {
        String retry = null;
        boolean unclear = false;
        boolean anySent = false;
        String refused = null;
        Map<String, String> statuses = new LinkedHashMap<>();
        for (Map.Entry<String, One> e : outcomes.entrySet()) {
            One o = e.getValue();
            if (o.retry()) {
                retry = retry == null ? o.code() : retry;
                unclear |= o.unclear();
            } else {
                statuses.put(e.getKey(), o.status());
                anySent |= "sent".equals(o.status());
                if ("refused".equals(o.status()) && refused == null) {
                    refused = o.code();
                }
            }
        }
        if (retry != null) {
            return new Outbox.Retry(retry.toLowerCase(Locale.ROOT), unclear);
        }
        if (!anySent) {
            return new Outbox.Failed(refused == null ? "refused" : refused);
        }
        return new Outbox.Sent(statuses);
    }

    @Override
    public String toString() {
        return "Senders";
    }

    static Logger log() {
        return log;
    }
}
