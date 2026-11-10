package com.minimalistalliance.desk.deskd.rpc;

import java.util.ArrayList;
import java.util.List;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * What a handler knows about the call it's serving. Used only by that call's thread, but for {@link #principal} and
 * {@link #beginEffect}, which a thread the call is waiting on may call: a relay's writer does, right before its bytes go.
 */
public final class RpcContext {

    private final Supplier<RpcPrincipal> principal;
    private final long requestId;
    private final long arrival;
    private final BooleanSupplier beginEffect;
    private final List<Consumer<Boolean>> afterReply = new ArrayList<>(0);

    RpcContext(Supplier<RpcPrincipal> principal, long requestId, long arrival, BooleanSupplier beginEffect) {
        this.principal = principal;
        this.requestId = requestId;
        this.arrival = arrival;
        this.beginEffect = beginEffect;
    }

    /** Who's asking, as of now: a token refresh can change what the session may do while a call runs. */
    public RpcPrincipal principal() {
        return principal.get();
    }

    public long requestId() {
        return requestId;
    }

    /**
     * Rises with each request of a session, in the order they came off the channel. Each call runs on
     * its own thread, so two can reach a handler in the other order, and a handler for which the last
     * word has to win uses this to tell.
     */
    public long arrival() {
        return arrival;
    }

    /**
     * A mutation calls this right before the first thing it can't take back. Before it, a cancel, a
     * deadline or the session ending stops the call, and a retry runs it again. After it, the call runs to
     * its end whatever happens, and a retry gets the result. The client may have stopped waiting by then,
     * but what it asked for has been sent, and sending it twice would be worse.
     *
     * <p>This is also what an error tells the client. Every mutation calls it, because unavailable
     * without it means nothing was done and frees the key, and past it the reply says
     * {@code details.mayHaveApplied} and stays on the key.
     *
     * @throws RpcException cancelled if the call has been stopped, so nothing has been applied
     */
    public void beginEffect() throws RpcException {
        if (!beginEffect.getAsBoolean()) {
            throw new RpcException(RpcException.CANCELLED, "Cancelled");
        }
    }

    /**
     * Runs the task once the reply has been handed to the channel, or dropped because the call was
     * already answered. A subscription's first events go out this way, after its RES.
     */
    public void afterReply(Runnable task) {
        afterReply.add(sent -> task.run());
    }

    /**
     * As {@link #afterReply(Runnable)}, but only one of the two runs: {@code sent} if this call's reply went to the
     * channel, {@code dropped} if a cancel, the deadline or the session's end answered first, or the peer was gone.
     */
    public void afterReply(Runnable sent, Runnable dropped) {
        afterReply.add(wasSent -> (wasSent ? sent : dropped).run());
    }

    void runAfterReply(boolean sent) {
        afterReply.forEach(task -> task.accept(sent));
    }
}
