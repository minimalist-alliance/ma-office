package com.minimalistalliance.desk.deskd.courier.store;

import java.util.List;
import java.util.Set;

/**
 * Courier's lanes (the launch plan §2.4) and the rule that picks one for a message as it arrives. A lane is kept per
 * message, so one person's personal mail and their newsletters can be in People and Updates at once; the lists group by
 * channel within a lane.
 */
public final class Lanes {

    private Lanes() {}

    public static final String PEOPLE = "people";
    public static final String REQUESTS = "requests";
    public static final String UPDATES = "updates";
    public static final String OTHER = "other";
    public static final String SPAM = "spam";
    public static final String TRASH = "trash";
    /** An email the sandbox hasn't read yet: in no list until it has. */
    public static final String PENDING = "pending";

    /** The lanes a member can see and move messages to. */
    public static final List<String> ALL = List.of(PEOPLE, REQUESTS, UPDATES, OTHER, SPAM, TRASH);
    public static final Set<String> MOVABLE = Set.of(PEOPLE, UPDATES, OTHER, SPAM, TRASH);
    /** What a search or a thread shows unless asked: everything but Spam, Trash and what isn't read yet. */
    public static final List<String> DEFAULT_VISIBLE = List.of(PEOPLE, REQUESTS, UPDATES, OTHER);
    /**
     * What an agent may see (draft agent tools ADR §12, with the Courier plan's proposed amendment 2, which waits on
     * Security's read): People, Updates (marked bulk) and Other (marked {@code senderKnown: false}). Never Requests, Spam,
     * Trash, or a blocked sender's mail, which is in Spam.
     */
    public static final List<String> AGENT_VISIBLE = List.of(PEOPLE, UPDATES, OTHER);
    /** The same without Other, if Security's read turns amendment 2 down: the agent tools draft as it stands. */
    public static final List<String> AGENT_VISIBLE_STRICT = List.of(PEOPLE, UPDATES);

    public static boolean valid(String lane) {
        return lane != null && ALL.contains(lane);
    }

    /**
     * Endpoint standings: who a sender is to this desk. Known: let in, a contact, or someone the member wrote to. Unknown:
     * everyone else, whose mail is a Request or Other by the account it came through. Blocked: Spam.
     */
    public static final String KNOWN = "known";
    public static final String UNKNOWN = "unknown";
    public static final String BLOCKED = "blocked";

    /** What the rule needs to know about one arriving message. */
    record Facts(
            boolean outgoing,
            boolean blocked,
            boolean spamVerdict,
            String standing,
            boolean bulk,
            boolean memberThread,
            String accountKind,
            boolean filterSpam,
            boolean dmarcFailed) {

        Facts(boolean outgoing, boolean blocked, boolean spamVerdict, String standing, boolean bulk, boolean memberThread,
                String accountKind) {
            this(outgoing, blocked, spamVerdict, standing, bulk, memberThread, accountKind, false, false);
        }

        Facts(boolean outgoing, boolean blocked, boolean spamVerdict, String standing, boolean bulk, boolean memberThread,
                String accountKind, boolean filterSpam) {
            this(outgoing, blocked, spamVerdict, standing, bulk, memberThread, accountKind, filterSpam, false);
        }

        /** Whether the learning filter may judge it: a stranger's mail that would be a Request or Other (SpamFilter). */
        boolean filterMayJudge() {
            return !blocked && !BLOCKED.equals(standing) && !outgoing && !spamVerdict && !KNOWN.equals(standing) && !memberThread;
        }
    }

    /**
     * The lane, in order: a blocked sender is Spam; the member's own mail is People; a spam verdict is Spam; a known sender's
     * email whose DMARC failed is a Request (it only claims to be them: the coordinator's call, Nov 14, for the safety plan's
     * open question; one that merely can't be confirmed, no policy or no result, stays theirs); a known sender is People, or
     * Updates for bulk mail; a stranger replying in a thread the member started is People; any other stranger
     * whom the learning filter judges spam is Spam (it judges nothing else: the member's word outranks its guess); any other
     * stranger through a linked mailbox is Other (years of a member's own mail mustn't land in Requests), and through this
     * desk's address, the member address or iMessage is a Request.
     */
    static String pick(Facts f) {
        if (f.blocked() || BLOCKED.equals(f.standing())) {
            return SPAM;
        }
        if (f.outgoing()) {
            return PEOPLE;
        }
        if (f.spamVerdict()) {
            return SPAM;
        }
        if (KNOWN.equals(f.standing())) {
            if (f.dmarcFailed()) {
                return REQUESTS;
            }
            return f.bulk() ? UPDATES : PEOPLE;
        }
        if (f.memberThread()) {
            return PEOPLE;
        }
        if (f.filterSpam()) {
            return SPAM;
        }
        if (Accounts.LINKED.contains(f.accountKind())) {
            return OTHER;
        }
        return REQUESTS;
    }

    /** Where a message goes once its sender is let in. */
    static String afterLetIn(boolean bulk) {
        return bulk ? UPDATES : PEOPLE;
    }
}
