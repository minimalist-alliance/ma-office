package com.minimalistalliance.desk.deskd.notebook;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Message;
import com.minimalistalliance.desk.deskd.session.ChannelHandler;
import com.minimalistalliance.desk.deskd.session.Session;
import com.minimalistalliance.desk.deskd.session.SessionListener;
import com.minimalistalliance.desk.deskd.session.SessionManager;
import java.nio.file.Path;
import java.util.Map;
import java.util.function.BooleanSupplier;

/**
 * The relay of {@code commons}, a guild desk's room link, to Commons (API.md section 14,
 * docs/sub-status/deskd-guild-sessions.md, "Commons"). It's {@code collab}'s relay pointed at another socket: one
 * connection per session on {@code /run/desk-commons/commons.sock}, the same framing, a hello with the verified caller
 * first and a {@code caller} after a refresh changes it, each room-link message one BIN DATA both ways, and
 * {@code {"t":"reset"}} when the connection goes. The channel is 4, {@code mdoc}'s id, which a guild desk never serves as
 * it has no Browser, so desk-rtc bridges it unchanged.
 *
 * <p>Only a guild member's session on a guild desk reaches it. Anything else on channel 4 is dropped here, as it was
 * before: an owner's {@code mdoc} isn't served. Commons decides what a member may do in the room by the hello's caller,
 * and deskd checks nothing of the messages, which it neither reads nor logs.
 */
public final class CommonsRelay implements SessionListener {

    private final NotebookLinks links;
    /** Each ended session's seconds with Commons, until the heartbeat has taken them. Bounded: past it, the oldest go. */
    private final java.util.Map<String, long[]> ended = new java.util.LinkedHashMap<>();
    private final java.util.concurrent.locks.ReentrantLock lock = new java.util.concurrent.locks.ReentrantLock();
    private static final int MAX_ENDED = 1200;

    /** @param guildDesk read at each message: the DeskKind tag says {@code guild} */
    public CommonsRelay(Path socket, SessionManager sessions, EventHub hub, BooleanSupplier guildDesk, NotebookModule.Timing timing) {
        this.links = new NotebookLinks(sessions, hub, socket, NotebookModule.Service.COMMONS, timing);
        sessions.registerChannelHandler(Channels.MDOC, new Handler(links, guildDesk));
        sessions.addSessionListener(this);
    }

    @Override
    public void onSessionEnded(String sessionId) {
        NotebookLink link = links.get(sessionId);
        links.sessionEnded(sessionId);
        if (link != null) {
            lock.lock();
            try {
                ended.put(sessionId, new long[] {link.connectedNanos() / 1_000_000_000L, link.voiceBytesSent()});
                while (ended.size() > MAX_ENDED) {
                    ended.remove(ended.keySet().iterator().next());
                }
            } finally {
                lock.unlock();
            }
        }
    }

    /**
     * The heartbeat's {@code commonsSeconds} for a session (desks.md, "Guild Desk heartbeat"): how long its room link to
     * Commons has been up, all its connections together, which is as near as deskd can see to "in a Commons channel".
     * An ended session's last count stays until {@link #forget}.
     */
    public long commonsSeconds(String sessionId) {
        NotebookLink link = links.get(sessionId);
        if (link != null) {
            return link.connectedNanos() / 1_000_000_000L;
        }
        lock.lock();
        try {
            long[] last = ended.get(sessionId);
            return last == null ? 0L : last[0];
        } finally {
            lock.unlock();
        }
    }

    /**
     * The heartbeat's {@code commonsBytesSent}: what Commons' voice connections have sent this session, summed over
     * restarts from its {@code usage} frames. An ended session's final count stays until {@link #forget}.
     */
    public long voiceBytesSent(String sessionId) {
        NotebookLink link = links.get(sessionId);
        if (link != null) {
            return link.voiceBytesSent();
        }
        lock.lock();
        try {
            long[] last = ended.get(sessionId);
            return last == null ? 0L : last[1];
        } finally {
            lock.unlock();
        }
    }

    /** The heartbeat has reported a closed session for the last time. */
    public void forget(String sessionId) {
        lock.lock();
        try {
            ended.remove(sessionId);
        } finally {
            lock.unlock();
        }
    }

    @Override
    public void onCallerChanged(String sessionId) {
        links.callerChanged(sessionId);
    }

    /** What {@code /health} adds on a guild desk, for information only. */
    public Map<String, Object> health() {
        return Map.of("commons", links.anyConnected() ? "connected" : "waiting");
    }

    /** Never waits, whatever Commons is doing. */
    public void close() {
        links.closeAll();
    }

    /** For tests. */
    int linkCount() {
        return links.linkCount();
    }

    private record Handler(NotebookLinks links, BooleanSupplier guildDesk) implements ChannelHandler {
        @Override
        public void onMessage(Session session, Message message) throws InterruptedException {
            if (message.kind() != FrameKind.DATA || !message.binary()
                    || !session.grant().caller().isGuildMember() || !guildDesk.getAsBoolean()) {
                return;
            }
            NotebookLink link = links.open(session.sessionId());
            if (link != null) {
                link.collab(message.payload());
            }
        }
    }
}
