package com.minimalistalliance.desk.deskd.agent;

import com.minimalistalliance.desk.deskd.platform.DeskMaiaClient;
import com.minimalistalliance.desk.deskd.protocol.Json;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Semaphore;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Desk Maia's model, through deskd (API.md §23, "Her model"; ma-platform {@code docs/contracts/desk-maia.md}): desk-agent
 * can't reach the Platform (nftables, ADR 0010 and 0019), so Maia's every model call is a {@code tcall} with {@code tool:
 * "maia_model"} on the agent socket, which deskd relays to Desk Maia's service on Minimalist Alliance's AI account as the desk
 * role. It never reaches {@code ToolHost}.
 *
 * <p><b>What deskd checks:</b> by its own facts, this isn't a Guild Desk, the owner is an adult by deskd's band, the desk isn't
 * on the free tier by deskd's tier record, and the service is configured; the {@code args} are an object of at most 3 MiB with
 * only the contract's request fields; at most {@link #AT_ONCE} calls at once. The {@code agentId} is desk-agent's own word
 * (deskd can't tell desk-agent's agents apart), so {@code not_maia} only catches a mistake: what keeps the company path to
 * Desk Maia is desk-agent's {@code LlmGateway} and {@code KeyRing} (Security's DMC-I2). The Platform then checks the member
 * itself (its own list, tier and band) and meters the call, so the money's gate is there.
 *
 * <p>Each call runs on its own virtual thread: the socket's reader never waits. Nothing of the call or its answer is logged.
 */
public final class MaiaModel {

    private static final Logger log = LoggerFactory.getLogger(MaiaModel.class);

    /** The tool's name in a {@code tcall}. */
    public static final String TOOL = "maia_model";
    /** Desk Maia's agent id: the only one this answers. */
    static final String MAIA = "maia";
    /** Relayed calls at once; more are refused {@code rate_limited}. */
    static final int AT_ONCE = 4;
    /** The whole body at most this (the contract's {@code 413 too_large} line), checked before it goes. */
    static final int MAX_ARGS_BYTES = 3 << 20;
    /**
     * The contract's request fields (0.4.6: {@code note}, the desk's lines that change on every call, which the service
     * sends after the thread, outside every cached prefix; 0.4.8: {@code units}, {@code "credits"}, so the answer carries
     * its cost in credits and no dollars); {@code v} is deskd's own. Their values are the service's to check.
     */
    static final Set<String> FIELDS = Set.of("task", "callId", "context", "messages", "tools", "maxOutputTokens",
            "units", "note");
    private static final Set<String> WINDOWS = Set.of("day", "week", "month", "memberTrial");
    private static final Pattern WORD = Pattern.compile("[a-z_]{1,40}");
    private static final Pattern WHEN = Pattern.compile("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?Z");

    /** Where an answer goes: the agent socket's writer. Must not block. */
    @FunctionalInterface
    interface Wire {
        boolean send(Map<String, Object> message);
    }

    private final DeskMaiaClient client;
    private final BooleanSupplier guildDesk;
    private final BooleanSupplier adult;
    private final BooleanSupplier free;
    private final Semaphore slots = new Semaphore(AT_ONCE);

    /**
     * @param guildDesk deskd's own: a Guild Desk has no single member
     * @param adult the owner's band, as deskd holds it, is adult
     * @param free the desk's tier record says free
     */
    public MaiaModel(DeskMaiaClient client, BooleanSupplier guildDesk, BooleanSupplier adult, BooleanSupplier free) {
        this.client = client;
        this.guildDesk = guildDesk;
        this.adult = adult;
        this.free = free;
    }

    /** Whether the hello offers her model: the service is configured here now. */
    public boolean offered() {
        return client.configured();
    }

