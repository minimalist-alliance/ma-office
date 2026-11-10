package com.minimalistalliance.desk.agent.llm;

/** A call the gateway wouldn't make, for a reason other than a limit. Nothing was sent. */
public final class GatewayException extends Exception {

    private static final long serialVersionUID = 1L;

    public enum Reason {
        /** The audit log or the ledger isn't open, so the call couldn't be recorded: fail closed. */
        NOT_READY,
        /** No adapter for the binding's provider. */
        NO_PROVIDER,
        /** No key under the binding's id. */
        NO_KEY,
        /** The key belongs to another provider. Sending it would hand one provider's key to another's host. */
        KEY_PROVIDER_MISMATCH
    }

    private final Reason reason;

    public GatewayException(Reason reason) {
        super(reason.name().toLowerCase(java.util.Locale.ROOT), null, false, false);
        this.reason = reason;
    }

    public Reason reason() {
        return reason;
    }
}
