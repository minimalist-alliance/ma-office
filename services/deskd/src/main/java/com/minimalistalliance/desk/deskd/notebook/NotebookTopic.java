package com.minimalistalliance.desk.deskd.notebook;

import com.minimalistalliance.desk.deskd.events.Topic;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The topic {@code notebook.tree}: each event is {@code {rev}}, so a client knows when to fetch the tree again.
 *
 * <p>A SUB gets the last {@code {rev}} a link heard. With none yet it gets no first event until one comes, which is
 * what a session's new link asks for first, so that's only a moment unless desk-notebook is away. It's coalescible, as
 * {@code {rev}} is the whole state, and serves no {@code since}, as nothing keeps up while nobody's subscribed.
 */
final class NotebookTopic implements Topic {

    static final String TREE = "notebook.tree";

    private final NotebookLinks links;
    private final AtomicBoolean settleQueued = new AtomicBoolean();

    NotebookTopic(NotebookLinks links) {
        this.links = links;
    }

    @Override
    public boolean coalescible() {
        return true;
    }

    @Override
    public boolean publishesWithNoSubscriber() {
        return false;
    }

    /** One tree for the whole guild, as every member sees every space (draft section 5). */
    @Override
    public boolean forGuildMembers() {
        return true;
    }

    @Override
    public void authorize(RpcPrincipal principal, String topicKey, Map<String, Object> params) throws RpcException {
        if (!RpcPrincipal.OWNER.equals(principal.scope()) && !principal.isGuildMember()) {
            throw NotebookMethods.forbidden();
        }
    }

    @Override
    public Object snapshot(String topicKey, Map<String, Object> params) {
        Map<String, Object> last = links.lastTree();
        return last == null ? NO_SNAPSHOT : last;
    }

    /** This opens a session's link at its first SUB, and that takes locks, so it happens on a thread of its own. */
    @Override
    public void subscribersChanged() {
        if (settleQueued.compareAndSet(false, true)) {
            Thread.ofVirtual().name("notebook-topic").start(() -> {
                settleQueued.set(false);
                links.settleTree();
            });
        }
    }
}
