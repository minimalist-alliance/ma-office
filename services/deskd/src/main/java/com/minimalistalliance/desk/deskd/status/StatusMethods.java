package com.minimalistalliance.desk.deskd.status;

import com.minimalistalliance.desk.deskd.rpc.RpcContext;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/** The skeleton RPC of desk-runtime.md section 7. deskctl and the Desk app both call it. */
public final class StatusMethods {

    public static final String STATUS_GET = "desk.status.get";

    private final DeskFacts facts;
    private final RtcClient rtc;
    private final String version;
    private final long startNanos;

    public StatusMethods(DeskFacts facts, RtcClient rtc, String version, long startNanos) {
        this.facts = facts;
        this.rtc = rtc;
        this.version = version;
        this.startNanos = startNanos;
    }

    /** An export session may ask too: it's what tells the transfer script which desk it reached. */
    public void register(RpcDispatcher dispatcher) {
        dispatcher.register(STATUS_GET, RpcDispatcher.OWNER_OR_EXPORT, this::statusGet);
    }

    private Object statusGet(RpcContext context, Map<String, Object> params) {
        Map<String, Object> status = new LinkedHashMap<>();
        status.put("deskId", facts.deskId());
        status.put("deskdVersion", version);
        status.put("rtcVersion", rtc.rtcVersion());
        status.put("bootId", facts.bootId());
        status.put("uptimeSec", TimeUnit.NANOSECONDS.toSeconds(System.nanoTime() - startNanos));
        status.put("javaVersion", System.getProperty("java.version"));
        status.put("instanceType", facts.instanceType());
        return status;
    }
}
