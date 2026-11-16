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
        CANCELLED,
        /**
         * Desk Maia's allowance on Minimalist Alliance's AI service is used up ({@code 429 limit}): no call was made and
         * nothing was spent. {@link #details} says which limit and when it resets.
         */
        LIMIT,
        /** Too much to send at once ({@code 413 too_large}): the thread needs compacting first. */
        TOO_LARGE,
        /** The service refused this member or desk ({@code 403}): {@link #details} says why. */
        FORBIDDEN
    }

    /**
     * What a refusal said beyond its kind, every part optional and checked for its shape: a reason word, a limit's window
     * ({@code day}, {@code week}, {@code month}, {@code memberTrial}), when it resets (ISO 8601 UTC) and a retry's wait.
     */
    public record Details(String reason, String window, String resetsAt, Long retryAfterSec) {
        public static final Details NONE = new Details(null, null, null, null);
    }

    private final Kind kind;
    private final boolean mayHaveBilled;
    private final Details details;

    public ProviderException(Kind kind, boolean mayHaveBilled) {
        this(kind, mayHaveBilled, Details.NONE);
    }

    public ProviderException(Kind kind, boolean mayHaveBilled, Details details) {
        super(kind.name().toLowerCase(java.util.Locale.ROOT), null, false, false);
        this.kind = kind;
        this.mayHaveBilled = mayHaveBilled;
        this.details = details == null ? Details.NONE : details;
    }

    public Kind kind() {
        return kind;
    }

    public Details details() {
        return details;
    }

    public boolean mayHaveBilled() {
        return mayHaveBilled;
    }
}
