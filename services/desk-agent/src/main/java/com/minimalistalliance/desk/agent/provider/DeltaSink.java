package com.minimalistalliance.desk.agent.provider;

/**
 * Where a streaming provider puts text as it arrives, for the thread's live view (design 9.1, budget B6). Called on
 * the provider's own thread, in order. It must only queue: a slow sink would hold up the read of the stream.
 */
@FunctionalInterface
public interface DeltaSink {

    DeltaSink NONE = text -> {};

    void delta(String text);
}
