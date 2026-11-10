package com.minimalistalliance.desk.deskd.platform;

/** What Platform can ask for, through a heartbeat response or a gateway notify. None of these block. */
public interface PlatformActions {

    /** @param reason hello's reason: requested after hello_required */
    void requestHello(String reason);

    void requestConfig();

    void requestHeartbeat();
}
