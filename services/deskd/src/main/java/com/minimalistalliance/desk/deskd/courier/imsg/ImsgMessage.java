package com.minimalistalliance.desk.deskd.courier.imsg;

import java.util.List;

/**
 * A message as the member's Mac has it in Messages, whichever path brought it (the {@code imsg} seam, ma-desk
 * {@code docs/sub-status/imsg-seam.md}): BlueBubbles Server's REST API, or MA's own Mac connector through the sealed
 * relay. Each path turns what it reads into this; {@link ImsgSink} turns this into Courier's messages, the same way for
 * both. Every field is untrusted: the sink checks and cleans each one.
 *
 * @param guid Messages' own guid for the message (the same whichever path reads it, so a desk that moves from one path to
 *     the other stores nothing twice)
 * @param date when it was sent, epoch milliseconds ({@code dateCreated})
 * @param fromMe the member's own, sent from any of their Apple devices
 * @param sender the handle it came from (a number or an Apple ID's address); null when {@code fromMe}
 * @param senderService the handle's service: {@code iMessage}, {@code SMS} or {@code RCS}; null if not known
 * @param chat the chat it's in
 * @param text its text; null for none
 * @param subject iMessage's subject line, rarely set; null for none
 * @param files its attachments, by the path's own guid for each (never the bytes: the path reads those when asked)
 * @param reaction a tapback on another message, or null
 * @param event a group's change (added, removed, named, left), or null
 * @param edited when it was last edited, or null
 * @param retracted when it was unsent, or null
 * @param failed a send of the member's that didn't go out
 * @param appOnly something only Messages can show (an app's bubble, handwriting, Digital Touch)
 */
public record ImsgMessage(
        String guid,
        long date,
        boolean fromMe,
        String sender,
        String senderService,
        Chat chat,
        String text,
        String subject,
        List<File> files,
        Reaction reaction,
        Event event,
        Long edited,
        Long retracted,
        boolean failed,
        boolean appOnly) {

    public ImsgMessage {
        files = files == null ? List.of() : List.copyOf(files);
    }

    /**
     * A chat: Messages' guid for it ({@code iMessage;-;+15551230001}, {@code SMS;-;+15551230001},
     * {@code iMessage;+;chat123...}), whether it's a group, its name, and its people (handles, without the member).
     */
    public record Chat(String guid, boolean group, String name, List<String> participants) {
        public Chat {
            participants = participants == null ? List.of() : List.copyOf(participants);
        }
    }

    /** An attachment: the path's guid for it, its name, its type and its size as the Mac says (-1 if not said). */
    public record File(String guid, String name, String mime, long bytes) {}

    /**
     * A tapback: {@code type} is one of {@code love like dislike laugh emphasize question emoji sticker}, or the same with a
     * leading {@code -} for its removal (Messages' 2000 to 2007 and 3000 to 3007), {@code sticker-message} for a sticker
     * sent on its own (1000), or anything else for a reaction Courier names only as one. {@code target} is the guid of the
     * message it's on; {@code emoji} the emoji of an emoji tapback.
     */
    public record Reaction(String type, String target, String emoji) {}

    /** A group's change: {@code kind} is {@code added}, {@code removed}, {@code named} or {@code left}; {@code title} a new name. */
    public record Event(String kind, String title) {}

    /** No text in logs. */
    @Override
    public String toString() {
        return "ImsgMessage[" + files.size() + " files]";
    }
}
