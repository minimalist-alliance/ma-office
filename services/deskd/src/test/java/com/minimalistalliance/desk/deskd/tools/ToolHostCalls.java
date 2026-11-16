package com.minimalistalliance.desk.deskd.tools;

import java.util.Map;

/** For tests in other packages: a {@code tcall} through {@link ToolHost} as desk-agent's socket hands it one. */
public final class ToolHostCalls {

    private ToolHostCalls() {}

    public static Map<String, Object> handle(ToolHost host, Map<String, Object> message) {
        return host.handle(message);
    }

    /** By the call's key, as the socket's calls go: a kept reply, or the call run once. */
    public static Map<String, Object> keyed(ToolHost host, Map<String, Object> message) {
        return host.keyed(message);
    }
}
