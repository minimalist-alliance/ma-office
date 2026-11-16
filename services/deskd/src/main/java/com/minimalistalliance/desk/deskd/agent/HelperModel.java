package com.minimalistalliance.desk.deskd.agent;

import com.minimalistalliance.desk.deskd.platform.DeskMaiaClient;
import com.minimalistalliance.desk.deskd.protocol.Json;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Semaphore;
import java.util.function.BooleanSupplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Helpers on Minimalist Alliance's provider, through deskd (API.md §24, "Helpers on MA's credits"; ma-platform {@code
 * docs/contracts/desk-helpers.md}, ADR 0142). The owner, Nov 15: MA acts as the AI provider for members' desk agents too, so the
 * welcome never stalls on "bring your own key". desk-agent can't reach the Platform, so a helper whose provider is MA makes each
 * model call as a {@code tcall} with {@code tool: "helpers_model"}, and reads the member's credits with {@code tool:
 * "helpers_credits"}; deskd relays both, signed as the desk role, to the same service Desk Maia's calls go to (the same URL,
 * audience and proof, other routes). Never to {@code ToolHost}.
 *
 * <p><b>What deskd checks:</b> by its own facts, this isn't a Guild Desk, the owner is an adult by deskd's band, and the service
 * is configured; the caller isn't Desk Maia (her calls are hers, on her allowance: {@link MaiaModel}); the {@code args} are an
 * object of at most 3 MiB with only the contract's fields; at most {@link #AT_ONCE} calls at once. The {@code agentId} is
 * desk-agent's own word, so the Platform's checks (the member's band, the desk's kind and hosting, the credits) are the gate
 * on the money. Free members' desks may call: their helpers get starting credits too.
 *
 * <p>Each call runs on its own virtual thread. Nothing of the call or its answer is logged.
 */
public final class HelperModel {

    private static final Logger log = LoggerFactory.getLogger(HelperModel.class);

    /** A helper's model call. */
    public static final String TOOL = "helpers_model";
    /** The member's credits (and their starting grant, the first time a desk asks). */
    public static final String CREDITS = "helpers_credits";
    static final int AT_ONCE = 4;
    static final int MAX_ARGS_BYTES = 3 << 20;
    /** The contract's request fields for a call; {@code v} is deskd's own. */
    static final Set<String> CALL_FIELDS = Set.of("task", "callId", "context", "messages", "tools", "maxOutputTokens");
    /** And for the credits read: a fresh id, so each read's body (and its one-use proof) is its own. */
    static final Set<String> CREDITS_FIELDS = Set.of("callId");

    private final DeskMaiaClient client;
    private final BooleanSupplier guildDesk;
    private final BooleanSupplier adult;
    private final Semaphore slots = new Semaphore(AT_ONCE);

    public HelperModel(DeskMaiaClient client, BooleanSupplier guildDesk, BooleanSupplier adult) {
        this.client = client;
        this.guildDesk = guildDesk;
        this.adult = adult;
    }

    /** Whether the hello offers it: the service is configured here now. */
    public boolean offered() {
        return client.configured();
    }

    /** Whether a {@code tcall}'s tool is one of these. */
    public static boolean handles(Object tool) {
        return TOOL.equals(tool) || CREDITS.equals(tool);
    }

    /** One {@code helpers_model} or {@code helpers_credits} {@code tcall}: answered on its own thread, or refused at once. */
    void onCall(Map<String, Object> message, MaiaModel.Wire wire) {
        Object id = message.get("id");
        Map<String, Object> refused = refusal(message);
        if (refused != null) {
            wire.send(terr(id, refused));
            return;
        }
        if (!slots.tryAcquire()) {
            wire.send(terr(id, details("rate_limited", "reason", "helpers_model")));
            return;
        }
        Thread.ofVirtual().name("helpers-model").start(() -> {
            try {
                wire.send(relay(id, message));
            } catch (RuntimeException e) {
                log.error("helpers: a call failed ({})", e.getClass().getSimpleName());
                wire.send(terr(id, details("unavailable", "reason", "internal")));
            } finally {
                slots.release();
            }
        });
    }

    private Map<String, Object> refusal(Map<String, Object> message) {
        if (MaiaModel.MAIA.equals(message.get("agentId"))) {
            // Desk Maia runs on her own allowance, never on the member's helpers' credits.
            return details("forbidden", "reason", "maia");
        }
        if (!(message.get("agentId") instanceof String agent) || agent.isBlank()) {
            return details("bad_request", "reason", "agentId");
        }
        if (guildDesk.getAsBoolean()) {
            return details("forbidden", "reason", "guild_desk");
        }
        if (!adult.getAsBoolean()) {
            return details("forbidden", "reason", "teen");
        }
        if (!client.configured()) {
            return details("unavailable", "reason", "no_service");
        }
        Object raw = message.get("args");
        if (raw == null && CREDITS.equals(message.get("tool"))) {
            return null;
        }
        if (!(raw instanceof Map<?, ?> args)) {
            return details("bad_request", "reason", "args");
        }
        Set<String> fields = TOOL.equals(message.get("tool")) ? CALL_FIELDS : CREDITS_FIELDS;
        for (Object key : args.keySet()) {
            if (!(key instanceof String field) || !fields.contains(field)) {
                return details("bad_request", "reason", "field");
            }
        }
        return null;
    }

    private Map<String, Object> relay(Object id, Map<String, Object> message) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("v", 1);
        if (message.get("args") instanceof Map<?, ?> args) {
            for (Map.Entry<?, ?> e : args.entrySet()) {
                body.put((String) e.getKey(), e.getValue());
            }
        }
        byte[] bytes = Json.bytes(body);
        if (bytes.length > MAX_ARGS_BYTES) {
            return terr(id, details("too_large", "reason", "body"));
        }
        String route = TOOL.equals(message.get("tool")) ? DeskMaiaClient.HELPERS_CALL : DeskMaiaClient.HELPERS_CREDITS;
        DeskMaiaClient.Answer answer;
        try {
            answer = client.call(route, bytes);
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
        return terr(id, MaiaModel.platformDetails(answer));
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
