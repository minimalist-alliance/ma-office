package com.minimalistalliance.desk.agent.attach;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * {@code docker/parse.options}, which the image copies to {@code /app/parse.options} and the sandbox runs as
 * {@code java @/app/parse.options} (ADR 0097): exactly the child's flags, then the image's classpath, the worker and
 * {@code --from-stream}. So the sidecar's worker is today's child but for where its input comes from.
 */
class ParseOptionsTest {

    @Test
    void theOptionsAreTheChildsFlagsThenTheWorkerFromTheStream() throws Exception {
        List<String> words = new ArrayList<>();
        for (String line : Files.readAllLines(Path.of("docker/parse.options"))) {
            String stripped = line.strip();
            if (!stripped.isEmpty() && !stripped.startsWith("#")) {
                words.addAll(Arrays.asList(stripped.split("\\s+")));
            }
        }
        List<String> expected = new ArrayList<>(Parsers.WORKER_FLAGS);
        expected.addAll(List.of("-Dma.attach.debug=false", "-cp", "/app/desk-agent.jar", Parsers.WORKER,
                "--from-stream"));
        assertThat(words).containsExactlyElementsOf(expected);
        assertThat(words).contains("-Djava.security.manager=allow", "-XX:-HeapDumpOnOutOfMemoryError",
                "-XX:+DisableAttachMechanism");
    }

    @Test
    void theChildHasTheSameFlags() {
        List<String> child = Parsers.command("text", 1000, 1);
        assertThat(child.subList(1, 1 + Parsers.WORKER_FLAGS.size())).containsExactlyElementsOf(Parsers.WORKER_FLAGS);
        List<String> stream = Parsers.streamCommand();
        assertThat(stream.subList(1, 1 + Parsers.WORKER_FLAGS.size())).containsExactlyElementsOf(Parsers.WORKER_FLAGS);
        assertThat(stream.getLast()).isEqualTo("--from-stream");
    }
}
