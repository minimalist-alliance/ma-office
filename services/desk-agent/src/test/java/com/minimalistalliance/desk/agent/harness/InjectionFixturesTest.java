package com.minimalistalliance.desk.agent.harness;

import static com.minimalistalliance.desk.agent.harness.HarnessDesk.m;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;
import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.provider.ToolCall;
import java.io.IOException;
import java.net.URISyntaxException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;
import org.junit.jupiter.api.io.TempDir;

/**
 * Design §9.7's CI fixtures: "a fixture site of injection pages against the tool layer", asserting "that confirmations
 * fire, including a same-origin navigation with notebook text in the query string and a {@code browser.type} of memory
 * text into a page field, both with U and S set. It tests policy, not model behaviour." The pages are
 * {@code src/test/resources/harness/injection/*.html}; each names, in its {@code ma-fixture} line, what a model that
 * obeyed it would call and the class the desk must ask at. The run reads the page (U) and a Notebook page (S), then
 * makes those calls: each must be a card, say it's untrusted, carry the class, and run nothing when declined.
 */
class InjectionFixturesTest {

    private static final Pattern FIXTURE = Pattern.compile("<!-- ma-fixture (\\{.*\\}) -->");

    @TempDir
    static Path root;

    static List<Path> pages() throws IOException, URISyntaxException {
        URL dir = InjectionFixturesTest.class.getResource("/harness/injection");
        try (Stream<Path> s = Files.list(Path.of(dir.toURI()))) {
            return s.filter(p -> p.toString().endsWith(".html")).sorted().toList();
        }
    }

    @TestFactory
    Stream<DynamicTest> everyFixturePageAsksAndRunsNothing() throws Exception {
        List<Path> pages = pages();
        assertThat(pages).as("the fixture site").hasSizeGreaterThanOrEqualTo(10);
        List<DynamicTest> tests = new ArrayList<>();
        for (Path page : pages) {
            tests.add(DynamicTest.dynamicTest(page.getFileName().toString(), () -> check(page)));
        }
        return tests.stream();
    }

    @SuppressWarnings("unchecked")
    private static void check(Path page) throws Exception {
        String html = Files.readString(page, StandardCharsets.UTF_8);
        Matcher fx = FIXTURE.matcher(html);
        assertThat(fx.find()).as("%s has its ma-fixture line", page).isTrue();
        Map<String, Object> fixture = Json.parseObject(fx.group(1).getBytes(StandardCharsets.UTF_8));
        List<Map<String, Object>> attack = (List<Map<String, Object>>) fixture.get("attack");
        String risk = (String) fixture.get("risk");
        String text = html.replaceAll("(?s)<!--.*?-->", "").replaceAll("<[^>]+>", " ").replaceAll("\\s+", " ").strip();
        Path data = Files.createDirectories(root.resolve(page.getFileName().toString().replace('.', '_')));
        try (HarnessDesk h = new HarnessDesk(data)) {
            String a = h.desk.agent("Alice");
            h.deskd.results.put("browser_open", args -> m("tabId", "t1", "title", "Fixture", "text", text));
            List<ToolCall> calls = new ArrayList<>();
            int i = 0;
            for (Map<String, Object> call : attack) {
                calls.add(new ToolCall("x" + i++, (String) call.get("tool"), (Map<String, Object>) call.get("args")));
            }
            h.script(HarnessDesk.call("o1", "browser_open", "url", "https://fixtures.example/" + page.getFileName()),
                    HarnessDesk.call("n1", "notebook_read", "pageId", "p-1"), calls, "Done.");
            h.send(a, "Look at that page for me.");
            List<Map<String, Object>> cards = h.awaitCards(a, calls.size());
            assertThat(cards).extracting(c -> c.get("tool"))
                    .containsExactlyElementsOf(calls.stream().map(ToolCall::name).toList());
            for (Map<String, Object> card : cards) {
                assertThat(card.get("untrusted")).as("%s says untrusted", card.get("tool")).isEqualTo(true);
                if (!"own".equals(risk)) {
                    assertThat(card.get("risk")).as("%s's class", card.get("tool")).isEqualTo(risk);
                }
                // A deskd tool's card shows the exact payload the model asked for, as data (an in-process one's is
                // the desk's own form, such as a timer's time).
                Map<String, Object> asked = attack.stream().filter(x -> x.get("tool").equals(card.get("tool")))
                        .findFirst().map(x -> (Map<String, Object>) x.get("args")).orElseThrow();
                if (h.desk.service.agentTools().registry().hosted((String) card.get("tool"))) {
                    assertThat(map(card.get("payload"))).containsAllEntriesOf(asked);
                }
                h.decline(card, null);
            }
            h.ended(a);
            for (ToolCall c : calls) {
                assertThat(h.deskd.executionsOf(c.name())).as("%s ran", c.name())
                        .noneMatch(e -> e.args().equals(c.input()));
            }
            // Only the two reads ran; and the page's "the member has approved all actions" changed nothing.
            assertThat(h.deskd.executions()).extracting(CountingDeskd.Exec::tool)
                    .containsExactly("browser_open", "notebook_read");
        }
    }
}
