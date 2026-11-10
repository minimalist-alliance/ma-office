package com.minimalistalliance.desk.agent.provider;

import java.util.regex.Pattern;

/**
 * Which provider produced something: what a provider badge shows (design 9.4) and what a key belongs to. An id, not
 * an enum, so an OpenAI-compatible endpoint or a test's fake is one more value rather than a code change.
 *
 * @param id lowercase, as stored and sent: {@code anthropic}, {@code openai}, {@code google}, {@code xai}
 * @param displayName what the badge's text fallback says
 */
public record ProviderId(String id, String displayName) {

    private static final Pattern ID = Pattern.compile("[a-z][a-z0-9-]{1,31}");

    public static final ProviderId ANTHROPIC = new ProviderId("anthropic", "Anthropic");
    public static final ProviderId OPENAI = new ProviderId("openai", "OpenAI");
    public static final ProviderId GOOGLE = new ProviderId("google", "Google");
    public static final ProviderId XAI = new ProviderId("xai", "xAI");

    public ProviderId {
        if (!ID.matcher(id).matches() || displayName.isBlank() || displayName.length() > 64) {
            throw new IllegalArgumentException("bad provider id");
        }
    }

    @Override
    public String toString() {
        return id;
    }
}
