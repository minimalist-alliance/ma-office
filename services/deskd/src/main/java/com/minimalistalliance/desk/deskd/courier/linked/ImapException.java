package com.minimalistalliance.desk.deskd.courier.linked;

import java.io.IOException;

/**
 * What can go wrong talking to a provider, as words: never the server's own text in a message, which can carry anything
 * (an address, a name), and never a stack of the secret's way.
 */
class ImapException extends IOException {
    private static final long serialVersionUID = 1L;

    ImapException(String word) {
        super(word, null);
    }

    /** The server broke the protocol: the connection goes. */
    static final class Protocol extends ImapException {
        private static final long serialVersionUID = 1L;

        Protocol(String word) {
            super("protocol: " + word);
        }
    }

    /** More than this command may bring: the connection goes before anything more is read. */
    static final class TooLarge extends ImapException {
        private static final long serialVersionUID = 1L;

        TooLarge() {
            super("too_large");
        }
    }

    /**
     * A tagged NO or BAD. {@code code} is the response code's word ({@code AUTHENTICATIONFAILED}, {@code THROTTLED},
     * {@code TRYCREATE}, ...) or null; {@code alert} whether it carried {@code [ALERT]}. The text is kept only as far as the
     * transport's own words go ({@link #says}).
     */
    static final class Refused extends ImapException {
        private static final long serialVersionUID = 1L;
        final String status;
        final String code;
        private final String text;

        Refused(String status, String code, String text) {
            // The message (which a log line may carry) holds the status and a code that is a plain word; a server's other
            // bytes stay out of it (Security's CI-L3).
            super(status.toLowerCase(java.util.Locale.ROOT) + (code == null ? ""
                    : " " + (code.matches("[A-Za-z0-9.-]{1,32}") ? code.toLowerCase(java.util.Locale.ROOT) : "other")));
            this.status = status;
            this.code = code;
            this.text = text == null ? "" : text;
        }

        boolean bad() {
            return "BAD".equals(status);
        }

        /** Whether the server's text holds one of these words, ignoring case: for providers that put the reason there. */
        boolean says(String... words) {
            String t = text.toLowerCase(java.util.Locale.ROOT);
            for (String w : words) {
                if (t.contains(w)) {
                    return true;
                }
            }
            return false;
        }
    }

    /** The server said BYE, or closed the connection. */
    static final class Closed extends ImapException {
        private static final long serialVersionUID = 1L;
        final boolean bye;
        private final String text;

        Closed(boolean bye, String text) {
            super(bye ? "bye" : "closed");
            this.bye = bye;
            this.text = text == null ? "" : text;
        }

        boolean says(String... words) {
            String t = text.toLowerCase(java.util.Locale.ROOT);
            for (String w : words) {
                if (t.contains(w)) {
                    return true;
                }
            }
            return false;
        }
    }
}
