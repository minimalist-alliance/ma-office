package com.minimalistalliance.desk.agent.provider;

/**
 * A call that didn't finish. Carries a kind and never the provider's message, which could quote the request.
 *
 * <p>{@code mayHaveBilled} decides what the ledger keeps: false when the provider refused before generating
 * (auth, a 4xx, no connection), so the reservation is released; true when output may have been generated, such as a
 * stream cut short, so the reservation stays as spent. Guessing high there only makes limits stricter.
 */
public final class ProviderException extends Exception {

    private static final long serialVersionUID = 1L;

    public enum Kind {
        /** The key was refused. */
        AUTH,
        /** The provider's rate limit or quota. */
        RATE_LIMITED,
        /** The provider's free allowance for today is used, such as OpenRouter's free requests a day. */
        FREE_LIMIT,
        /** The account's privacy settings at the provider allow no endpoint for the model (OpenRouter's). */
        DATA_POLICY,
        /** The provider is down or overloaded. */
        UNAVAILABLE,
        /** The request itself was refused, such as an unknown model or too long a context. */
        BAD_REQUEST,
        /** No answer in time. */
        TIMEOUT,
        /** The run was stopped. */
        CANCELLED
    }

    private final Kind kind;
    private final boolean mayHaveBilled;

    public ProviderException(Kind kind, boolean mayHaveBilled) {
        super(kind.name().toLowerCase(java.util.Locale.ROOT), null, false, false);
        this.kind = kind;
        this.mayHaveBilled = mayHaveBilled;
    }

    public Kind kind() {
        return kind;
    }

    public boolean mayHaveBilled() {
        return mayHaveBilled;
    }
}
