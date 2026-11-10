package com.minimalistalliance.desk.deskd.notebook;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.platform.EditBudget;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.session.Session;
import com.minimalistalliance.desk.deskd.session.SessionManager;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The session's links, one each, from its first use to its end, and what they share: whether desk-notebook has been
 * said to be away, and the tree's last {@code {rev}}.
 *
 * <p><b>The tree.</b> Every link with a subscriber on its session holds its own {@code sub}, as the contract has it, and
 * each hears the same {@code {rev}} for the one desk. So one heard on any link goes to the hub, which reaches every
 * subscribed client, and the same again from another link is dropped. The last one is what a later SUB or a client
 * that fell behind gets as its snapshot, for as long as a link is subscribed to keep it current. It's a number, and
 * deskd doesn't look inside it.
 */
final class NotebookLinks {

    private static final Logger log = LoggerFactory.getLogger(NotebookLinks.class);

    private final SessionManager sessions;
    private final EventHub hub;
    private final Path socket;
    private final NotebookModule.Service service;
    private final NotebookModule.Timing timing;
    private final ReentrantLock lock = new ReentrantLock();
    private final Map<String, NotebookLink> links = new HashMap<>();
    /** Orders publishing and what a SUB's snapshot reads. Never taken with {@link #lock} the other way round. */
    private final ReentrantLock treeLock = new ReentrantLock();
    private volatile Map<String, Object> lastTree;
    /** Whether the log has said desk-notebook is away, since it last said anything else. */
    private final AtomicBoolean away = new AtomicBoolean();
    /** The Notebook edit budget in force, or null (the default, and every set of links but desk-notebook's on a guild desk). */
    private volatile Supplier<EditBudget> editBudget = () -> null;

    NotebookLinks(SessionManager sessions, EventHub hub, Path socket, NotebookModule.Service service, NotebookModule.Timing timing) {
        this.sessions = sessions;
        this.hub = hub;
        this.socket = socket;
        this.service = service;
        this.timing = timing;
    }

    /**
     * The link of a session, new if it's the session's first use.
     *
     * @throws RpcException {@code unavailable} if the session has ended
     */
    NotebookLink forSession(String sessionId) throws RpcException {
        NotebookLink link = open(sessionId);
        if (link == null) {
            throw NotebookLink.unavailable();
        }
        return link;
    }

    /** @return null if the session has ended */
    NotebookLink open(String sessionId) {
        lock.lock();
        try {
            // A session's end is heard after it has left the live table, and it takes this lock to stop what's here. So
            // either it's found gone now, or its end comes after this and finds the new one.
            Session session = sessions.session(sessionId);
            if (session == null) {
                return null;
            }
            return links.computeIfAbsent(sessionId, id -> new NotebookLink(session, socket, service, timing, this));
        } finally {
            lock.unlock();
        }
    }

    /** The session's link, or null. */
    NotebookLink get(String sessionId) {
        lock.lock();
        try {
            return links.get(sessionId);
        } finally {
            lock.unlock();
        }
    }

    void editBudget(Supplier<EditBudget> source) {
        this.editBudget = source;
    }

    /** The {@code settings} desk-notebook is to have now, {@code {editBudget: {chars, windowMinutes}}}, or null for none. */
    Map<String, Object> settingsNow() {
        EditBudget budget = editBudget.get();
        return budget == null ? null : Map.of("editBudget", budget.toJson());
    }

    /** The budget in force may have changed. Never blocks. */
    void settingsChanged() {
        List<NotebookLink> all;
        lock.lock();
        try {
            all = new ArrayList<>(links.values());
        } finally {
            lock.unlock();
        }
        all.forEach(NotebookLink::settingsChanged);
    }

    /** A refresh changed the session's caller. Never blocks. */
    void callerChanged(String sessionId) {
        NotebookLink link;
        lock.lock();
        try {
            link = links.get(sessionId);
        } finally {
            lock.unlock();
        }
        if (link != null) {
            link.callerChanged();
        }
    }

    /** Never blocks: it can run on the rtc reader. */
    void sessionEnded(String sessionId) {
        NotebookLink link;
        lock.lock();
        try {
            link = links.remove(sessionId);
        } finally {
            lock.unlock();
        }
        if (link != null) {
            link.close();
            treeMayHaveGone();
        }
    }

    /** Brings each session's link into line with whether its client is subscribed. Not on a thread that mustn't wait. */
    void settleTree() {
        for (String sessionId : sessions.sessionIds()) {
            Session session = sessions.session(sessionId);
            if (session == null) {
                continue;
            }
            boolean wanted = session.isSubscribed(NotebookTopic.TREE);
            NotebookLink link;
            if (wanted) {
                link = open(sessionId);
            } else {
                lock.lock();
                try {
                    link = links.get(sessionId);
                } finally {
                    lock.unlock();
                }
            }
            if (link != null) {
                link.wantTree(wanted);
            }
        }
        treeMayHaveGone();
    }

    /** One {@code evt} on a link's tree subscription. Doesn't block: publishing never does. */
    void treeEvent(Map<String, Object> data) {
        treeLock.lock();
        try {
            if (data.equals(lastTree)) {
                return;
            }
            lastTree = data;
            try {
                hub.publish(NotebookTopic.TREE, "snapshot", data);
            } catch (IllegalArgumentException e) {
                log.warn("notebook link: dropped a tree event too large to send");
            }
        } finally {
            treeLock.unlock();
        }
    }

    /** The last {@code {rev}} a link heard, or null if no link is subscribed to keep it current. */
    Map<String, Object> lastTree() {
        return lastTree;
    }

    /** Nothing is keeping the last {@code {rev}} current now, so it's not to be offered as the current one. */
    private void treeMayHaveGone() {
        List<NotebookLink> all;
        lock.lock();
        try {
            all = new ArrayList<>(links.values());
        } finally {
            lock.unlock();
        }
        treeLock.lock();
        try {
            if (all.stream().noneMatch(NotebookLink::treeLive)) {
                lastTree = null;
            }
        } finally {
            treeLock.unlock();
        }
    }

    void connected() {
        if (away.compareAndSet(true, false)) {
            log.info("{} link: {} is back", service.name(), service.peer());
        }
    }

    /** @param why the class of what ended a connection, or null if a try to connect failed. Logged once per absence. */
    void lost(String why) {
        if (away.compareAndSet(false, true)) {
            if (why == null) {
                log.info("{} link: waiting for {}'s socket", service.name(), service.peer());
            } else {
                log.warn("{} link: lost {} ({})", service.name(), service.peer(), why);
            }
        }
        treeMayHaveGone();
    }

    boolean anyConnected() {
        lock.lock();
        try {
            return links.values().stream().anyMatch(NotebookLink::isConnected);
        } finally {
            lock.unlock();
        }
    }

    void closeAll() {
        List<NotebookLink> all;
        lock.lock();
        try {
            all = new ArrayList<>(links.values());
            links.clear();
        } finally {
            lock.unlock();
        }
        all.forEach(NotebookLink::close);
    }

    /** For tests. */
    boolean writingForTest(String sessionId) {
        lock.lock();
        try {
            NotebookLink link = links.get(sessionId);
            return link != null && link.writingForTest();
        } finally {
            lock.unlock();
        }
    }

    /** For tests. */
    int linkCount() {
        lock.lock();
        try {
            return links.size();
        } finally {
            lock.unlock();
        }
    }
}
