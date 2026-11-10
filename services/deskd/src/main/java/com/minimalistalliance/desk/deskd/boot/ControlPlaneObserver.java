package com.minimalistalliance.desk.deskd.boot;

import com.minimalistalliance.desk.deskd.gateway.GatewayLink;
import com.minimalistalliance.desk.deskd.platform.HeartbeatLoop;
import com.minimalistalliance.desk.deskd.session.SessionObserver;

/** Passes what sessions and desk-rtc do on to the control plane. All of it only queues work. */
public final class ControlPlaneObserver implements SessionObserver {

    private final GatewayLink link;
    private final HeartbeatLoop heartbeat;
    private final BootSequence boot;
    private final Runnable sessionsChanged;

    public ControlPlaneObserver(GatewayLink link, HeartbeatLoop heartbeat, BootSequence boot) {
        this(link, heartbeat, boot, () -> {});
    }

    /** @param sessionsChanged runs when a session ends or the number of connected clients may have changed */
    public ControlPlaneObserver(GatewayLink link, HeartbeatLoop heartbeat, BootSequence boot, Runnable sessionsChanged) {
        this.link = link;
        this.heartbeat = heartbeat;
        this.boot = boot;
        this.sessionsChanged = sessionsChanged;
    }

    @Override
    public void onSessionClosed(String sessionId, String reason) {
        link.sessionClosed(sessionId, reason);
        sessionsChanged.run();
    }

    @Override
    public void onOfferRefused(String sessionId, String code) {
        link.offerRefused(sessionId, code);
    }

    @Override
    public void onClientsChanged() {
        heartbeat.clientsChanged();
        sessionsChanged.run();
    }

    @Override
    public void onRtcConfigured() {
        boot.onRtcConfigured();
    }
}
