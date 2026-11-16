package com.minimalistalliance.desk.deskd.courier.store;

import java.util.List;
import java.util.Set;

/** The kinds of account a message can come through, and the medium each speaks. */
public final class Accounts {

    private Accounts() {}

    /** This desk's own address, through Platform's mail door. */
    public static final String DESK = "desk";
    /** A linked mailbox over IMAP and SMTP. */
    public static final String IMAP = "imap";
    /** A linked mailbox over JMAP (Fastmail). */
    public static final String JMAP = "jmap";
    /** Sealed messages between members' desks. */
    public static final String MA = "ma";
    /** iMessage and iPhone texts through the member's own Mac. */
    public static final String IMESSAGE = "imessage";

    public static final Set<String> KINDS = Set.of(DESK, IMAP, JMAP, MA, IMESSAGE);
    public static final Set<String> LINKED = Set.of(IMAP, JMAP);
    /** Accounts with a sign-in sealed in the vault: linked mailboxes, and the Mac's server address and password. */
    public static final Set<String> SEALED = Set.of(IMAP, JMAP, IMESSAGE);

    /** Media a message can have. */
    public static final List<String> MEDIA = List.of("email", "ma", "imessage", "sms");

    /** The endpoint kind a sender of this medium has. */
    static String endpointKind(String medium, String value) {
        return switch (medium) {
            case "email" -> "email";
            case "ma" -> "ma";
            case "imessage", "sms" -> value != null && value.contains("@") ? "apple" : "phone";
            default -> "email";
        };
    }

    /** What an agent is told of an account: its kind's name, never its address (the plan's amendment 3). */
    static String agentLabel(String kind, String label) {
        if (kind == null) {
            return null;
        }
        return switch (kind) {
            case DESK -> "This desk's address";
            case MA -> "Messages between desks";
            case IMESSAGE -> "Messages on your Mac";
            default -> label != null && !label.contains("@") ? label : "Linked mailbox";
        };
    }
}
