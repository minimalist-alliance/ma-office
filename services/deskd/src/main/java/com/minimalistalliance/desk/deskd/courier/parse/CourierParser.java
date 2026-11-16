package com.minimalistalliance.desk.deskd.courier.parse;

/**
 * The seam to {@code desk-parse}'s Courier mode (the launch plan's Wave 1.2, ADR 0097's sandbox: uid 1113, no network,
 * no {@code /data}, a fresh worker per parse). deskd hands it an email's raw bytes and gets back a {@link ParsedMessage}
 * or a refusal, and never parses MIME or HTML itself.
 *
 * <p>deskd is wired with {@link CourierSandbox}, which talks to the sandbox's socket. While it can't be reached (an image
 * without the Courier sandbox, or the sandbox down), an email is stored with its raw bytes and waits as {@code pending},
 * out of every list, and {@code CourierStore.reparsePending} reads it once the sandbox answers. Nothing is lost while the
 * sandbox is away or killed mid-message, which is one of the plan's fault cases (§7). {@link #NONE} is for tests.
 */
public interface CourierParser {

    /** What the sandbox said. */
    sealed interface Result permits Parsed, Refused {}

    record Parsed(ParsedMessage message) implements Result {}

    /**
     * The sandbox won't read it: over a limit (2,000 parts, nesting 20, 40 MB, 10 s), malformed past repair, or its answer
     * wasn't {@code parse-courier 1}. The member sees "This message couldn't be read safely", with the raw download.
     *
     * @param reason a short code: {@code too_large}, {@code too_deep}, {@code too_many_parts}, {@code timeout},
     *     {@code malformed}, {@code answer}
     */
    record Refused(String reason) implements Result {}

    /** The sandbox can't be reached now. The message waits, and is read later. */
    final class Unavailable extends Exception {
        private static final long serialVersionUID = 1L;

        public Unavailable(String message) {
            super(message, null, false, false);
        }
    }

    Result parse(byte[] raw) throws Unavailable, InterruptedException;

    /** No parser yet: every email waits. */
    CourierParser NONE = raw -> {
        throw new Unavailable("no parser");
    };
}
