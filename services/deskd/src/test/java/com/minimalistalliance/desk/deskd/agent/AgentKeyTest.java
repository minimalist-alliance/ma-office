package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

/** {@code agent.key.add}'s key in deskd: zeroed once its call is over, sent or not, and never in the log. */
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
}
