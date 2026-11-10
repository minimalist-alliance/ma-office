package com.minimalistalliance.desk.agent.manager;

/**
 * Why an agent didn't answer. {@code detail} is a word for the client (the limit's scope, the provider's error
 * kind), never content.
 */
public final class AgentException extends Exception {

    private static final long serialVersionUID = 1L;

    public enum Code {
        /** No key bound: the dormant manager of design 9.2. */
        NO_KEY,
        /** One active run per agent (design 9.2), and one is running. */
        BUSY,
        /** A limit refused the call before it was made. */
        LIMIT_REACHED,
        /** The provider failed or refused. */
        PROVIDER_ERROR,
        /** desk-agent can't record the call yet, or the binding names a provider or key it doesn't have. */
        UNAVAILABLE
    }

    private final Code code;
    private final String detail;

    public AgentException(Code code, String detail) {
        super(code.name().toLowerCase(java.util.Locale.ROOT) + (detail == null ? "" : " " + detail), null, false,
                false);
        this.code = code;
        this.detail = detail;
    }

    public Code code() {
        return code;
    }

    public String detail() {
        return detail;
    }
}
