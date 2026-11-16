package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.courier.parse.CourierParser;
import com.minimalistalliance.desk.deskd.courier.store.Invariants;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.tools.CourierTools;
import com.minimalistalliance.desk.deskd.tools.HostedDecls;
import com.minimalistalliance.desk.deskd.tools.ToolHost;
import com.minimalistalliance.desk.deskd.tools.ToolHostCalls;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The soak driver for {@code courier_new}'s cursor (§17's Courier row: "the cursor never skips or repeats across wakes,
 * catch-ups and restarts; 10,000 messages over a 7-day soak: 0 misses"), run accelerated on a clock it moves: 7 days of
 * mail into Courier's real store by fixture ingest, and an agent's runs through deskd's real {@link ToolHost} and
 * {@link CourierTools}, the run's end as desk-agent sends it.
 *
 * <p>What happens along the way, at random from a seed: live mail from known people, strangers through a linked mailbox
 * (Other), strangers at the desk's address (Requests), newsletters and {@code Precedence: bulk}; the desk asleep for hours
 * and its mail caught up at the wake, sent while it slept; the parser down, its mail waiting and parsed later; a Request
 * let in; a message moved to Spam and back; the clock stepping back; deskd restarting between runs and in the middle of
 * one; and runs that end {@code done}, fail, are killed with no end at all, lose a reply their key recovers, or lose one
 * it can't (deskd restarted under it).
 *
 * <p>The checks: every message an agent may see (inbound, not bulk, People or Other) went to a run that ended
 * {@code done} (0 misses); none went to two such runs, unless the member moved it out of sight and back after it was
 * given (0 repeats); and no run was ever given a Request, Spam, Trash, bulk or the member's own mail.
 *
 * <p>The normal build runs it at {@code -Dcourier.soak.messages} (1,500 by default); the bar's run is 10,000. Its report
 * goes to {@code target/courier-soak.json}. What the real 7-day soak needs is in the status doc: this drives the store and
 * the tools in one JVM, with desk-agent's half (its cursor report at the run's end) played by the driver.
 */
@SuppressWarnings("unchecked")
class CourierCursorSoakTest {

    private static final int MESSAGES = Integer.getInteger("courier.soak.messages", 1_500);
    private static final long SEED = Long.getLong("courier.soak.seed", 20261113L);
    private static final int DAYS = 7;
    private static final String AGENT = "ag-soak00000001";
    /**
     * The driver's own check, never set in a build: {@code failed-as-done} sends a failed run's end as {@code done}, and
     * {@code send-after-loss} names a cursor after a lost reply (Security's CR-L2): each moves a cursor past messages no
     * finished run had, which must show up as misses.
     */
    private static final String MUTANT = System.getProperty("courier.soak.mutant", "");

    private final Random rnd = new Random(SEED);
    private final AtomicBoolean parserUp = new AtomicBoolean(true);
    private CourierFixture fx;
    private ToolHost host;
    private long nextId = 1;
    private int nextKey = 1;
    private int seq;
    private int runs;

    /** Each message, how many runs that ended done were given it. */
    private final Map<String, Integer> doneCount = new HashMap<>();
    /** Messages the member moved out of sight and back after a run was given them: they may come again. */
    private final Set<String> backAfterGiven = new HashSet<>();
    /** Messages a run had that ended done but stored no cursor (it lost a reply): they come again, by design. */
    private final Set<String> givenAgainByDesign = new HashSet<>();
    private final Set<String> everGiven = new HashSet<>();
    private final List<String> people = new ArrayList<>();
    private final List<String> requestChannels = new ArrayList<>();
    private final Map<String, Integer> counts = new LinkedHashMap<>();
    private final List<Long> callMicros = new ArrayList<>();
    private final List<String> violations = new ArrayList<>();

    private void count(String what) {
        counts.merge(what, 1, Integer::sum);
    }

    private ToolHost newHost() {
        ToolHost h = new ToolHost(fx.clock(), ToolHost.ownerOnly(), () -> false, () -> true);
        h.area(HostedDecls.COURIER, new CourierTools(fx.reads(), () -> ZoneId.of("America/Denver"), fx.clock()));
        return h;
    }

    private void restartDeskd() throws Exception {
        host.close();
        fx.reopen();
        host = newHost();
        count("deskdRestarts");
    }

