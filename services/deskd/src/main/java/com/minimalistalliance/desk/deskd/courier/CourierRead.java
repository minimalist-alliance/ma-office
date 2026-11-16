package com.minimalistalliance.desk.deskd.courier;

import java.util.List;
import java.util.Map;

/**
 * What the agent read tools read (draft ADR "the Agent's tools and approvals", §12, at {@code 0c5affa1}): the seam the
 * tools builder writes {@code courier_list}, {@code courier_search}, {@code courier_read} and {@code courier_new} on.
 * Names and fields are §12's, with the Courier plan's amendments (§6 there, accepted by Security's stand-in read on
 * Nov 13): every result carries {@code lane} and {@code accountLabel} ("Gmail", "This desk's address", never the address),
 * and agents see People, Updates (marked {@code bulk}) and Other (marked {@code senderKnown: false}), never Requests, Spam
 * or Trash. A blocked sender's mail is in Spam, and reaches an agent only if the member moves it out themselves.
 *
 * <p>Every method returns JSON values the tool hands the model as data. {@code from} is Courier's contact record for the
 * message's sender endpoint, never a name in the body or a display name in a header. A From header can be forged, so
 * every message and hit also carries {@code senderConfirmed}: true for the member's own and for an email whose DMARC
 * passed, false for any other email (a missing result included), and null for media with no DMARC. The tools show it
 * beside {@code from}. {@code text} is plain, with links as their domains and quoted mail folded.
 */
public interface CourierRead {

    /** False while there's no store, or Courier is switched off: deskd's hello then names no Courier tool. */
    boolean available();

    /**
     * {@code courier_list {kind?, unread?, before?}}: channels newest first, 50 a page:
     * {@code {channels: [{channelId, kind, title, contacts: [name], medium, lastAt, unread, lane, accountLabel}], next}}.
     *
     * @param kind {@code direct}, {@code group}, {@code self}, or null
     * @param before the previous page's {@code next}
     */
    Map<String, Object> list(String kind, Boolean unread, String before) throws Exception;

    /**
     * {@code courier_search {q, channelId?, from?, fromDay?, toDay?}}: 25 hits newest first,
     * {@code {hits: [{messageId, channelId, from, at, medium, subject?, snippet, lane, accountLabel, bulk, senderKnown,
     * senderConfirmed}]}},
     * snippets of 200 characters at most. Days are {@code YYYY-MM-DD}, both inclusive, in {@code zone} (IANA, or null for
     * UTC).
     */
    Map<String, Object> search(String q, String channelId, String from, String fromDay, String toDay, String zone) throws Exception;

    /**
     * {@code courier_read {messageId, from?}}: one message whole, its text from {@code from} (characters), 20,000 a page:
     * the message shape with {@code textFrom} and {@code textNext}. Null for a message an agent can't see.
     */
    Map<String, Object> read(String messageId, int from) throws Exception;

    /**
     * {@code courier_read {channelId, before?}}: a channel's messages a page at a time, newest page first, oldest first in
     * the page, 20,000 characters a page: {@code {channelId, messages, next}}. Null for a channel with nothing an agent can
     * see.
     */
    Map<String, Object> readChannel(String channelId, String before) throws Exception;

    /**
     * {@code courier_new {}}: inbound messages after the cursor, oldest first, at most {@code max} (100), no bulk mail, in
     * the store's {@code (receivedAt, messageId)} order: {@code {messages, cursor}}, where {@code cursor} is the last one
     * given (or the one passed in, if none). A message that a wake caught up, that waited for the parser, or that the
     * member let in or moved out of Spam gets its own later {@code receivedAt}, so it's never behind a cursor.
     *
     * @param cursor null for the beginning
     */
    Map<String, Object> newSince(Cursor cursor, int max) throws Exception;

    /** The newest point, for "Read new messages from now". */
    Cursor now() throws Exception;

    /** An agent's stored cursor, or null if it has none. */
    Cursor cursor(String agentId) throws Exception;

    /** Stores how far a run that ended {@code done} got. A cursor behind the stored one is ignored. */
    void saveCursor(String agentId, Cursor cursor) throws Exception;

    /** Forgets an agent's cursor (the agent is gone). */
    void forgetCursor(String agentId) throws Exception;

    /**
     * Whether a cursor names a stored message exactly, by its {@code receivedAt} and id: for the end of a run that deskd
     * has no record of giving anything (deskd restarted since), so a cursor desk-agent names is at least a real place.
     */
    default boolean names(Cursor cursor) throws Exception {
        return false;
    }

    /**
     * A page's {@code next} for the row at {@code at} with id {@code id} ({@code courier_list}'s by {@code lastAt} and
     * channel, a channel's page's by a message's {@code at} and id): the next page starts just past it. For the tools,
     * which may hand the model fewer rows than a page holds.
     */
    static String pageAfter(long at, String id) {
        return at + "." + id;
    }

    /** The agent tools' cursor: {@code {receivedAt, messageId}} of the last message given. */
    record Cursor(long receivedAt, String messageId) {
        public Map<String, Object> wire() {
            return Map.of("receivedAt", receivedAt, "messageId", messageId);
        }

        public boolean after(Cursor other) {
            return other == null || receivedAt > other.receivedAt
                    || (receivedAt == other.receivedAt && messageId.compareTo(other.messageId) > 0);
        }
    }

    /** No store: nothing to read, and the tools aren't offered. */
    CourierRead NONE = new CourierRead() {
        @Override
        public boolean available() {
            return false;
        }

        @Override
        public Map<String, Object> list(String kind, Boolean unread, String before) {
            return Map.of("channels", List.of());
        }

        @Override
        public Map<String, Object> search(String q, String channelId, String from, String fromDay, String toDay, String zone) {
            return Map.of("hits", List.of());
        }

        @Override
        public Map<String, Object> read(String messageId, int from) {
            return null;
        }

        @Override
        public Map<String, Object> readChannel(String channelId, String before) {
            return null;
        }

        @Override
        public Map<String, Object> newSince(Cursor cursor, int max) {
            return Map.of("messages", List.of());
        }

        @Override
        public Cursor now() {
            return null;
        }

        @Override
        public Cursor cursor(String agentId) {
            return null;
        }

        @Override
        public void saveCursor(String agentId, Cursor cursor) {}

        @Override
        public void forgetCursor(String agentId) {}
    };
}
