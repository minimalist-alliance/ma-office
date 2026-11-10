package com.minimalistalliance.desk.agent.provider;

import com.minimalistalliance.desk.agent.key.KeyLease;
import java.util.List;

/**
 * One LLM provider's chat API: our own interface, so the agent loop, the limits and the audit log never see a
 * provider's types (ADR 0018 kept this from the Node design). An adapter maps {@link ChatRequest} to the provider's
 * wire format and its reply back to {@link ChatResult} and {@link Usage}.
 *
 * <p>An adapter is called only through {@code LlmGateway}, which has already reserved the call's worst case
 * against the limits and checked the key belongs to this provider. It must stream text into {@code sink} as it
 * arrives, stop when its thread is interrupted, and never put the key, the prompt or the reply in a log or an
 * exception.
 */
public interface ChatProvider {

    ProviderInfo info();

    default ProviderId id() {
        return info().id();
    }

    ChatResult chat(ChatRequest request, KeyLease key, DeltaSink sink) throws ProviderException;

    /**
     * The models this key may use: the provider's free model-list call, which is also the key check of design 9.5.
     *
     * @throws ProviderException {@code AUTH} if the key is refused
     */
    List<ModelInfo> models(KeyLease key) throws ProviderException;
}
