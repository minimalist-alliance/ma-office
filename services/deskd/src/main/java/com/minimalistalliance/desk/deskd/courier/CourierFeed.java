package com.minimalistalliance.desk.deskd.courier;

import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.Topic;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;

/**
 * The topic {@code courier.changed} (API.md §21): a snapshot of {@code {}} first, then {@code changed} events
 * {@code {channels, lanes, counts, drafts, outbound, accounts}} after any change by any session, a transport or the
 * queue, merged to at most twice a second. Over 50 channels, {@code channels} is null and the client refreshes what it
 * shows. It names ids and lanes only, never a sender, subject or text. Owner only, as Files' {@code files.changes}.
 */
final class CourierFeed implements Topic {

    static final String TOPIC = "courier.changed";
    static final int MAX_CHANNELS = 50;
    static final long MERGE_MS = 500;

    private final EventHub hub;
    private final ScheduledExecutorService timer;
    private final Supplier<RpcException> refusal;
    private final ReentrantLock lock = new ReentrantLock();
    private final Set<String> channels = new LinkedHashSet<>();
    private final Set<String> lanes = new LinkedHashSet<>();
    private boolean overflow;
    private boolean counts;
    private boolean drafts;
    private boolean outbound;
    private boolean accounts;
    private boolean scheduled;
    private long lastSent = Long.MIN_VALUE;
    private boolean closed;

    /** @param refusal why a SUB is refused now (Courier off, a teen's desk), or null */
    CourierFeed(EventHub hub, ScheduledExecutorService timer, Supplier<RpcException> refusal) {
        this.hub = hub;
        this.timer = timer;
        this.refusal = refusal;
    }

    @Override
    public boolean coalescible() {
        return true;
    }

    @Override
    public boolean publishesWithNoSubscriber() {
        return false;
    }

    @Override
    public Object snapshot(String topicKey, Map<String, Object> params) {
        return Map.of();
    }

    @Override
    public void authorize(RpcPrincipal principal, String topicKey, Map<String, Object> params) throws RpcException {
        if (!RpcPrincipal.OWNER.equals(principal.scope())) {
            throw new RpcException(RpcException.FORBIDDEN, "Not this session's", Map.of("reason", "scope"));
        }
        RpcException no = refusal.get();
        if (no != null) {
            throw no;
        }
    }

    /** From the store's listener, after a commit: only queues. */
    void changed(Courier.Change change) {
        lock.lock();
        try {
            for (String c : change.channels()) {
                if (channels.size() >= MAX_CHANNELS) {
                    overflow = true;
                    break;
                }
                channels.add(c);
            }
            lanes.addAll(change.lanes());
            counts |= change.counts();
            drafts |= change.drafts();
            outbound |= change.outbound();
            accounts |= change.accounts();
            arm();
        } finally {
            lock.unlock();
        }
    }

    void close() {
        lock.lock();
        try {
            closed = true;
        } finally {
            lock.unlock();
        }
    }

    private void arm() {
        if (scheduled || closed) {
            return;
        }
        scheduled = true;
        long now = System.nanoTime();
        long wait = lastSent == Long.MIN_VALUE ? 0 : Math.max(0, MERGE_MS - TimeUnit.NANOSECONDS.toMillis(now - lastSent));
        try {
            timer.schedule(this::flush, wait, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException e) {
            scheduled = false;
        }
    }

    void flush() {
        Map<String, Object> data = new LinkedHashMap<>();
        lock.lock();
        try {
            scheduled = false;
            lastSent = System.nanoTime();
            if (channels.isEmpty() && lanes.isEmpty() && !overflow && !counts && !drafts && !outbound && !accounts) {
                return;
            }
            List<String> sendChannels = new ArrayList<>(channels);
            data.put("channels", overflow ? null : sendChannels);
            data.put("lanes", new ArrayList<>(lanes));
            data.put("counts", counts);
            data.put("drafts", drafts);
            data.put("outbound", outbound);
            data.put("accounts", accounts);
            channels.clear();
            lanes.clear();
            overflow = counts = drafts = outbound = accounts = false;
        } finally {
            lock.unlock();
        }
        hub.publish(TOPIC, "changed", data);
    }
}
