package com.minimalistalliance.desk.agent.measure;

import com.minimalistalliance.desk.agent.testing.FakeLlmServer;

/** Not a test: the provider stand-in in a JVM of its own, so a probe's memory is desk-agent's alone. Prints its URL. */
public final class StandIn {

    public static void main(String[] args) throws Exception {
        FakeLlmServer server = new FakeLlmServer();
        System.out.println(server.url());
        System.out.flush();
        Thread.sleep(Long.MAX_VALUE);
    }
}
