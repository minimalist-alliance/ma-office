package com.minimalistalliance.desk.deskd.rpc;

import java.util.Map;

/** For tests in other packages: one registered method's handler run as the desk's owner, with no session or idem. */
public final class RpcTestCalls {

    private RpcTestCalls() {}

    public static Object call(RpcDispatcher dispatcher, String method, Map<String, Object> params) throws Exception {
        return call(dispatcher, method, params, RpcPrincipal.OWNER);
    }

    public static Object call(RpcDispatcher dispatcher, String method, Map<String, Object> params, String scope) throws Exception {
        RpcDispatcher.Method m = dispatcher.method(method);
        if (m == null) {
            throw new RpcException(RpcException.NOT_FOUND, "No such method", Map.of());
        }
        if (!m.scopes().contains(scope)) {
            throw new RpcException(RpcException.FORBIDDEN, "Not this scope's", Map.of("reason", "scope"));
        }
        RpcContext context = new RpcContext(() -> new RpcPrincipal("member-1", scope, "s-1", true, true), 1, 0, () -> true);
        return m.handler().handle(context, new java.util.LinkedHashMap<>(params));
    }

    public static boolean registered(RpcDispatcher dispatcher, String method) {
        return dispatcher.method(method) != null;
    }
}
