package com.minimalistalliance.desk.agent.provider;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * The chat providers desk-agent can call, by id: Anthropic, OpenAI and xAI on a desk, and stand-ins in tests and the
 * AppCDS training. Kept in the order they were registered, which is the order {@code agent.providers} lists them.
 */
public final class ProviderRegistry {

    private final Map<String, ChatProvider> providers = new ConcurrentHashMap<>();
    private final List<String> order = new CopyOnWriteArrayList<>();

    public void register(ChatProvider provider) {
        if (providers.put(provider.id().id(), provider) == null) {
            order.add(provider.id().id());
        }
    }

    /** Every registered provider, in registration order. */
    public List<ChatProvider> all() {
        return order.stream().map(providers::get).toList();
    }

    /** @return the provider with this wire id, or null */
    public ChatProvider get(String id) {
        return providers.get(id);
    }

    /** @return the provider, or null if none is registered under that id */
    public ChatProvider get(ProviderId id) {
        return providers.get(id.id());
    }
}