    /**
     * One {@code maia_model} {@code tcall}, the whole frame: answered on a thread of its own, or refused at once. Never
     * blocks.
     */
    void onCall(Map<String, Object> message, Wire wire) {
        Object id = message.get("id");
        Map<String, Object> refused = refusal(message);
        if (refused != null) {
            wire.send(terr(id, refused));
            return;
        }
        if (!slots.tryAcquire()) {
            wire.send(terr(id, details("rate_limited", "reason", "maia_model")));
            return;
        }
        Thread.ofVirtual().name("maia-model").start(() -> {
            try {
                wire.send(relay(id, message));
            } catch (RuntimeException e) {
                log.error("desk maia: a call failed ({})", e.getClass().getSimpleName());
                wire.send(terr(id, details("unavailable", "reason", "internal")));
            } finally {
                slots.release();
            }
        });
    }

    /** deskd's own refusals, in order, before anything goes out; null when the call may go. */
    private Map<String, Object> refusal(Map<String, Object> message) {
        if (!MAIA.equals(message.get("agentId"))) {
            return details("forbidden", "reason", "not_maia");
        }
        if (guildDesk.getAsBoolean()) {
            return details("forbidden", "reason", "guild_desk");
        }
        if (!adult.getAsBoolean()) {
            return details("forbidden", "reason", "teen");
        }
        if (free.getAsBoolean()) {
            return details("forbidden", "reason", "free");
        }
        if (!client.configured()) {
            return details("unavailable", "reason", "no_service");
        }
        if (!(message.get("args") instanceof Map<?, ?> args)) {
            return details("bad_request", "reason", "args");
        }
        for (Object key : args.keySet()) {
            if (!(key instanceof String field) || !FIELDS.contains(field)) {
                return details("bad_request", "reason", "field");
            }
        }
        return null;
    }

    private Map<String, Object> relay(Object id, Map<String, Object> message) throws RuntimeException {
        @SuppressWarnings("unchecked")
        Map<String, Object> args = (Map<String, Object>) message.get("args");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("v", 1);
        body.putAll(args);
        byte[] bytes = Json.bytes(body);
        if (bytes.length > MAX_ARGS_BYTES) {
            return terr(id, details("too_large", "reason", "body"));
        }
        DeskMaiaClient.Answer answer;
        try {
            answer = client.call(bytes);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return terr(id, details("unavailable", "reason", "stopped"));
        }
        if (answer.ok()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("t", "tres");
            m.put("id", id);
            m.put("r", answer.body());
            return m;
        }
        return terr(id, platformDetails(answer));
    }

    /**
     * The Platform's refusal as desk-agent hears it: its code, and of its details only {@code reason}, {@code resetsAt},
     * {@code window} and {@code retryAfterSec}, each as given when it has its shape.
     */
    static Map<String, Object> platformDetails(DeskMaiaClient.Answer answer) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("code", answer.code() != null && answer.code().matches("[a-z_]{1,32}") ? answer.code() : "unavailable");
        Map<String, Object> d = new LinkedHashMap<>();
        Map<String, Object> given = answer.details();
        if (given.get("reason") instanceof String r && WORD.matcher(r).matches()) {
            d.put("reason", r);
        }
        if (given.get("resetsAt") instanceof String at && WHEN.matcher(at).matches()) {
            d.put("resetsAt", at);
        }
        if (given.get("window") instanceof String w && WINDOWS.contains(w)) {
            d.put("window", w);
        }
        if (given.get("retryAfterSec") instanceof Number n && n.doubleValue() >= 0 && n.doubleValue() <= 86_400) {
            d.put("retryAfterSec", (long) Math.ceil(n.doubleValue()));
        }
        out.put("details", d);
        return out;
    }

    private static Map<String, Object> details(String code, String key, String value) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("code", code);
        out.put("details", Map.of(key, value));
        return out;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> terr(Object id, Map<String, Object> refusal) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "terr");
        m.put("id", id instanceof Number ? id : -1);
        m.put("code", refusal.get("code"));
        m.put("details", (Map<String, Object>) refusal.get("details"));
        return m;
    }
}
