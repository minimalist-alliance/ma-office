package com.minimalistalliance.desk.deskd.rpc;

import java.util.Map;

/** Serves SUB and UNSUB. They share the limits and reply shape of requests. */
public interface SubscriptionService {

    /** @param request the SUB payload: {topic, params, since?} */
    Object subscribe(RpcContext context, Map<String, Object> request) throws RpcException;

    /** @param request the UNSUB payload: {subId} */
    Object unsubscribe(RpcContext context, Map<String, Object> request) throws RpcException;
}
