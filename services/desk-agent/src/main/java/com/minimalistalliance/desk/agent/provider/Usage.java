package com.minimalistalliance.desk.agent.provider;

/**
 * Tokens as the provider reported them, normalized so each count is billed at one price:
 *
 * <ul>
 *   <li>{@code inputTokens}: input read at the full input price, so without cache reads or writes. Anthropic reports
 *       it so; OpenAI's {@code prompt_tokens} includes cached tokens, and its adapter subtracts them.
 *   <li>{@code cachedInputTokens}: input read from the provider's prompt cache.
 *   <li>{@code cacheWriteTokens}: input written to the cache, which Anthropic bills above the input price.
 *   <li>{@code outputTokens}: everything billed as output, reasoning included, as both OpenAI and Anthropic count it.
 *   <li>{@code reasoningTokens}: the part of the output that was reasoning. Informational: it's already in the output.
 * </ul>
 */
public record Usage(
        long inputTokens, long cachedInputTokens, long cacheWriteTokens, long outputTokens, long reasoningTokens) {

    public static final Usage NONE = new Usage(0, 0, 0, 0, 0);

    public Usage {
        if (inputTokens < 0 || cachedInputTokens < 0 || cacheWriteTokens < 0 || outputTokens < 0
                || reasoningTokens < 0 || reasoningTokens > outputTokens) {
            throw new IllegalArgumentException("bad usage");
        }
    }

    public long totalTokens() {
        return inputTokens + cachedInputTokens + cacheWriteTokens + outputTokens;
    }
}
