package com.minimalistalliance.desk.deskd.guild;

import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import com.minimalistalliance.desk.deskd.rtc.RtcStats;
import com.minimalistalliance.desk.deskd.session.Session;
import com.minimalistalliance.desk.deskd.session.SessionListener;
import com.minimalistalliance.desk.deskd.session.SessionManager;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.locks.ReentrantLock;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

/**
 * A guild desk heartbeat's {@code guild} block (ma-platform desks.md, "Guild Desk heartbeat: guild.sessions"): each
 * member session's bytes and seconds, cumulative, and a closed one once more with {@code closed: true}. Bytes are
 * desk-rtc's per-session {@code bytesSent} from its last {@code stats}. With desk-rtc 0.4.0 or later a closed session's
 * bytes are final: its {@code session.closed} carries them, and so does its {@code closed} row in every stats until
 * deskd acknowledges it (this class is the {@link RtcClient.ClosedRows} that does), so a closed entry waits, up to
 * {@link #FINAL_WAIT_SECONDS}, for them. With an older desk-rtc a session that ends between two stats loses what it
 * sent since the first, which under-counts, as the contract allows. {@code commonsSeconds} is how long the
 * session's room link to Commons was up, from the commons relay. {@code commonsBytesSent} is what Commons' SFU sent
 * to the session's voice connection, from Commons' {@code usage} frames on the session's relay connection, summed over
 * voice restarts; room-link bytes are in {@code bytesSent}.
 */
public final class GuildSessionLog implements SessionListener, RtcClient.ClosedRows {

    /**
     * How long a closed session, on a desk-rtc that sends final counts, waits for them before it goes with the last it
     * had: a session deskd closed itself ends here before desk-rtc says so, and a lost {@code rtc.sock} can lose the
     * message (the closed row comes back in the next connection's stats, if desk-rtc did not restart).
     */
    static final long FINAL_WAIT_SECONDS = 60;
    /** Closed rows seen and not yet acknowledged. desk-rtc keeps at most 2048. */
    private static final int MAX_ACKS = 4096;

    /** desks.md: at most 600 sessions a heartbeat. */
    static final int MAX_ENTRIES = SessionManager.MAX_GUILD_SESSIONS;

    private static final class Entry {
        final String memberId;
        final long openedNanos;
        long bytesSent;
        long commonsSeconds;
        long commonsBytes;
        long closedNanos = -1;
        /** desk-rtc 0.4.0 gave the session's final bytes. */
        boolean bytesFinal;

        Entry(String memberId, long openedNanos) {
            this.memberId = memberId;
            this.openedNanos = openedNanos;
        }
    }

    private final SessionManager sessions;
    private final BooleanSupplier guildDesk;
    private final Commons commons;

    /** What the commons relay knows of a session's time with Commons. */
    public interface Commons {
        long seconds(String sessionId);

        /** Bytes Commons' voice connections sent the session, in total. */
        default long voiceBytes(String sessionId) {
            return 0;
        }

        void forget(String sessionId);

        Commons NONE = new Commons() {
            @Override
            public long seconds(String sessionId) {
                return 0;
            }

            @Override
            public void forget(String sessionId) {}
        };
    }
    private final ReentrantLock lock = new ReentrantLock();
    private final Map<String, Entry> entries = new LinkedHashMap<>();
    private final Set<String> toAck = new LinkedHashSet<>();
    private volatile BooleanSupplier finalCounts = () -> false;

    public GuildSessionLog(SessionManager sessions, BooleanSupplier guildDesk) {
        this(sessions, guildDesk, Commons.NONE);
    }

    public GuildSessionLog(SessionManager sessions, BooleanSupplier guildDesk, Commons commons) {
        this.sessions = sessions;
        this.guildDesk = guildDesk;
        this.commons = commons;
        sessions.addSessionListener(this);
    }

    /** Whether desk-rtc sends final counts (0.4.0 or later): then a closed session waits for them. Default no. */
    public void finalCountsFrom(BooleanSupplier supplier) {
        this.finalCounts = supplier;
    }

    @Override
    public void onSessionFinalBytes(String sessionId, String memberId, long bytesSent, long bytesReceived) {
        lock.lock();
        try {
            Entry entry = entries.get(sessionId);
            if (entry != null) {
                entry.bytesSent = Math.max(entry.bytesSent, bytesSent);
                entry.bytesFinal = true;
            }
        } finally {
            lock.unlock();
        }
    }

