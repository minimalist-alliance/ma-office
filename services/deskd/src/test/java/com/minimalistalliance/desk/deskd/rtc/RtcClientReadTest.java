package com.minimalistalliance.desk.deskd.rtc;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * {@code rtc.sock}'s read buffer lives as long as the connection, so the bytes of an envelope already handled mustn't
 * stay in it: an {@code agent.key.add} key would wait there until a long enough envelope covered it (ISS-20).
 */
class RtcClientReadTest {

    /** A fake key, built at run time so no class file or source holds the marker. */
    private static final String MARKER = new StringBuilder("rekram-arbez").reverse().toString();
    private static final byte[] KEY_REQUEST = ("{\"m\":\"agent.key.add\",\"idem\":\"i1\",\"p\":{\"provider\":\"anthropic\","
            + "\"secret\":\"sk-ant-api03-FAKE-" + MARKER + "-0042\"}}").getBytes(StandardCharsets.US_ASCII);

    private final ByteBuffer in = ByteBuffer.allocateDirect(RtcEnvelope.LENGTH_BYTES + RtcEnvelope.MAX_LENGTH);
    private final List<Integer> handled = new ArrayList<>();

    @Test
    void aKeysEnvelopeLeavesNothingOfTheKeyOnceAShorterOneFollows() throws Exception {
        read(data(KEY_REQUEST));
        read(RtcEnvelope.json("{\"t\":\"x\"}".getBytes(StandardCharsets.US_ASCII)));
        assertThat(handled).containsExactly(RtcEnvelope.TYPE_DATA, RtcEnvelope.TYPE_JSON);
        assertThat(new String(everything(), StandardCharsets.ISO_8859_1)).doesNotContain(MARKER);
        assertThat(everything()).containsOnly((byte) 0);
    }

    @Test
    void aPartialEnvelopeStaysAtTheFrontAndOnlyWhatWasHandledIsZeroed() throws Exception {
        byte[] next = RtcEnvelope.json("{\"t\":\"session.closed\",\"sessionId\":\"s1\"}".getBytes(StandardCharsets.US_ASCII));
        byte[] first = concat(data(KEY_REQUEST), Arrays.copyOf(next, 7));
        read(first);
        assertThat(handled).containsExactly(RtcEnvelope.TYPE_DATA);
        assertThat(in.position()).isEqualTo(7);
        byte[] all = everything();
        assertThat(Arrays.copyOf(all, 7)).isEqualTo(Arrays.copyOf(next, 7));
        assertThat(Arrays.copyOfRange(all, 7, all.length)).containsOnly((byte) 0);

        read(Arrays.copyOfRange(next, 7, next.length));
        assertThat(handled).containsExactly(RtcEnvelope.TYPE_DATA, RtcEnvelope.TYPE_JSON);
        assertThat(everything()).containsOnly((byte) 0);
    }

    /** As {@code readLoop} does with what one read brought: append, flip, drain. */
    private void read(byte[] bytes) throws Exception {
        in.put(bytes);
        in.flip();
        RtcClient.drain(in, (type, envelope, end) -> {
            handled.add(type);
            byte[] body = new byte[end - envelope.position()];
            envelope.get(body);
        });
    }

    /** A DATA envelope for handle 7, channel 1, holding {@code frame}. */
    private static byte[] data(byte[] frame) {
        ByteBuffer out = ByteBuffer.allocate(RtcEnvelope.LENGTH_BYTES + RtcEnvelope.DATA_PREFIX_BYTES + frame.length);
        out.putInt(RtcEnvelope.DATA_PREFIX_BYTES + frame.length).put((byte) RtcEnvelope.TYPE_DATA).putInt(7)
                .put((byte) 1).put(frame);
        return out.array();
    }

    private static byte[] concat(byte[] a, byte[] b) {
        byte[] both = Arrays.copyOf(a, a.length + b.length);
        System.arraycopy(b, 0, both, a.length, b.length);
        return both;
    }

    /** The whole buffer, to its capacity. */
    private byte[] everything() {
        byte[] all = new byte[in.capacity()];
        in.duplicate().clear().get(all);
        return all;
    }
}
