package com.minimalistalliance.desk.courier.parse;

import java.io.IOException;
import java.io.InputStream;

/**
 * Another request family the sandbox's one worker serves beside {@code courier1} (deskd reaches a single sandbox, whose
 * command is fixed: {@code java @/app/courier-parse.options}). A mode is found with {@link java.util.ServiceLoader} before
 * the security manager is installed, and named by its first word ({@code docs1} for Documents, deskd {@code API.md}
 * §24). The worker reads the line strictly (printable ASCII, at most {@link CourierRequest#MAX_LINE} bytes, nothing past
 * the newline), hands it to the mode with the rest of the input, and keeps its own deadline: the mode answers once
 * through {@link Reply}, or the deadline does.
 *
 * <p>Implementations live in desk-agent's jar (the image the sandbox runs), so courier-parse never depends on them.
 */
public interface WorkerMode {

    /** The request line's first word, letters and digits only. */
    String word();

    /**
     * Runs once before the security manager is installed and before any request byte is read: anything the mode's
     * libraries set up by reading files or properties the manager refuses.
     */
    void warmUp();

    /**
     * One request: {@code line} without its newline, and the input after it. Answer through {@code reply}; a mode that
     * refuses reads what's left first ({@link Reply#drain()}) so deskd's write can end.
     *
     * @param millis what's left of the worker's deadline
     */
    void serve(String line, InputStream in, Reply reply, long millis) throws IOException;

    /** The worker's one answer, shared with its deadline. */
    interface Reply {
        /** {@code OK[ note]\n} then the body; false if the deadline answered first. */
        boolean ok(String note, byte[] body) throws IOException;

        /** {@code ERR <reason>\n}: a word of letters and underscores. */
        void refuse(String reason);

        /** Reads what's left of the request, up to a bound and for at most two seconds. */
        void drain();
    }
}