    @Override
    public Collection<String> toAck() {
        lock.lock();
        try {
            return List.copyOf(toAck);
        } finally {
            lock.unlock();
        }
    }

    @Override
    public void acked(Collection<String> sessionIds) {
        lock.lock();
        try {
            toAck.removeAll(sessionIds);
        } finally {
            lock.unlock();
        }
    }

    @Override
    public void onSessionOpened(String sessionId) {
        Session session = sessions.session(sessionId);
        if (session == null) {
            return;
        }
        Caller caller = session.grant().caller();
        if (!caller.isGuildMember()) {
            return;
        }
        lock.lock();
        try {
            if (entries.size() < MAX_ENTRIES * 2) {
                entries.putIfAbsent(sessionId, new Entry(caller.memberId(), System.nanoTime()));
            }
        } finally {
            lock.unlock();
        }
    }

    @Override
    public void onSessionEnded(String sessionId) {
        lock.lock();
        try {
            Entry entry = entries.get(sessionId);
            if (entry != null && entry.closedNanos < 0) {
                entry.closedNanos = System.nanoTime();
            }
        } finally {
            lock.unlock();
        }
    }

    /** The block, or null on any desk but a guild's. A closed session goes once, and is then forgotten. */
    public Map<String, Object> block(RtcStats stats) {
        if (!guildDesk.getAsBoolean()) {
            return null;
        }
        Map<String, Long> bytes = new HashMap<>();
        Map<String, Long> closedRows = new HashMap<>();
        if (stats != null) {
            for (RtcStats.SessionStats session : stats.sessions()) {
                if (session.sessionId() != null) {
                    (session.closed() ? closedRows : bytes).put(session.sessionId(), session.bytesSent());
                }
            }
        }
        long now = System.nanoTime();
        boolean waitForFinal = finalCounts.getAsBoolean();
        List<Map<String, Object>> list = new ArrayList<>();
        lock.lock();
        try {
            // A closed row is the session's final count. Record it if the session.closed that carried it never came, and
            // ack it either way, whether or not this log still knows the session: desk-rtc keeps it until then.
            for (Map.Entry<String, Long> row : closedRows.entrySet()) {
                Entry known = entries.get(row.getKey());
                if (known != null) {
                    known.bytesSent = Math.max(known.bytesSent, row.getValue());
                    known.bytesFinal = true;
                }
                if (toAck.size() < MAX_ACKS) {
                    toAck.add(row.getKey());
                }
            }
            Iterator<Map.Entry<String, Entry>> iterator = entries.entrySet().iterator();
            while (iterator.hasNext() && list.size() < MAX_ENTRIES) {
                Map.Entry<String, Entry> item = iterator.next();
                Entry entry = item.getValue();
                if (waitForFinal
                        && entry.closedNanos >= 0
                        && !entry.bytesFinal
                        && now - entry.closedNanos < TimeUnit.SECONDS.toNanos(FINAL_WAIT_SECONDS)) {
                    continue;
                }
                Long sent = bytes.get(item.getKey());
                if (sent != null && sent > entry.bytesSent) {
                    entry.bytesSent = sent;
                }
                long withCommons = commons.seconds(item.getKey());
                if (withCommons > entry.commonsSeconds) {
                    entry.commonsSeconds = withCommons;
                }
                long voice = commons.voiceBytes(item.getKey());
                if (voice > entry.commonsBytes) {
                    entry.commonsBytes = voice;
                }
                boolean closed = entry.closedNanos >= 0;
                long end = closed ? entry.closedNanos : now;
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("sessionId", item.getKey());
                row.put("memberId", entry.memberId);
                row.put("bytesSent", entry.bytesSent);
                row.put("commonsBytesSent", entry.commonsBytes);
                row.put("connectedSeconds", Math.max(0, (end - entry.openedNanos) / 1_000_000_000L));
                row.put("commonsSeconds", entry.commonsSeconds);
                row.put("closed", closed);
                list.add(row);
                if (closed) {
                    iterator.remove();
                    commons.forget(item.getKey());
                }
            }
        } finally {
            lock.unlock();
        }
        // Exactly desks.md's shape: 0.3.30 dropped the host model's lastActivityAt, as members' sessions keep the desk awake.
        Map<String, Object> block = new LinkedHashMap<>();
        block.put("sessions", list);
        return block;
    }
}
