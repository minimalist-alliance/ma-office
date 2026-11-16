package com.minimalistalliance.desk.deskd.courier.relay;

import com.minimalistalliance.desk.deskd.courier.store.Courier;
import java.util.Map;

/**
 * Where the drain hands a paired device's envelopes (kind {@code device}; ma-platform {@code relay.md} 0.4.3): MA Connector
 * for Mac's pages and answers, sealed to this desk and signed by the device. The one drain of the relay collects them with
 * the rest, so one ack path and one badge count still hold; what's in them is the device path's to read
 * ({@code courier.imsg.connector}).
 */
public interface DeviceInbox {

    /** What to do with the envelope. */
    enum Outcome {
        /** Handled for good (stored with its place, refused, or applied): ack it. */
        ACK,
        /** Not now (a drop's link not issued today, the sandbox down, the switch off): the next drain sees it again. */
        WAIT
    }

    /** Whether a device is paired here: the drain then runs even when the desk has no address of its own. */
    boolean any();

    /**
     * One envelope of kind {@code device}, as the relay listed it ({@code id, kind, to, enc, ct, drops}). Must not throw for
     * a bad envelope: anything that can't be read is refused ({@link Outcome#ACK}).
     */
    Outcome take(String relayId, Map<String, Object> envelope, Courier.Origin origin) throws InterruptedException;

    /** {@code notify relay {reason: devices}}: a device was removed by the member or by itself. */
    void devicesChanged();
}
