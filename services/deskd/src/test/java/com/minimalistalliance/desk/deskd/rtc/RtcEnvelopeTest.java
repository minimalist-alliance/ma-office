package com.minimalistalliance.desk.deskd.rtc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.HexFormat;
import org.junit.jupiter.api.Test;

/** The bytes of desk-runtime.md 4.2, spelled out. */
class RtcEnvelopeTest {

    private static String hex(byte[] bytes) {
        return HexFormat.of().formatHex(bytes);
    }

    @Test
    void jsonEnvelope() {
        byte[] envelope = RtcEnvelope.json("{}".getBytes(StandardCharsets.UTF_8));
        assertThat(hex(envelope)).isEqualTo("00000003" + "01" + "7b7d");
    }

    @Test
    void creditEnvelope() {
        assertThat(hex(RtcEnvelope.credit(0x01020304L, 5, 0x00040000L)))
                .isEqualTo("0000000a" + "03" + "01020304" + "05" + "00040000");
    }

    @Test
    void dataEnvelopeCarriesTheFrameUnchanged() {
        byte[] frame = HexFormat.of().parseHex("010400000000002a00000000");
        ByteBuffer out = ByteBuffer.allocate(RtcEnvelope.dataEnvelopeBytes(frame));
        RtcEnvelope.putData(out, 7, 0, frame);
        assertThat(hex(out.array())).isEqualTo("00000012" + "02" + "00000007" + "00" + "010400000000002a00000000");
    }

    @Test
    void theConnectionNumberInAHandleStaysOffTheWire() {
        long handle = (3L << 32) | 7;
        assertThat(hex(RtcEnvelope.credit(handle, 1, 1))).isEqualTo("0000000a" + "03" + "00000007" + "01" + "00000001");
    }

    @Test
    void jsonOver64KibIsRefused() {
        assertThat(RtcEnvelope.json(new byte[RtcEnvelope.MAX_LENGTH - 1])).hasSize(4 + RtcEnvelope.MAX_LENGTH);
        assertThatThrownBy(() -> RtcEnvelope.json(new byte[RtcEnvelope.MAX_LENGTH]))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
