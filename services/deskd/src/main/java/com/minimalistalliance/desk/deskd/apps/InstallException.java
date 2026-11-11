package com.minimalistalliance.desk.deskd.apps;

/**
 * An install, upgrade or removal that didn't happen, and why, as a reason the client reads: {@code package} (the layout breaks
 * section 1.1's rules), {@code hash} (bytes that aren't what the catalog or manifest says), {@code size}, {@code signature},
 * {@code manifest}, {@code catalog}, {@code download}, {@code no_space}, {@code no_sandbox}, {@code storage},
 * {@code no_hello} (the trial start failed) or {@code busy}. Never carries a value from the package.
 */
public final class InstallException extends Exception {

    private static final long serialVersionUID = 1L;

    private final String reason;

    public InstallException(String reason) {
        super(reason, null, false, false);
        this.reason = reason;
    }

    public String reason() {
        return reason;
    }
}
