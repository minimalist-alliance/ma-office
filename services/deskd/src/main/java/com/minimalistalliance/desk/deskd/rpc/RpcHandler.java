package com.minimalistalliance.desk.deskd.rpc;

import java.util.Map;

/**
 * One RPC method. Each call runs on its own virtual thread, so it may block. It should stop when
 * interrupted, which is how cancel and deadlines reach it.
 */
@FunctionalInterface
public interface RpcHandler {

    /**
     * @param params the request's p, empty if absent
     * @return the RES body: a Map, List, String, Number, Boolean, or null for an empty object
     * @throws RpcException for an error the client should see
     * @throws Exception anything else becomes {@code internal}, and its text never leaves deskd
     */
    Object handle(RpcContext context, Map<String, Object> params) throws Exception;
}
