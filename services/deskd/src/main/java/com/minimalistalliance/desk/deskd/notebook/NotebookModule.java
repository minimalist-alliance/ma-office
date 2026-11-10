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
 * <p>Nothing here runs until a session uses it: no thread, no timer and no connection. A problem here never fails
 * {@code /health} and never touches anything else: a stalled or absent desk-notebook costs its own session's calls and
 * {@code collab}, and only that (see {@link NotebookLink}).
 */
public final class NotebookModule implements SessionListener {

    /**
     * @param minBackoff the shortest gap between tries to connect, and the first after a connection goes
     * @param maxBackoff the longest gap, which a subscription waiting on a desk-notebook that's away backs off to
     * @param call how long a call waits for desk-notebook's answer
     * @param writeStall how long a write may go with no progress before the link goes
     * @param clientStall how long a client that has stopped reading {@code collab} may hold a message back before the link
     *     goes, so that desk-notebook doesn't keep buffering for it
     */
    public record Timing(Duration minBackoff, Duration maxBackoff, Duration call, Duration writeStall, Duration clientStall) {
        public static final Timing DEFAULT =
                new Timing(Duration.ofMillis(250), Duration.ofSeconds(5), Duration.ofSeconds(10), Duration.ofSeconds(5), Duration.ofSeconds(30));
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

    /** Registers the methods, the topic and the channel. Connects to nothing yet. */
    public NotebookModule(Path socket, SessionManager sessions, RpcDispatcher dispatcher, EventHub hub, Timing timing) {
        this.links = new NotebookLinks(sessions, hub, socket, Service.NOTEBOOK, timing);
        new NotebookMethods(links).register(dispatcher);
        hub.topics().register(NotebookTopic.TREE, new NotebookTopic(links));
        sessions.registerChannelHandler(Channels.COLLAB, new CollabChannel(links));
        sessions.addSessionListener(this);
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
        return Map.of("notebook", links.anyConnected() ? "connected" : "waiting");
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
