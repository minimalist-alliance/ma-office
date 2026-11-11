package com.minimalistalliance.desk.deskd.notebook;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.platform.EditBudget;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.session.SessionListener;
import com.minimalistalliance.desk.deskd.session.SessionManager;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.function.Supplier;

/**
 * deskd's relay to desk-notebook, the service that stores and syncs Notebook pages (API.md section 13): the
 * {@code notebook.*} methods, the {@code notebook.tree} topic and the {@code collab} channel. deskd checks the session
 * and relays. It reads and keeps no note content: desk-notebook is the only thing that touches {@code /data/notebook}.
 *
 * <p>Nothing here runs until a session uses it: no thread, no timer and no connection, apart from {@link #storage}, a
 * short connection of its own that the heartbeat and {@code /health} make at most every 10 s. A problem here never fails
 * {@code /health} and never touches anything else: a stalled or absent desk-notebook costs its own session's calls and
 * {@code collab}, and only that (see {@link NotebookLink}), and at most a second of a heartbeat's time; {@code /health}
 * never waits on it.
 */
public final class NotebookModule implements SessionListener {

    /**
     * @param minBackoff the shortest gap between tries to connect, and the first after a connection goes
     * @param maxBackoff the longest gap, which a subscription waiting on a desk-notebook that's away backs off to
     * @param call how long a call waits for desk-notebook's answer
     * @param writeStall how long a write may go with no progress before the link goes
     * @param clientStall how long a client that has stopped reading {@code collab} may hold a message back before the link
     *     goes, so that desk-notebook doesn't keep buffering for it
     * @param healthyAfter a connection that lasted this long starts the backoff again; a shorter one doubles it, so a peer
     *     that accepts and drops at once is tried with the backoff, not four times a second (audit D7)
     */
    public record Timing(
            Duration minBackoff, Duration maxBackoff, Duration call, Duration writeStall, Duration clientStall, Duration healthyAfter) {
        public static final Duration HEALTHY_AFTER = Duration.ofSeconds(10);
        public static final Timing DEFAULT = new Timing(
                Duration.ofMillis(250), Duration.ofSeconds(5), Duration.ofSeconds(10), Duration.ofSeconds(5), Duration.ofSeconds(30), HEALTHY_AFTER);

        public Timing(Duration minBackoff, Duration maxBackoff, Duration call, Duration writeStall, Duration clientStall) {
            this(minBackoff, maxBackoff, call, writeStall, clientStall, HEALTHY_AFTER);
        }
    }

    /**
     * Which service a set of links reaches: desk-notebook, or Commons on a guild desk ({@link CommonsRelay}), which speak
     * the same framing.
     *
     * @param name for thread names and logs
     * @param peer the service's name, for logs
     * @param channel where its messages go to the client: collab, or 4 for Commons
     */
    record Service(String name, String peer, int channel) {
        static final Service NOTEBOOK = new Service("notebook", "desk-notebook", Channels.COLLAB);
        static final Service COMMONS = new Service("commons", "Commons", Channels.MDOC);
    }

    private final NotebookLinks links;
    private final NotebookStorage storage;
    private final NotebookCalls calls;

    /** Registers the methods, the topic and the channel. Connects to nothing yet. */
    public NotebookModule(Path socket, SessionManager sessions, RpcDispatcher dispatcher, EventHub hub, Timing timing) {
        this.links = new NotebookLinks(sessions, hub, socket, Service.NOTEBOOK, timing);
        this.storage = new NotebookStorage(socket);
        // The Agent's Notebook tools: deskd's own calls, with the edit budget a session's hello would carry.
        this.calls = new NotebookCalls(socket, links::settingsNow, timing.call());
        new NotebookMethods(links).register(dispatcher);
        hub.topics().register(NotebookTopic.TREE, new NotebookTopic(links));
        sessions.registerChannelHandler(Channels.COLLAB, new CollabChannel(links));
        sessions.addSessionListener(this);
    }

    /**
     * deskd's own calls to desk-notebook as a caller it names, for the Agent's Notebook tools ({@code tools.NotebookTools}).
     * Nothing a client sends reaches them.
     */
    public NotebookCalls calls() {
        return calls;
    }

    /** Never blocks: closing a link waits for nothing. */
    @Override
    public void onSessionEnded(String sessionId) {
        links.sessionEnded(sessionId);
    }

    /** desk-notebook hears the new caller on the session's connection, before anything else it sends. */
    @Override
    public void onCallerChanged(String sessionId) {
        links.callerChanged(sessionId);
    }

    /**
     * Where the Notebook edit budget comes from, on a guild desk (API.md section 15): sent to desk-notebook in each
     * connection's hello as {@code settings: {editBudget}}. The source returns null on any other desk, which sends nothing.
     */
    public void editBudget(Supplier<EditBudget> source) {
        links.editBudget(source);
    }

    /** The budget in force may have changed: each connection that hasn't heard the current one hears it. Never blocks. */
    public void editBudgetChanged() {
        links.settingsChanged();
    }

    /**
     * What {@code /health} adds, for information only. {@code connected} says some session has a connection now, as
     * connections are per session, so {@code waiting} is also what a desk says while no session is using Notebook.
     */
    public Map<String, Object> health() {
        Map<String, Object> health = new java.util.LinkedHashMap<>();
        health.put("notebook", links.anyConnected() ? "connected" : "waiting");
        // What the last read found, never waiting: /health has 2 s in all, and a rollout reads it.
        health.put("notebookStorage", storage.lastRead());
        return health;
    }

    /**
     * desk-notebook's storage state, from its health frame: {@code {state: "ok" | "degraded", unsavedPages, unsavedBytes,
     * refusing, degradedSeconds}}, counts and the state only. Read at most every 10 s, waiting at most a second: for the
     * heartbeat. {@link #health} shows the last read and never waits.
     *
     * @return null if desk-notebook isn't there, didn't answer, or is a build that doesn't say
     */
    public Map<String, Object> storage() {
        try {
            return storage.read();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return storage.lastRead();
        }
    }

    /** Never waits, whatever desk-notebook is doing. */
    public void close() {
        links.closeAll();
    }

    /** For tests. */
    boolean writingForTest(String sessionId) {
        return links.writingForTest(sessionId);
    }

    /** For tests. */
    int linkCount() {
        return links.linkCount();
    }
}
