package com.minimalistalliance.desk.deskd.testing;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** One browser tab as deskd sees it, with its frames passing through a {@link FakeDeskRtc}. */
public final class TestClient {

    private final FakeDeskRtc rtc;
    private final long handle;
    private long nextRequest = 1;

    public TestClient(FakeDeskRtc rtc, long handle) {
        this.rtc = rtc;
        this.handle = handle;
    }

    public long handle() {
        return handle;
    }

    public void send(int channel, FrameKind kind, long id, long seq, byte[] payload) {
        for (byte[] frame : Frame.fragment(kind, 0, id, seq, payload)) {
            rtc.sendData(handle, channel, frame);
        }
    }

    /** One frame with the flags a test names, for a client's CHUNK (BIN) on bulk. */
    public void sendFrame(int channel, FrameKind kind, int flags, long id, long seq, byte[] payload) {
        for (byte[] frame : Frame.fragment(kind, flags, id, seq, payload)) {
            rtc.sendData(handle, channel, frame);
        }
    }

    public void sendJson(int channel, FrameKind kind, long id, Object body) {
        send(channel, kind, id, 0, Json.bytes(body));
    }

    public Frame next(int channel) throws InterruptedException {
        return rtc.awaitFrame(handle, channel);
    }

    /** The next message on the channel, joining fragments. */
    public Map<String, Object> nextJson(int channel, FrameKind expected) throws Exception {
        Frame frame = next(channel);
        assertThat(frame.kind()).isEqualTo(expected);
        byte[] payload = frame.payload();
        while (frame.more()) {
            frame = next(channel);
            byte[] joined = new byte[payload.length + frame.payload().length];
            System.arraycopy(payload, 0, joined, 0, payload.length);
            System.arraycopy(frame.payload(), 0, joined, payload.length, frame.payload().length);
            payload = joined;
        }
        return parse(payload);
    }

    public Map<String, Object> hello(Map<String, Object> resume) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("deskApi", "1.0");
        body.put("appVersion", "test");
        if (resume != null) {
            body.put("resume", resume);
        }
        sendJson(Channels.CTL, FrameKind.HELLO, 0, body);
        return nextJson(Channels.CTL, FrameKind.HELLO);
    }

    public Map<String, Object> hello() throws Exception {
        return hello(null);
    }

    /** The next RES or ERR, with _kind and _id added so a test can check them. */
    public Map<String, Object> nextReply() throws Exception {
        Frame frame = next(Channels.RPC);
        assertThat(frame.kind()).isIn(FrameKind.RES, FrameKind.ERR);
        byte[] payload = frame.payload();
        long id = frame.id();
        FrameKind kind = frame.kind();
        while (frame.more()) {
            frame = next(Channels.RPC);
            byte[] joined = new byte[payload.length + frame.payload().length];
            System.arraycopy(payload, 0, joined, 0, payload.length);
            System.arraycopy(frame.payload(), 0, joined, payload.length, frame.payload().length);
            payload = joined;
        }
        Map<String, Object> reply = new LinkedHashMap<>(parse(payload));
        reply.put("_kind", kind.name());
        reply.put("_id", id);
        return reply;
    }

    /** Sends REQ and waits for its reply. */
    public Map<String, Object> call(String method, Map<String, Object> params) throws Exception {
        long id = nextRequest++;
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("m", method);
        body.put("p", params);
        sendJson(Channels.RPC, FrameKind.REQ, id, body);
        Map<String, Object> reply = nextReply();
        assertThat(reply).containsEntry("_id", id);
        return reply;
    }

    /** Sends SUB and waits for its reply. */
    public Map<String, Object> subscribe(String topic, Long since) throws Exception {
        long id = nextRequest++;
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("topic", topic);
        body.put("params", Map.of());
        if (since != null) {
            body.put("since", since);
        }
        sendJson(Channels.RPC, FrameKind.SUB, id, body);
        Map<String, Object> reply = nextReply();
        assertThat(reply).containsEntry("_id", id);
        return reply;
    }

    public static Map<String, Object> parse(byte[] payload) throws JsonFormatException {
        return Json.parseObject(payload);
    }

    /** An offer as Chrome writes it: one fingerprint line per section. */
    public static String offerFor(String fingerprintHex) {
        StringBuilder colons = new StringBuilder();
        for (int i = 0; i < fingerprintHex.length(); i += 2) {
            if (i > 0) {
                colons.append(':');
            }
            colons.append(fingerprintHex, i, i + 2);
        }
        String line = "a=fingerprint:sha-256 " + colons.toString().toUpperCase(Locale.ROOT) + "\r\n";
        return String.join("", List.of("v=0\r\n", "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n", line, "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n", line));
    }
}
