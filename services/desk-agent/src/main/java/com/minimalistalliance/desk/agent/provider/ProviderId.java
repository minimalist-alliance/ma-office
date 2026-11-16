package com.minimalistalliance.desk.agent.provider;

import java.util.regex.Pattern;

/**
 * Which provider produced something: what a provider badge shows (design 9.4) and what a key belongs to. An id, not
 * an enum, so an OpenAI-compatible endpoint or a test's fake is one more value rather than a code change.
 *
 * @param id lowercase, as stored and sent: {@code anthropic}, {@code openai}, {@code google}, {@code xai},
 *     {@code openrouter}, {@code moonshot}
 * @param displayName what the badge's text fallback says
 */
public record ProviderId(String id, String displayName) {

    private static final Pattern ID = Pattern.compile("[a-z][a-z0-9-]{1,31}");

    public static final ProviderId ANTHROPIC = new ProviderId("anthropic", "Anthropic");
    public static final ProviderId OPENAI = new ProviderId("openai", "OpenAI");
    public static final ProviderId GOOGLE = new ProviderId("google", "Google");
    public static final ProviderId XAI = new ProviderId("xai", "xAI");
    public static final ProviderId OPENROUTER = new ProviderId("openrouter", "OpenRouter");
    /** Moonshot AI, whose keys come from its Kimi API Platform: the Kimi models, on its Chat Completions API. */
    public static final ProviderId MOONSHOT = new ProviderId("moonshot", "Moonshot AI");
    /**
     * Minimalist Alliance's own AI service, Desk Maia's only provider (the owner, Nov 14: "Maia ALWAYS runs on the company
     * account"). Never a member's: no key, no key list, no setup screen and no other agent ever names it.
     */
    public static final ProviderId MA = new ProviderId("ma", "Minimalist Alliance");
    /**
     * Minimalist Alliance as the provider of the member's own desk agents ("helpers"), paid in the member's MA credits (the
     * owner, Nov 15; ma-platform {@code desk-helpers.md}, ADR 0142). Apart from {@link #MA}, which is Desk Maia's alone: a
     * helper never runs on her allowance, and she never runs on the member's credits. No key: the Platform picks the model.
     */
    public static final ProviderId MA_CREDITS = new ProviderId("ma-credits", "Minimalist Alliance");

    /** OpenRouter's router across its free models, which serves only them. */
    public static final String OPENROUTER_FREE_ROUTER = "openrouter/free";

    public ProviderId {
        if (!ID.matcher(id).matches() || displayName.isBlank() || displayName.length() > 64) {
            throw new IllegalArgumentException("bad provider id");
        }
    }

    /**
     * Whether the provider itself serves this model at no charge, by the model's id: OpenRouter's free variants, whose
     * ids end in {@code :free}, and its free router. Nothing else is free, whatever a price table says (ADR 0043), and a
     * call that reports a cost anyway is charged it ({@code LlmGateway}).
     */
    public boolean servesFree(String model) {
        return id.equals(OPENROUTER.id) && model != null
                && (model.equals(OPENROUTER_FREE_ROUTER) || (model.endsWith(":free") && model.length() > 5));
    }

    @Override
    public String toString() {
        return id;
    }
}
