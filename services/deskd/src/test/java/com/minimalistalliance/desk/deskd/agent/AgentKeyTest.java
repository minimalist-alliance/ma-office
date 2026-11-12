package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.WritableByteChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

/**
 * {@code agent.key.add}'s key in deskd: zeroed once its call is over, sent or not, never in the log, and written to
 * desk-agent from a direct buffer of the link's own, zeroed after, so NIO keeps no copy of it (ISS-20).
 */
@ExtendWith(OutputCaptureExtension.class)
class AgentKeyTest {

    private static final String MARKER = "zebra-marker";
    private static final String SECRET = "sk-ant-api03-" + MARKER + "-key-0042";

    @TempDir
    Path dir;

    private AgentRig rig;
    private AgentRig away;

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            rig.close();
        }
        if (away != null) {
            away.close();
        }
    }

    @Test
    void theCallersBytesAreZeroedSentOrNot() throws Exception {
        AgentLink nowhere = new AgentLink(dir.resolve("nobody.sock"), AgentRig.FAST);
        byte[] unsent = SECRET.getBytes(StandardCharsets.US_ASCII);
        assertThatThrownBy(() -> nowhere.callWithKey(AgentMethods.KEY_ADD, Map.of(), unsent, Duration.ofSeconds(1), null, null))
                .isInstanceOf(RpcException.class);
        assertThat(unsent).containsOnly((byte) 0);
        nowhere.close();

        rig = new AgentRig(Files.createDirectories(dir.resolve("up")));
        rig.agent.handlers.put(AgentMethods.KEY_ADD, head -> Map.of("key", Map.of("keyId", "k1")));
        byte[] sent = SECRET.getBytes(StandardCharsets.US_ASCII);
        rig.module.link().callWithKey(AgentMethods.KEY_ADD, Map.of("provider", "anthropic"), sent, Duration.ofSeconds(3), null, null);
        assertThat(new String(rig.agent.keys.take().key(), StandardCharsets.US_ASCII)).isEqualTo(SECRET);
        assertThat(sent).containsOnly((byte) 0);
    }

    @Test
    void theKeyIsNeverLogged(CapturedOutput output) throws Exception {
        rig = new AgentRig(Files.createDirectories(dir.resolve("up")));
        rig.agent.handlers.put(AgentMethods.KEY_ADD, head -> Map.of("key", Map.of("keyId", "k1")));
        TestClient client = rig.connect("a");
        Map<String, Object> ok = Map.of("provider", "anthropic", "label", "Main", "secret", SECRET);
        assertThat(rig.call(client, AgentMethods.KEY_ADD, ok)).containsEntry("_kind", "RES");
        Map<String, Object> malformed = Map.of("provider", "anthropic", "label", "Main", "secret", SECRET + " é");
        assertThat(rig.call(client, AgentMethods.KEY_ADD, malformed)).containsEntry("code", "bad_request");

        away = new AgentRig(Files.createDirectories(dir.resolve("away")), false);
        TestClient lonely = away.connect("b");
        assertThat(away.call(lonely, AgentMethods.KEY_ADD, ok)).containsEntry("code", "unavailable");

        assertThat(output.getAll()).doesNotContain(MARKER);
    }

    @Test
    void aFrameGoesFromTheWritersOwnDirectBufferWhichIsZeroedAfter() throws Exception {
        byte[] frame = keyFrame();
        ByteBuffer out = ByteBuffer.allocateDirect(16);
        Recording channel = new Recording(7, Integer.MAX_VALUE);
        int[] progress = {0};
        AgentLink.writeThrough(channel, frame, out, () -> progress[0]++);
        assertThat(channel.received.toByteArray()).isEqualTo(frame);
        // Every write NIO saw was from a direct buffer, which it writes in place: no temporary copy of its own.
        assertThat(channel.direct).isNotEmpty().containsOnly(true);
        assertThat(progress[0]).isEqualTo(channel.direct.size());
        assertThat(bytesOf(out)).containsOnly((byte) 0);
    }

    @Test
    void aWriteThatFailsHalfwayStillLeavesTheBufferZeroed() {
        byte[] frame = keyFrame();
        ByteBuffer out = ByteBuffer.allocateDirect(frame.length);
        Recording channel = new Recording(5, frame.length - 10);
        assertThatThrownBy(() -> AgentLink.writeThrough(channel, frame, out, () -> {})).isInstanceOf(IOException.class);
        assertThat(channel.received.size()).isLessThan(frame.length);
        assertThat(bytesOf(out)).containsOnly((byte) 0);
    }

    /** A KEY frame as {@link AgentLink#callWithKey} builds it, with the fake key last, where a shorter write wouldn't reach. */
    private static byte[] keyFrame() {
        byte[] head = "{\"m\":\"agent.key.add\",\"p\":{}}".getBytes(StandardCharsets.UTF_8);
        byte[] key = SECRET.getBytes(StandardCharsets.US_ASCII);
        ByteBuffer frame = ByteBuffer.allocate(5 + 4 + 2 + head.length + 2 + key.length);
        frame.putInt(frame.capacity() - 4).put(AgentLink.KEY).putInt(1).putShort((short) head.length).put(head)
                .putShort((short) key.length).put(key);
        return frame.array();
    }

    /** The whole buffer, to its capacity, whatever its limit was left at. */
    private static byte[] bytesOf(ByteBuffer buffer) {
        byte[] all = new byte[buffer.capacity()];
        buffer.duplicate().clear().get(all);
        return all;
    }

    /** Takes at most {@code step} bytes a write, as a socket may, and fails once {@code failAfter} have gone. */
    private static final class Recording implements WritableByteChannel {
        final ByteArrayOutputStream received = new ByteArrayOutputStream();
        final List<Boolean> direct = new ArrayList<>();
        private final int step;
        private final int failAfter;

        Recording(int step, int failAfter) {
            this.step = step;
            this.failAfter = failAfter;
        }

        @Override
        public int write(ByteBuffer src) throws IOException {
            if (received.size() >= failAfter) {
                throw new IOException("gone");
            }
            direct.add(src.isDirect());
            int n = Math.min(step, Math.min(src.remaining(), failAfter - received.size()));
            byte[] taken = new byte[n];
            src.get(taken);
            received.write(taken);
            return n;
        }

        @Override
        public boolean isOpen() {
            return true;
        }

        @Override
        public void close() {}
    }
}
