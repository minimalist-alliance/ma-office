package com.minimalistalliance.desk.deskd.courier.keys;

import com.minimalistalliance.desk.courier.envelope.PublishedKeys;
import com.minimalistalliance.desk.deskd.platform.AgentClient;
import java.io.IOException;
import java.time.Duration;
import java.util.Map;

/**
 * {@code PUT /v1/agent/keys} (contract 0.4.0 §3.1), signed with the desk's role as every agent route. The same keys again
 * are {@code changed: false} and cost nothing, so deskd calls it at every start; new keys after a rotation are a change
 * (at most 3 a UTC day, {@code 429 keys_change_limit}).
 */
public final class PlatformKeyPublisher implements KeyPublisher {

    private final AgentClient client;

    public PlatformKeyPublisher(AgentClient client) {
        this.client = client;
    }

    @Override
    public Result publish(PublishedKeys keys) throws InterruptedException {
        Map<String, Object> answer;
        try {
            answer = client.putKeys(keys.toJson());
        } catch (AgentClient.ApiException e) {
            String code = e.code() == null ? "http_" + e.status() : e.code();
            return switch (code) {
                // A Guild Desk has no Courier (contract §3); keys a contract refuses won't be taken on a retry either.
                case "desk_kind", "keys_invalid", "binding_invalid" -> Result.never(code);
                default -> Result.later(code, e.retryAfter());
            };
        } catch (IOException e) {
            // No API base (a self-hosted desk without the platform), or the platform unreachable: the next sweep tries again.
            return Result.later("unreachable", null);
        }
        long version = answer.get("keysVersion") instanceof Number n ? n.longValue() : -1;
        String fingerprint = answer.get("fingerprint") instanceof String f ? f : null;
        return Result.published(version, fingerprint);
    }
}
