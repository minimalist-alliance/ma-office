package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.ExternalIds;
import com.minimalistalliance.desk.deskd.courier.store.Invariants;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;
import org.junit.jupiter.api.io.TempDir;

/**
 * Threading on real-world header mixes ({@code src/test/resources/courier/threading/}, written by the task's generator
 * from what Gmail, Outlook, Apple Mail, mailing lists and broken mailers send): each scenario's messages go through the
 * sink as a transport would hand them, raw and then read by the test parser, in its {@code order} (or by name), and its
 * {@code expect} lines are checked, then the store's invariants. Each scenario runs again in reverse order, and threads
 * must come out the same.
 */
class ThreadingCorpusTest {

    @TempDir
    Path tmp;

    @TestFactory
    Stream<DynamicTest> everyScenario() throws Exception {
        Path root = Path.of(getClass().getResource("/courier/threading").toURI());
        List<Path> scenarios;
        try (Stream<Path> s = Files.list(root)) {
            scenarios = s.filter(Files::isDirectory).sorted().toList();
        }
        assertThat(scenarios).hasSizeGreaterThanOrEqualTo(17);
        List<DynamicTest> tests = new ArrayList<>();
        for (Path sc : scenarios) {
            tests.add(DynamicTest.dynamicTest(sc.getFileName().toString(), () -> run(sc, false)));
            tests.add(DynamicTest.dynamicTest(sc.getFileName() + " reversed", () -> run(sc, true)));
        }
        return tests.stream();
    }

    private void run(Path scenario, boolean reversed) throws Exception {
        List<String[]> expect = new ArrayList<>();
        for (String line : Files.readAllLines(scenario.resolve("expect"))) {
            if (!line.isBlank() && !line.startsWith("#")) {
                expect.add(line.strip().split("\\s+", -1));
            }
        }
        List<String> order = new ArrayList<>();
        try (Stream<Path> s = Files.list(scenario)) {
            s.map(p -> p.getFileName().toString()).filter(n -> n.endsWith(".eml")).sorted().forEach(n -> order.add(n.substring(0, n.length() - 4)));
        }
        Map<String, String> account = new LinkedHashMap<>();
        List<String> outgoing = new ArrayList<>();
        List<String> known = new ArrayList<>();
        boolean ordered = false;
        for (String[] e : expect) {
            switch (e[0]) {
                case "order" -> {
                    order.clear();
                    order.addAll(List.of(e).subList(1, e.length));
                }
                case "account" -> account.put(e[1], e[2]);
                case "outgoing" -> outgoing.addAll(List.of(e).subList(1, e.length));
                case "known" -> known.addAll(List.of(e).subList(1, e.length));
                case "ordered" -> ordered = true;
                default -> {
                    // checked after
                }
            }
        }
        // A subject-only reply and a reply-all that brings someone in need the earlier message first, by design.
        if (reversed && ordered) {
            return;
        }
        List<String> delivery = new ArrayList<>(order);
        if (reversed) {
            java.util.Collections.reverse(delivery);
        }
        Path dir = tmp.resolve(scenario.getFileName() + (reversed ? "-r" : ""));
        try (StoreRig rig = new StoreRig(dir)) {
            rig.clock.advance(java.time.Duration.between(rig.clock.instant(), Instant.parse("2027-01-01T00:00:00Z")));
            int k = 0;
            for (String who : known) {
                // The member wrote to them once: their mail is People from then on.
                rig.store.accept(Mail.from("Me <me@desk.example>").to(who).subject("hi").id("known" + (k++) + "@desk.example")
                        .inbound(StoreRig.DESK).asOutgoing());
            }
            Map<String, String> ids = new LinkedHashMap<>();
            for (String name : delivery) {
                byte[] raw = Files.readAllBytes(scenario.resolve(name + ".eml"));
                String acct = account.getOrDefault(name, account.getOrDefault("*", StoreRig.DESK));
                Courier.Inbound in = Courier.Inbound.email(acct, ExternalIds.email(acct, header(raw, "Message-ID"), raw), raw, Courier.Origin.LIVE);
                if (outgoing.contains(name)) {
                    in = in.asOutgoing();
                }
                Courier.Accepted a = rig.store.accept(in);
                assertThat(a.kind()).as(name).isEqualTo(Courier.Accepted.Kind.STORED);
                ids.put(name, a.messageId());
            }
            for (String[] e : expect) {
                List<String> names = List.of(e).subList(1, e.length);
                switch (e[0]) {
                    case "thread" -> {
                        String t = rig.thread(ids.get(names.get(0)));
                        assertThat(t).as("thread of " + names.get(0)).isNotNull();
                        for (String n : names) {
                            assertThat(rig.thread(ids.get(n))).as(n + " in " + names.get(0) + "'s thread").isEqualTo(t);
                        }
                    }
                    case "apart" -> assertThat(rig.thread(ids.get(names.get(0)))).as(names + " apart")
                            .isNotEqualTo(rig.thread(ids.get(names.get(1))));
                    case "channel" -> {
                        String ch = rig.channel(ids.get(names.get(0)));
                        for (String n : names) {
                            assertThat(rig.channel(ids.get(n))).as(n + " in " + names.get(0) + "'s channel").isEqualTo(ch);
                        }
                    }
                    case "channels-apart" -> assertThat(rig.channel(ids.get(names.get(0)))).as(names + " channels apart")
                            .isNotEqualTo(rig.channel(ids.get(names.get(1))));
                    case "distinct" -> assertThat(ids.get(names.get(0))).isNotEqualTo(ids.get(names.get(1)));
                    case "lane" -> {
                        if (!reversed) {
                            assertThat(rig.lane(ids.get(names.get(0)))).as("lane of " + names.get(0)).isEqualTo(names.get(1));
                        }
                    }
                    case "subject" -> assertThat(rig.facts(ids.get(names.get(0))).get("subject"))
                            .isEqualTo(String.join(" ", names.subList(1, names.size())));
                    case "name" -> assertThat(((Map<?, ?>) rig.facts(ids.get(names.get(0))).get("from")).get("name"))
                            .isEqualTo(String.join(" ", names.subList(1, names.size())));
                    case "title" -> {
                        Map<String, Object> t = rig.store.queries().thread(rig.channel(ids.get(names.get(0))), null, null, 10);
                        assertThat(((Map<?, ?>) t.get("channel")).get("title")).isEqualTo(String.join(" ", names.subList(1, names.size())));
                    }
                    case "kind" -> {
                        Map<String, Object> t = rig.store.queries().thread(rig.channel(ids.get(names.get(0))), null, null, 10);
                        assertThat(((Map<?, ?>) t.get("channel")).get("kind")).isEqualTo(names.get(1));
                    }
                    default -> {
                        // set-up lines
                    }
                }
            }
            Invariants.check(rig.store);
        }
    }

    /** One header's value from raw bytes, for the transport's key (an IMAP server gives it in ENVELOPE). */
    static String header(byte[] raw, String name) {
        for (String line : new String(raw, StandardCharsets.ISO_8859_1).split("\r?\n")) {
            if (line.isEmpty()) {
                break;
            }
            if (line.regionMatches(true, 0, name + ":", 0, name.length() + 1)) {
                return line.substring(name.length() + 1).strip();
            }
        }
        return null;
    }
}
