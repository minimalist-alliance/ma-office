package com.minimalistalliance.desk.agent.approval;

import java.util.Objects;

/**
 * What {@link ApprovalGate#admit} decided for one call (draft ADR, sections 3 and 11). Only {@link Auto},
 * {@link Approved} and {@link Allowed} run the tool; the rest answer the model with {@link #modelText()} and run nothing.
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

    /**
     * Done without asking, under the member's setting for this agent ({@link ApprovalPolicy}; the owner's decision of
     * Nov 12, the draft ADR's §15, whose {@code Verdict.Auto(group)} this is: {@link Auto} stays "needs no approval"). It
     * runs with exactly the payload the policy judged, and a deskd-hosted tool sends {@code auto: <group>} with the call,
     * which deskd checks against its own record of the member's switches before it runs it, and {@code autoApprovalId}:
     * this call's own approval id, minted by the gate, so a tool that keys what it does by its approval (the Notebook's
     * edit key) does it once and the ADR's {@code agent.approval.undo} (W3) can find it.
     *
     * @param group the switch's group: {@code notebook}, {@code files}, {@code todos}
     * @param approvalId this unasked call's approval id ({@code ap-…}, as a card's), named on its {@code approval.auto} row
     */
    record Allowed(String group, String approvalId) implements Verdict {
        public Allowed {
            Objects.requireNonNull(group, "group");
            Objects.requireNonNull(approvalId, "approvalId");
        }

        @Override
        public boolean runs() {
            return true;
        }
    }

    /** Whether the call runs with the payload the policy made (and the member or their rule judged), not the model's input. */
    default boolean bindsPayload() {
        return this instanceof Approved || this instanceof Allowed;
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