    @Test
    void theCursorNeverSkipsOrRepeatsAcrossWakesCatchUpsAndRestarts(@TempDir Path dir) throws Exception {
        CourierParser parser = raw -> {
            if (!parserUp.get()) {
                throw new CourierParser.Unavailable("down");
            }
            return TestMime.PARSER.parse(raw);
        };
        fx = new CourierFixture(dir.resolve("courier"), parser);
        host = newHost();
        long started = System.nanoTime();
        try {
            for (int i = 0; i < 40; i++) {
                fx.known("p" + i + "@people.example");
            }
            fx.known("news@shop.example");
            fx.known("digest@club.example");
            Instant start = fx.clock().instant();
            // The agent's first look is a day back; nothing before the soak counts.
            run(Outcome.DONE);
            int perHour = Math.max(1, MESSAGES / (DAYS * 24));
            int delivered = 0;
            int hour = 0;
            while (delivered < MESSAGES) {
                hour++;
                boolean sleeps = rnd.nextInt(100) < 12;
                if (sleeps) {
                    // Asleep for 1 to 6 hours: no runs, and its mail arrives at the wake, sent while it slept.
                    int hours = 1 + rnd.nextInt(6);
                    Instant slept = fx.clock().instant();
                    fx.clock().advance(Duration.ofHours(hours));
                    hour += hours - 1;
                    count("wakes");
                    if (rnd.nextInt(3) == 0) {
                        restartDeskd();
                    }
                    int n = Math.min(MESSAGES - delivered, perHour * hours);
                    for (int i = 0; i < n; i++) {
                        Instant sent = slept.plusSeconds(rnd.nextInt(hours * 3600));
                        deliver(sent, true);
                        delivered++;
                        count("caughtUp");
                    }
                } else {
                    boolean parserDown = rnd.nextInt(100) < 5;
                    if (parserDown) {
                        parserUp.set(false);
                        count("parserOutages");
                    }
                    int n = Math.min(MESSAGES - delivered, perHour + rnd.nextInt(perHour + 1) - perHour / 2);
                    for (int i = 0; i < n; i++) {
                        fx.clock().advance(Duration.ofMillis(3_600_000L / Math.max(1, n) - rnd.nextInt(2_000)));
                        if (rnd.nextInt(100) < 2) {
                            // The clock steps back a few seconds (NTP).
                            fx.clock().advance(Duration.ofSeconds(-(1 + rnd.nextInt(5))));
                            count("clockBack");
                        }
                        deliver(fx.clock().instant().minusSeconds(rnd.nextInt(30)), false);
                        delivered++;
                        if (rnd.nextInt(Math.max(1, n / 3)) == 0) {
                            // A run every 20 minutes or so.
                            run(outcome());
                        }
                    }
                    if (parserDown) {
                        parserUp.set(true);
                        int parsed = fx.store().reparsePending(10_000);
                        counts.merge("parsedLate", parsed, Integer::sum);
                    }
                    if (rnd.nextInt(100) < 10 && !requestChannels.isEmpty()) {
                        String channel = requestChannels.remove(rnd.nextInt(requestChannels.size()));
                        try {
                            fx.store().actions().decide(channel, "let_in");
                            count("letIns");
                        } catch (com.minimalistalliance.desk.deskd.courier.store.Actions.Refused e) {
                            // Already let in some other way.
                        }
                    }
                    if (rnd.nextInt(100) < 6 && !people.isEmpty()) {
                        String id = people.get(rnd.nextInt(people.size()));
                        if (fx.store().actions().move(List.of(id), null, null, "spam") > 0) {
                            count("toSpam");
                            if (rnd.nextBoolean() && fx.store().actions().move(List.of(id), null, null, "restore") > 0) {
                                if (everGiven.contains(id)) {
                                    backAfterGiven.add(id);
                                }
                                count("restored");
                            }
                        }
                    }
                    if (rnd.nextInt(100) < 3) {
                        restartDeskd();
                    }
                    run(outcome());
                }
            }
            // The last run drains what's left, and one more finds nothing.
            run(Outcome.DONE);
            Map<String, Object> last = call("run-final-check", "courier_new", Map.of(), key(), false);
            assertThat((List<?>) content(last).get("messages")).isEmpty();

            // ---- the checks
            List<String> eligible = Invariants.read(fx.store(), c -> {
                List<String> out = new ArrayList<>();
                try (var ps = c.prepareStatement("""
                        SELECT id FROM messages WHERE direction = 'in' AND bulk = 0 AND lane IN ('people', 'other')
                        AND received_at > ?""")) {
                    ps.setLong(1, start.toEpochMilli() - CourierTools.FIRST_LOOK.toMillis());
                    try (var r = ps.executeQuery()) {
                        while (r.next()) {
                            out.add(r.getString(1));
                        }
                    }
                }
                return out;
            });
            List<String> missed = new ArrayList<>();
            for (String id : eligible) {
                if (doneCount.getOrDefault(id, 0) == 0) {
                    missed.add(id);
                }
            }
            List<String> repeated = new ArrayList<>();
            for (Map.Entry<String, Integer> e : doneCount.entrySet()) {
                if (e.getValue() > 1 && !backAfterGiven.contains(e.getKey()) && !givenAgainByDesign.contains(e.getKey())) {
                    repeated.add(e.getKey());
                }
            }
            long[] us = callMicros.stream().mapToLong(Long::longValue).toArray();
            Arrays.sort(us);
            Map<String, Object> report = new LinkedHashMap<>();
            report.put("messages", MESSAGES);
            report.put("seed", SEED);
            report.put("simulatedHours", hour);
            report.put("simulatedDays", Math.round(Duration.between(start, fx.clock().instant()).toHours() / 24.0 * 10) / 10.0);
            report.put("eligible", eligible.size());
            report.put("missed", missed.size());
            report.put("repeatedAcrossDoneRuns", repeated.size());
            report.put("allowedRepeats", backAfterGiven.size());
            report.put("givenAgainAfterALostReply", givenAgainByDesign.size());
            report.put("violations", violations.size());
            report.put("runs", runs);
            report.put("events", counts);
            report.put("courierNewCalls", us.length);
            report.put("courierNewMsP50", us.length == 0 ? 0 : us[us.length / 2] / 1000.0);
            report.put("courierNewMsP95", us.length == 0 ? 0 : us[(int) Math.min(us.length - 1, Math.round(us.length * 0.95))] / 1000.0);
            report.put("wallSeconds", Math.round((System.nanoTime() - started) / 1e8) / 10.0);
            String json = new String(Json.bytes(report), StandardCharsets.UTF_8);
            System.out.println("COURIER-SOAK " + json);
            Files.createDirectories(Path.of("target"));
            Files.writeString(Path.of("target", "courier-soak.json"), json);
            assertThat(violations).as("given what an agent may never see").isEmpty();
            assertThat(missed).as("misses").isEmpty();
            assertThat(repeated).as("repeats across runs that ended done").isEmpty();
            assertThat(eligible.size()).isGreaterThan(MESSAGES / 2);
            Invariants.check(fx.store());
        } finally {
            host.close();
            fx.close();
        }
    }

