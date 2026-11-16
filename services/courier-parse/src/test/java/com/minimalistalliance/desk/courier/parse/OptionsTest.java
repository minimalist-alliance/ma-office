package com.minimalistalliance.desk.courier.parse;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The two workers in the parse sandbox stay alike: the Courier worker's JVM flags are desk-agent's {@code parse.options}
 * line for line, and its security manager is desk-agent's {@code worker/Sandbox}, so a change to one is a change to both
 * or this fails.
 */
class OptionsTest {

    private static List<String> flags(Path p) throws Exception {
        List<String> out = new ArrayList<>();
        for (String line : Files.readAllLines(p)) {
            if (!line.isBlank() && !line.startsWith("#")) {
                out.add(line.strip());
            }
        }
        return out;
    }

    @Test
    void theFlagsAreParseOptionsOwn() throws Exception {
        List<String> parse = flags(Path.of("../desk-agent/docker/parse.options"));
        List<String> courier = flags(WorkerProcessTest.OPTIONS);
        List<String> jvm = parse.subList(0, parse.indexOf("-Dma.attach.debug=false"));
        assertThat(courier.subList(0, jvm.size())).isEqualTo(jvm);
        assertThat(courier.subList(jvm.size(), courier.size())).containsExactly("-Dma.courier.debug=false",
                "-Dma.courier.trackers=/app/courier/trackers.txt", "-cp", "/app/desk-agent.jar",
                CourierWorker.class.getName(), CourierWorker.FROM_STREAM);
        assertThat(parse.subList(jvm.size() + 1, parse.size()).get(0)).isEqualTo("-cp");
    }

    @Test
    void theSecurityManagerIsDeskAgentsOwn() throws Exception {
        String theirs = Files.readString(Path.of(
                "../desk-agent/src/main/java/com/minimalistalliance/desk/agent/attach/worker/Sandbox.java"));
        String ours = Files.readString(Path.of("src/main/java/com/minimalistalliance/desk/courier/parse/Sandbox.java"));
        String theirBody = theirs.substring(theirs.indexOf("final class Sandbox")).replace("ma.attach.debug", "ma.courier.debug");
        String ourBody = ours.substring(ours.indexOf("final class Sandbox"));
        assertThat(ourBody).isEqualTo(theirBody);
    }
}
