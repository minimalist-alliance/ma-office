package com.minimalistalliance.desk.agent.testing;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.json.JsonFormatException;
import com.minimalistalliance.desk.agent.team.Canonical;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * What deskd binds to a call's key (API.md §18, "Keys"; deskd's {@code ToolHost.fingerprint}): the run, agent, tool,
 * arguments, approval, switch and context, as they cross the socket (after JSON), an absent field as null. A test's
 * deskd that keeps replies by key answers another call under the same key {@code key_mismatch}, as deskd does, so a
 * resend that binds something else than its first sending shows here and not first on a real desk.
 */
public final class KeyFingerprint {

    /** The fields deskd's key binds, in its order. */
    public static final List<String> BOUND = List.of("runId", "agentId", "tool", "args", "approval", "auto",
            "autoApprovalId", "context");

    private KeyFingerprint() {}

    public static String of(Map<String, Object> call) {
        Map<String, Object> wire;
        try {
            wire = Json.parseObject(Json.bytes(call));
        } catch (JsonFormatException e) {
            throw new IllegalArgumentException(e);
        }
        Map<String, Object> bound = new LinkedHashMap<>();
        for (String field : BOUND) {
            bound.put(field, wire.get(field));
        }
        return Canonical.sha256(bound);
    }
}
