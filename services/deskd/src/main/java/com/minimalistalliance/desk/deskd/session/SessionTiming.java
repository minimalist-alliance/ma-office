package com.minimalistalliance.desk.deskd.session;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import java.util.concurrent.atomic.AtomicBoolean;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * What deskd spent on one session, as one INFO line, so a real run can tell deskd's share of B14 from the
 * gateway's Lambda, ICE, DTLS and SCTP. It's monotonic stamps and nothing else, and the line says nothing
 * about who the session belongs to.
 *
 * <p>The spans, all in whole milliseconds, with {@code -} for one that never finished:
 * <ul>
 *   <li>{@code openMs}: session.open read off the gateway link, to accept or reject written to it. Token
 *       verification is in here, and a JWKS fetch if one was needed.
 *   <li>{@code offerMs}: the offer read off the link, to session.create handed to {@code RtcClient}.
 *   <li>{@code createMs}: session.create handed over, to session.answer read off rtc.sock. Mostly desk-rtc.
 *   <li>{@code connectMs}: the answer written to the link, to the first HELLO read off rtc.sock. Not deskd's:
 *       this is the gateway, the client, ICE, DTLS and SCTP.
 *   <li>{@code helloMs}: that HELLO read, to its reply handed to {@code RtcClient}.
 *   <li>{@code firstRpcMs}: the first request on rpc read, to its reply handed to {@code RtcClient}.
 * </ul>
 *
 * <p>The line goes out after the first RPC's reply, or when the session ends if that comes first. A message
 * that was never written to the gateway, as when the link drops at that moment, leaves its span at {@code -}.
 * {@code first} says no earlier session of this process got past session.open, so that's the one that paid for
 * everything still cold.
 */
final class SessionTiming {

    private static final Logger log = LoggerFactory.getLogger(SessionTiming.class);

    private static final long UNSET = Long.MIN_VALUE;
    private static final long NANOS_PER_MILLI = 1_000_000;
    /** Where a frame keeps its kind: Frame's ver, then kind. */
    private static final int KIND_OFFSET = 1;

    private final long openReceived;
    private final AtomicBoolean logged = new AtomicBoolean();
    private volatile boolean first;
    private volatile long openAnswered = UNSET;
    private volatile long offerReceived = UNSET;
    private volatile long createSent = UNSET;
    private volatile long answerReceived = UNSET;
    private volatile long answerSent = UNSET;
    private volatile long helloReceived = UNSET;
    private volatile long helloReplied = UNSET;
    private volatile long rpcReceived = UNSET;
    private volatile long rpcReplied = UNSET;
    private volatile long rpcId = -1;

    SessionTiming(long openReceived) {
        this.openReceived = openReceived;
    }

    /** A session.open that was refused has no session to hang this on, so it's said at once. */
    static void logRefused(boolean first, long openReceived) {
        log.info(
                "session timing first={} result=rejected openMs={}",
                first,
                span(openReceived, System.nanoTime()));
    }

    void first(boolean value) {
        first = value;
    }

    void openAnswered() {
        openAnswered = System.nanoTime();
    }

    /** Only the first offer: an ICE restart isn't what this is about. */
    void offerReceived(long at) {
        if (offerReceived == UNSET) {
            offerReceived = at;
        }
    }

    void createSent() {
        if (createSent == UNSET) {
            createSent = System.nanoTime();
        }
    }

    /** From the rtc reader, as each answer repeats the handle. */
    void answerReceived() {
        if (answerReceived == UNSET) {
            answerReceived = System.nanoTime();
        }
    }

    void answerSent() {
        if (answerSent == UNSET) {
            answerSent = System.nanoTime();
        }
    }

    /** From the rtc reader, so as soon as deskd knows. Must stay this cheap: it runs for every frame. */
    void frameArrived(int channel, byte[] frame) {
        if (channel == Channels.CTL) {
            if (helloReceived == UNSET && frame.length > KIND_OFFSET && frame[KIND_OFFSET] == FrameKind.HELLO.code()) {
                helloReceived = System.nanoTime();
            }
        } else if (channel == Channels.RPC && rpcReceived == UNSET) {
            rpcReceived = System.nanoTime();
        }
    }

    void helloReplied() {
        if (helloReplied == UNSET) {
            helloReplied = System.nanoTime();
        }
    }

    /** On the rpc lane, before the request can get a reply. A CANCEL has no reply to wait for. */
    void requestRead(FrameKind kind, long id) {
        if (rpcId < 0 && kind.isRequest()) {
            rpcId = id;
        }
    }

    /** A reply went to the channel. If it's the first request's, this session has said all it will. */
    void replied(long id) {
        if (id == rpcId && rpcReplied == UNSET) {
            rpcReplied = System.nanoTime();
            logOnce("ok");
        }
    }

    void sessionEnded() {
        logOnce("ended");
    }

    private void logOnce(String result) {
        if (!logged.compareAndSet(false, true)) {
            return;
        }
        log.info(
                "session timing first={} result={} openMs={} offerMs={} createMs={} connectMs={} helloMs={} firstRpcMs={}",
                first,
                result,
                span(openReceived, openAnswered),
                span(offerReceived, createSent),
                span(createSent, answerReceived),
                span(answerSent, helloReceived),
                span(helloReceived, helloReplied),
                span(rpcReceived, rpcReplied));
    }

    private static String span(long from, long to) {
        // A span that ran backwards is two threads a moment apart, not a measurement.
        return from == UNSET || to == UNSET ? "-" : Long.toString(Math.max(0, to - from) / NANOS_PER_MILLI);
    }
}
