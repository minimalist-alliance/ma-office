package com.minimalistalliance.desk.deskd.data;

import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import com.minimalistalliance.desk.deskd.protocol.Message;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import com.minimalistalliance.desk.deskd.session.ChannelHandler;
import com.minimalistalliance.desk.deskd.session.Session;
import com.minimalistalliance.desk.deskd.session.SessionManager;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.LongConsumer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The data.read transfers of every session, and what the reader sends back on channel 5: CREDIT, kind 16, JSON
 * {@code {"bytes": n}}, with the transfer's id. Anything else on that channel is dropped, as is a CREDIT deskd can't
 * read or for a transfer that has ended.
 *
 * <p>At most {@link #MAX_PER_SESSION} at once per session, and {@link #MAX_PER_DESK} across them all, which each
 * hold a connection to the helper until they end: desk-data.socket allows 24, so 12 are left for calls. The Files
 * app's uploads and files.read count in the same table ({@link #reserveUpload}). Ids are per
 * session, from 1, and never come back within it.
 * A session's transfers end with it, which closes each one's connection to the helper.
 *
 * <p>Only an {@code export} session's frames can be free, and only while {@link FreeBudget} has room. An {@code owner}
 * session's are left on the meter, like anything else the desk sends the member.
 */
public final class Transfers implements ChannelHandler {

    private static final Logger log = LoggerFactory.getLogger(Transfers.class);

    public static final int MAX_PER_SESSION = 8;
    public static final int MAX_PER_DESK = 12;
    static final String TOO_MANY = "too_many";
    private static final long MAX_ID = 0xFFFFFFFFL;

    /** What the Files app's uploads hear: the client's CHUNK frames on bulk, for the transfer id they hold. */
    public interface ChunkSink {
        /** On the bulk channel's lane: queue and return. Never touch a disk here, or wait on anything long. */
        void chunk(Session session, Message message) throws InterruptedException;

        /** The session has ended. Must not block: it may run on the rtc reader. */
        void sessionEnded();
    }

    /** One upload's place in the table: an id, and a place against the session's and the desk's limits. */
    public interface Slot {
        long id();

        /** Once, as the upload's transfer ends, whichever way. Later calls do nothing. */
        void release();
    }

    private final class UploadSlot implements Slot {
        final String sessionId;
        final long id;
        final ChunkSink sink;
        private boolean released;

        UploadSlot(String sessionId, long id, ChunkSink sink) {
            this.sessionId = sessionId;
            this.id = id;
            this.sink = sink;
        }

        @Override
        public long id() {
            return id;
        }

        @Override
        public void release() {
            lock.lock();
            try {
                if (released) {
                    return;
                }
                released = true;
                running--;
                Table table = bySession.get(sessionId);
                if (table != null) {
                    table.slots.remove(id, this);
                }
            } finally {
                lock.unlock();
            }
        }
    }

    private static final class Table {
        final Map<Long, Transfer> live = new HashMap<>();
        final Map<Long, UploadSlot> slots = new HashMap<>();
        long nextId = 1;

        int size() {
            return live.size() + slots.size();
        }
    }

    private final SessionManager sessions;
    private final FreeBytes freeBytes;
    private final FreeBudget budget;
    private final Duration idle;
    private final ReentrantLock lock = new ReentrantLock();
    private final Map<String, Table> bySession = new HashMap<>();
    /** Transfers that haven't ended, in every session, those of sessions that have just ended included. */
    private int running;

    /**
     * A table with no free-export accounting, which is all the Files app's tests need: they register it on the bulk
     * channel themselves. DataModule makes the desk's own.
     */
    public static Transfers withoutExportAccounting(SessionManager sessions, Duration idle) {
        return new Transfers(sessions, null, null, idle);
    }

    /** @param idle how long a transfer waits for credit before it gives up */
    Transfers(SessionManager sessions, FreeBytes freeBytes, FreeBudget budget, Duration idle) {
        this.sessions = sessions;
        this.freeBytes = freeBytes;
        this.budget = budget;
        this.idle = idle;
    }

    /**
     * Takes one of the session's places, before anything is asked of the helper, so a ninth read opens nothing.
     *
     * @throws RpcException too_many past {@link #MAX_PER_SESSION}, or unavailable if the session has ended
     */
    public Transfer reserve(String sessionId) throws RpcException {
        lock.lock();
        try {
            // A session's end is heard after it has left the live table, and it takes this lock to stop what's here. So
            // either it's found gone now, or its end comes after this and finds the new one.
            Session session = sessions.session(sessionId);
            if (session == null) {
                throw new RpcException(RpcException.UNAVAILABLE, "The session has ended", Map.of());
            }
            Table table = bySession.computeIfAbsent(sessionId, id -> new Table());
            if (table.size() >= MAX_PER_SESSION) {
                throw new RpcException(
                        TOO_MANY, "Too many transfers at once", Map.of("limit", MAX_PER_SESSION, "reason", "session"));
            }
            if (running >= MAX_PER_DESK) {
                throw new RpcException(
                        TOO_MANY, "Too many transfers on this desk at once", Map.of("limit", MAX_PER_DESK, "reason", "desk"));
            }
            if (table.nextId > MAX_ID) {
                throw new RpcException(RpcException.UNAVAILABLE, "No transfer ids left in this session", Map.of());
            }
            // A refresh must keep the scope, so what it says now holds for the whole transfer.
            LongConsumer frameSent = RpcPrincipal.EXPORT.equals(session.grant().scope()) ? this::countFree : bytes -> {};
            Transfer transfer = new Transfer(table.nextId++, session, frameSent, idle, done -> forget(sessionId, done));
            table.live.put(transfer.id(), transfer);
            running++;
            if (transfer.isExport()) {
                exportsChanged.run();
            }
            return transfer;
        } finally {
            lock.unlock();
        }
    }

    /**
     * Takes one of the session's places for an upload, as {@link #reserve} does for a read: the same ids, the same 8 and
     * 12. The sink hears the client's CHUNKs for the id until {@link Slot#release}.
     *
     * @throws RpcException too_many, or unavailable if the session has ended
     */
    public Slot reserveUpload(String sessionId, ChunkSink sink) throws RpcException {
        lock.lock();
        try {
            Session session = sessions.session(sessionId);
            if (session == null) {
                throw new RpcException(RpcException.UNAVAILABLE, "The session has ended", Map.of());
            }
            Table table = bySession.computeIfAbsent(sessionId, id -> new Table());
            if (table.size() >= MAX_PER_SESSION) {
                throw new RpcException(
                        TOO_MANY, "Too many transfers at once", Map.of("limit", MAX_PER_SESSION, "reason", "session"));
            }
            if (running >= MAX_PER_DESK) {
                throw new RpcException(
                        TOO_MANY, "Too many transfers on this desk at once", Map.of("limit", MAX_PER_DESK, "reason", "desk"));
            }
            if (table.nextId > MAX_ID) {
                throw new RpcException(RpcException.UNAVAILABLE, "No transfer ids left in this session", Map.of());
            }
            UploadSlot slot = new UploadSlot(sessionId, table.nextId++, sink);
            table.slots.put(slot.id, slot);
            running++;
            return slot;
        } finally {
            lock.unlock();
        }
    }

    /** A frame of an export's. What the budget doesn't cover stays off {@link FreeBytes}, so it reaches the meter. */
    private void countFree(long frameBytes) {
        if (budget == null || freeBytes == null) {
            return;
        }
        long free = budget.take(frameBytes);
        if (free > 0) {
            freeBytes.add(free);
        }
    }

    /** data.read.stop. An id that has ended already, or never was, is fine. */
    public void stop(String sessionId, long transferId) {
        Transfer transfer;
        lock.lock();
        try {
            Table table = bySession.get(sessionId);
            transfer = table == null ? null : table.live.get(transferId);
        } finally {
            lock.unlock();
        }
        if (transfer != null) {
            transfer.stop();
        }
    }

    /** How many transfers haven't ended, on the whole desk. */
    int running() {
        lock.lock();
        try {
            return running;
        } finally {
            lock.unlock();
        }
    }

    /** Told after an export session's transfer begins or ends. Must not block. */
    private volatile Runnable exportsChanged = () -> {};

    void onExportsChange(Runnable action) {
        exportsChanged = action;
    }

    /**
     * How many transfers of {@code export} sessions haven't ended: the downloads and moves of data.read. The Files app's
     * transfers are a member's, on a session that counts as a session already.
     */
    int exportCount() {
        lock.lock();
        try {
            int count = 0;
            for (Table table : bySession.values()) {
                for (Transfer transfer : table.live.values()) {
                    if (transfer.isExport()) {
                        count++;
                    }
                }
            }
            return count;
        } finally {
            lock.unlock();
        }
    }

    /** How many of the session's transfers haven't ended. */
    public int count(String sessionId) {
        lock.lock();
        try {
            Table table = bySession.get(sessionId);
            return table == null ? 0 : table.size();
        } finally {
            lock.unlock();
        }
    }

    /** Its transfers end. May run on the rtc reader: each stop only flags and interrupts. */
    public void sessionEnded(String sessionId) {
        List<Transfer> ending;
        List<UploadSlot> endingUploads;
        lock.lock();
        try {
            Table table = bySession.remove(sessionId);
            ending = table == null ? List.of() : new ArrayList<>(table.live.values());
            endingUploads = table == null ? List.of() : new ArrayList<>(table.slots.values());
        } finally {
            lock.unlock();
        }
        for (Transfer transfer : ending) {
            transfer.stop();
        }
        for (UploadSlot slot : endingUploads) {
            slot.sink.sessionEnded();
        }
    }

    /** On the bulk channel's lane, one message at a time. Never waits on anything but a lock held briefly. */
    @Override
    public void onMessage(Session session, Message message) throws InterruptedException {
        if (message.kind() == FrameKind.CHUNK) {
            UploadSlot slot;
            lock.lock();
            try {
                Table table = bySession.get(session.sessionId());
                slot = table == null ? null : table.slots.get(message.id());
            } finally {
                lock.unlock();
            }
            // A frame for an id deskd doesn't know is ignored without a word.
            if (slot != null) {
                slot.sink.chunk(session, message);
            }
            return;
        }
        if (message.kind() != FrameKind.CREDIT) {
            return;
        }
        long bytes;
        try {
            bytes = DataHelperClient.wholeNumber(Json.parseObject(message.payload()).get("bytes"));
        } catch (JsonFormatException e) {
            bytes = -1;
        }
        if (bytes <= 0) {
            log.debug("CREDIT on bulk without a byte count, dropped");
            return;
        }
        Transfer transfer;
        lock.lock();
        try {
            Table table = bySession.get(session.sessionId());
            transfer = table == null ? null : table.live.get(message.id());
        } finally {
            lock.unlock();
        }
        if (transfer != null) {
            transfer.grant(bytes);
        }
    }

    /** Once per transfer, as it ends, whichever way. */
    private void forget(String sessionId, Transfer transfer) {
        lock.lock();
        try {
            running--;
            Table table = bySession.get(sessionId);
            if (table != null) {
                table.live.remove(transfer.id(), transfer);
            }
        } finally {
            lock.unlock();
        }
        if (transfer.isExport()) {
            exportsChanged.run();
        }
    }
}
