package com.minimalistalliance.desk.agent.approval;

import java.util.Objects;

/**
 * What {@link ApprovalGate#admit} decided for one call (draft ADR, sections 3 and 11). Only {@link Auto} and
 * {@link Approved} run the tool; the rest answer the model with {@link #modelText()} and run nothing.
 */
public sealed interface Verdict {

    /** Whether the tool runs. */
    default boolean runs() {
        return false;
    }

    /** What the model reads instead of a result, for a call that doesn't run; null for one that does. */
    default String modelText() {
        return null;
    }

    /** Needed no approval: {@code read}, or {@code own} outside a memory save under U. */
    record Auto() implements Verdict {
        public static final Auto INSTANCE = new Auto();

        @Override
        public boolean runs() {
            return true;
        }
    }

    /**
     * The member approved it. A deskd-hosted tool sends {@code {approvalId, sha256}} with the call, and runs with
     * exactly the stored payload.
     */
    record Approved(String approvalId, String sha256) implements Verdict {
        public Approved {
            Objects.requireNonNull(approvalId, "approvalId");
            Objects.requireNonNull(sha256, "sha256");
        }

        @Override
        public boolean runs() {
            return true;
        }
    }

    /** The member declined it, with their note or null. */
    record Declined(String approvalId, String note) implements Verdict {
        @Override
        public String modelText() {
            String text = "The member declined this; nothing was done. Don't ask for the same thing again in this run.";
            if (note != null && !note.isBlank()) {
                text += "\nTheir note:\n" + com.minimalistalliance.desk.agent.team.Canonical.json(note);
            }
            return text;
        }
    }

    /** No answer in time, or the run stopped, restarted or lost its band: {@code timeout}, {@code stopped}, … */
    record Expired(String approvalId, String detail, long expiresAt) implements Verdict {
        @Override
        public String modelText() {
            if ("timeout".equals(detail)) {
                return "The member didn't answer by " + java.time.Instant.ofEpochMilli(expiresAt)
                        + "; nothing was done. Say what you were going to do, so they can ask you again.";
            }
            return "This wasn't answered (" + detail + "); nothing was done.";
        }
    }

    /**
     * Refused before asking: {@code ask_cap}, {@code unattended_spend}, {@code declined_before}, {@code declined},
     * {@code sensitive}, {@code tool_cap}, …
     */
    record Refused(String reason) implements Verdict {
        public Refused {
            Objects.requireNonNull(reason, "reason");
        }

        @Override
        public String modelText() {
            return "Not allowed: " + reason + ".";
        }
    }
}