    // ---------------------------------------------------------------- mail

    private void deliver(Instant sent, boolean caughtUp) throws Exception {
        int kind = rnd.nextInt(100);
        String id = "s" + (seq++) + "@soak.example";
        StringBuilder text = new StringBuilder();
        int words = 20 + rnd.nextInt(rnd.nextInt(8) == 0 ? 1_200 : 200);
        for (int w = 0; w < words; w++) {
            text.append(w % 17 == 16 ? "\"note\"\n" : "word" + (w % 50) + " ");
        }
        CourierFixture.Email e;
        if (kind < 58) {
            e = fx.email("Person <p" + rnd.nextInt(40) + "@people.example>");
            count("people");
        } else if (kind < 73) {
            e = fx.email("Stranger <x" + rnd.nextInt(500) + "@others.example>").viaGmail();
            count("other");
        } else if (kind < 83) {
            e = fx.email("Unknown <r" + rnd.nextInt(300) + "@requests.example>");
            count("requests");
        } else if (kind < 93) {
            e = fx.email("Shop <news@shop.example>").bulk();
            count("bulk");
        } else {
            e = fx.email("Club <digest@club.example>").header("Precedence: bulk");
            count("precedenceBulk");
        }
        e.id(id).subject("Message " + seq).text(text.toString()).sent(sent.toString());
        if (caughtUp) {
            e.caughtUp();
        }
        if (rnd.nextInt(4) == 0) {
            e.dmarc("pass");
        }
        String messageId = e.deliver();
        if (messageId == null) {
            return;
        }
        String lane = fx.lane(messageId);
        if ("people".equals(lane) && kind < 58) {
            people.add(messageId);
            if (people.size() > 400) {
                people.remove(0);
            }
        }
        if ("requests".equals(lane)) {
            String channel = fx.channel(messageId);
            if (!requestChannels.contains(channel)) {
                requestChannels.add(channel);
            }
        }
    }

    // ---------------------------------------------------------------- runs

    enum Outcome {
        DONE, FAILED, KILLED, LOST_REPLY_RECOVERED, LOST_REPLY_NOT_RECOVERED, LOST_REPLY_DESKD_UP, DESKD_RESTART_MID_RUN
    }

    private Outcome outcome() {
        int p = rnd.nextInt(100);
        return p < 58 ? Outcome.DONE : p < 70 ? Outcome.FAILED : p < 76 ? Outcome.KILLED
                : p < 83 ? Outcome.LOST_REPLY_RECOVERED : p < 88 ? Outcome.LOST_REPLY_NOT_RECOVERED
                : p < 94 ? Outcome.LOST_REPLY_DESKD_UP : Outcome.DESKD_RESTART_MID_RUN;
    }

