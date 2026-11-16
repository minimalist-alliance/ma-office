package com.minimalistalliance.desk.deskd.courier.imsg;

import java.util.List;

/**
 * One message the member wrote, for a path to send (the {@code imsg} seam): to one Mac chat, as text.
 *
 * @param outboundId the queue's row, the same on every try
 * @param messageId the message in Courier's store
 * @param medium {@code imessage} or {@code sms}
 * @param chatGuid Messages' chat: {@code iMessage;-;<handle>} or {@code SMS;-;<number>} for one person, a group's own guid
 * @param handles the people it goes to (numbers or Apple IDs)
 * @param text what to send, 1 to {@link #MAX_TEXT} characters
 * @param attempt the try, from 1
 * @param maybeSentBefore an earlier try may have gone (its answer was lost): look on the Mac before sending again
 */
public record ImsgSend(String outboundId, String messageId, String medium, String chatGuid, List<String> handles, String text, int attempt,
        boolean maybeSentBefore) {

    public static final int MAX_TEXT = 20_000;

    public ImsgSend {
        handles = List.copyOf(handles);
    }

    /** How a try ended. */
    public sealed interface Result permits Sent, Retry, Failed {}

    /** Out: {@code guid} is the Mac's for it (recorded already through {@link ImsgPath.Context#recordSent}), or null. */
    public record Sent(String guid) implements Result {}

    /** Not out, worth another try; {@code unclear}: it may have gone. {@code error} is a short word. */
    public record Retry(String error, boolean unclear) implements Result {}

    /** Not out, and never will be: {@code error} is a short word ({@code chat}, {@code refused}, {@code too_long}). */
    public record Failed(String error) implements Result {}

    /** No text in logs. */
    @Override
    public String toString() {
        return "ImsgSend[" + outboundId + ", " + medium + ", attempt " + attempt + "]";
    }
}