    /** One run of the agent: it checks for new messages until there are none (or it stops early), then ends. */
    private void run(Outcome outcome) throws Exception {
        String runId = "run-" + (++runs);
        count("run:" + outcome.name().toLowerCase(java.util.Locale.ROOT));
        Set<String> received = new HashSet<>();
        Object lastCursor = null;
        int stopAfter = outcome == Outcome.FAILED || outcome == Outcome.KILLED ? 1 + rnd.nextInt(3) : 100;
        int lossAt = 1 + rnd.nextInt(2);
        // desk-agent's rule (Security's CR-L2): once a courier_new of the run was interrupted, its end names no cursor.
        boolean lost = false;
        for (int callNo = 1; callNo <= stopAfter; callNo++) {
            String k = key();
            long t0 = System.nanoTime();
            Map<String, Object> reply = call(runId, "courier_new", Map.of(), k, false);
            callMicros.add((System.nanoTime() - t0) / 1000);
            if (outcome == Outcome.LOST_REPLY_RECOVERED && callNo == lossAt) {
                // The reply never reached desk-agent: asked again by its key, deskd gives it exactly.
                Map<String, Object> again = call(runId, "courier_new", Map.of(), k, true);
                assertThat(json(content(again))).isEqualTo(json(content(reply)));
                reply = again;
            }
            if (outcome == Outcome.LOST_REPLY_NOT_RECOVERED && callNo == lossAt) {
                // Lost, and deskd restarted before desk-agent could ask again: the key is gone, the call ends interrupted,
                // and the model never saw those messages.
                restartDeskd();
                Map<String, Object> again = call(runId, "courier_new", Map.of(), k, true);
                assertThat(again.get("t")).isEqualTo("terr");
                lost = true;
                continue;
            }
            if (outcome == Outcome.LOST_REPLY_DESKD_UP && callNo == lossAt) {
                // Lost while deskd stays up (the link down past desk-agent's 2 minutes): deskd moved the run's place past
                // those messages, and the model never saw them.
                lost = true;
                continue;
            }
            Map<String, Object> got = content(reply);
            for (Map<String, Object> m : (List<Map<String, Object>>) got.get("messages")) {
                String id = (String) m.get("messageId");
                if (!"in".equals(m.get("direction")) || !Boolean.FALSE.equals(m.get("bulk"))
                        || !("people".equals(m.get("lane")) || "other".equals(m.get("lane")))) {
                    violations.add(id + " " + m.get("lane") + " " + m.get("bulk") + " " + m.get("direction"));
                }
                received.add(id);
                everGiven.add(id);
            }
            lastCursor = got.get("cursor");
            if (outcome == Outcome.DESKD_RESTART_MID_RUN && callNo == 1) {
                restartDeskd();
            }
            if (!Boolean.TRUE.equals(got.get("more"))) {
                break;
            }
        }
        switch (outcome) {
            case KILLED -> {
                // desk-agent died: no run_end at all. deskd forgets the run in time; nothing was stored.
            }
            case FAILED -> end(runId, MUTANT.equals("failed-as-done") ? "done" : "ended", lastCursor);
            default -> {
                boolean names = !lost || MUTANT.equals("send-after-loss");
                end(runId, "done", names ? lastCursor : null);
                for (String id : received) {
                    doneCount.merge(id, 1, Integer::sum);
                }
                if (!names) {
                    givenAgainByDesign.addAll(received);
                }
            }
        }
    }

    private Map<String, Object> call(String run, String tool, Map<String, Object> args, String key, boolean retry) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "tcall");
        m.put("id", nextId++);
        m.put("runId", run);
        m.put("agentId", AGENT);
        m.put("tool", tool);
        m.put("args", args);
        m.put("taint", List.of());
        if (key != null) {
            m.put("key", key);
        }
        if (retry) {
            m.put("retry", true);
        }
        return ToolHostCalls.keyed(host, m);
    }

    private void end(String run, String state, Object cursor) {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("state", state);
        if (cursor != null && "done".equals(state)) {
            args.put("courier", cursor);
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "tcall");
        m.put("id", nextId++);
        m.put("runId", run);
        m.put("agentId", AGENT);
        m.put("tool", "run_end");
        m.put("args", args);
        ToolHostCalls.keyed(host, m);
    }

    private String key() {
        long ms = fx.clock().millis();
        return String.format("%08x-%04x-7abc-9def-%012x", ms >>> 16, ms & 0xffff, nextKey++);
    }

    private static Map<String, Object> content(Map<String, Object> reply) {
        assertThat(reply.get("t")).as("%s", reply).isEqualTo("tres");
        return (Map<String, Object>) ((Map<String, Object>) reply.get("r")).get("content");
    }

    private static String json(Object o) {
        return new String(Json.bytes(o), StandardCharsets.UTF_8);
    }
}
