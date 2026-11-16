package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.courier.testkit.MimeCorpus;
import com.minimalistalliance.desk.deskd.courier.parse.CourierParser;
import com.minimalistalliance.desk.deskd.courier.parse.CourierSandbox;
import com.minimalistalliance.desk.deskd.courier.parse.ParsedMessage;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.ExternalIds;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.SplittableRandom;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * deskd's side of {@code desk-parse}'s Courier mode, over a real Unix socket: the real worker answering through
 * {@link ParseStandIn}, then every way a sandbox can fail, then hostile answers. Nothing a sandbox sends gets past
 * {@link CourierSandbox} as anything but a {@code ParsedMessage} within its caps, a refusal or "unavailable": the bar's
 * "0 crashes outside the sandbox".
 */
class CourierSandboxTest {

    private static CourierSandbox sandbox(ParseStandIn s, long deadlineMs, long busyMs) {
        return new CourierSandbox(new CourierSandbox.Settings(s.socket, Duration.ofMillis(deadlineMs), Duration.ofMillis(busyMs)));
    }

    private static byte[] sample(String name) {
        return MimeCorpus.handWritten().stream().filter(x -> x.name().equals(name)).findFirst().orElseThrow().raw();
    }

    @Test
    void theRealWorkerAnswersOverTheSocket(@TempDir Path dir) throws Exception {
        try (ParseStandIn s = new ParseStandIn(dir.resolve("p"))) {
            CourierSandbox sb = sandbox(s, 10_000, 1_000);
            CourierParser.Result r = sb.parse(sample("gmail-alternative"));
            assertThat(r).isInstanceOf(CourierParser.Parsed.class);
            ParsedMessage m = ((CourierParser.Parsed) r).message();
            assertThat(m.subject()).isEqualTo("Agenda");
            assertThat(m.from().address()).isEqualTo("dana@example.com");
            assertThat(m.text()).contains("budget");
            assertThat(sb.parse(MimeCorpus.tooDeep(21).raw())).isEqualTo(new CourierParser.Refused("too_deep"));
            CourierSandbox.Answer part = sb.part(sample("zip-with-exe"), "2");
            assertThat(part).isInstanceOf(CourierSandbox.Ok.class);
            Map<String, Object> listing = sb.archive(sample("zip-with-exe"), "2");
            assertThat(listing).containsEntry("format", "zip").containsEntry("danger", "archive_programs");
            assertThat(sb.part(sample("zip-with-exe"), "../x")).isEqualTo(new CourierSandbox.Declined("not_found"));
        }
    }

    @Test
    void theWholeCorpusGoesThroughTheStoreReadOrCleanlyRefused(@TempDir Path dir) throws Exception {
        try (ParseStandIn s = new ParseStandIn(dir.resolve("p")); StoreRig rig = new StoreRig(dir.resolve("s"), sandbox(s, 15_000, 2_000))) {
            int ok = 0;
            int refused = 0;
            List<String> wrong = new ArrayList<>();
            for (MimeCorpus.Sample x : MimeCorpus.standard().toList()) {
                Courier.Accepted a = rig.store.accept(Courier.Inbound.email(StoreRig.DESK,
                        ExternalIds.email(StoreRig.DESK, x.name(), x.raw()), x.raw(), Courier.Origin.LIVE));
                if (a.kind() == Courier.Accepted.Kind.DUPLICATE) {
                    continue;
                }
                if (a.kind() != Courier.Accepted.Kind.STORED) {
                    wrong.add(x.name() + ": " + a.kind() + " " + a.reason());
                    continue;
                }
                Map<String, Object> m = rig.store.queries().message(a.messageId(), 0);
                boolean wasRefused = m.get("parse") != null;
                if (wasRefused) {
                    refused++;
                } else {
                    ok++;
                }
                if (x.expect().outcome() == MimeCorpus.Outcome.READ && wasRefused
                        || x.expect().outcome() == MimeCorpus.Outcome.REFUSED && !wasRefused) {
                    wrong.add(x.name() + ": parse " + m.get("parse"));
                }
                if (x.raw().length <= 48 << 20) {
                    assertThat(rig.store.raw(a.messageId())).as(x.name()).isEqualTo(x.raw());
                }
            }
            System.out.printf("store corpus through the sandbox: %d read, %d refused, %d wrong%n", ok, refused, wrong.size());
            assertThat(wrong).isEmpty();
            assertThat(ok + refused).isGreaterThan(5000);
        }
    }

    @Test
    void noSandboxMeansTheMailWaitsAndIsReadLater(@TempDir Path dir) throws Exception {
        Path p = dir.resolve("p");
        CourierSandbox sb = new CourierSandbox(new CourierSandbox.Settings(p.resolve("parse.sock"), Duration.ofSeconds(5), Duration.ofMillis(200)));
        assertThatThrownBy(() -> sb.parse(sample("gmail-alternative"))).isInstanceOf(CourierParser.Unavailable.class);
        try (StoreRig rig = new StoreRig(dir.resolve("s"), sb)) {
            byte[] raw = sample("gmail-alternative");
            Courier.Accepted a = rig.store.accept(Courier.Inbound.email(StoreRig.DESK, "e:wait", raw, Courier.Origin.LIVE));
            assertThat(a.kind()).isEqualTo(Courier.Accepted.Kind.PENDING);
            try (ParseStandIn s = new ParseStandIn(p)) {
                assertThat(rig.store.reparsePending(10)).isEqualTo(1);
            }
        }
    }

    @Test
    void whatTheSandboxItselfSaysIsUnavailableOrARefusal(@TempDir Path dir) throws Exception {
        try (ParseStandIn s = new ParseStandIn(dir.resolve("p"))) {
            CourierSandbox sb = sandbox(s, 3_000, 300);
            byte[] raw = sample("gmail-alternative");
            for (String line : List.of("err denied\n", "ERR unavailable\n", "ERR bad_request\n", "ERR something_else\n",
                    "NOPE\n", "OK\u0007\n", "x".repeat(300))) {
                s.script(req -> line.getBytes(StandardCharsets.ISO_8859_1));
                assertThatThrownBy(() -> sb.parse(raw)).as(line).isInstanceOf(CourierParser.Unavailable.class);
            }
            s.script(req -> "ERR too_many_parts\n".getBytes(StandardCharsets.US_ASCII));
            assertThat(sb.parse(raw)).isEqualTo(new CourierParser.Refused("too_many_parts"));
            s.script(req -> "OK\n{\"v\": 2}".getBytes(StandardCharsets.US_ASCII));
            assertThat(sb.parse(raw)).isEqualTo(new CourierParser.Refused("answer"));
            s.script(req -> "OK\n{not json".getBytes(StandardCharsets.US_ASCII));
            assertThat(sb.parse(raw)).isEqualTo(new CourierParser.Refused("answer"));
            s.script(req -> "OK extra\n{\"v\":1}".getBytes(StandardCharsets.US_ASCII));
            assertThat(sb.parse(raw)).isEqualTo(new CourierParser.Refused("answer"));
            byte[] huge = new byte[(20 << 20) + 100];
            java.util.Arrays.fill(huge, (byte) ' ');
            System.arraycopy("OK\n".getBytes(StandardCharsets.US_ASCII), 0, huge, 0, 3);
            s.script(req -> huge);
            assertThat(sb.parse(raw)).isEqualTo(new CourierParser.Refused("answer"));
            // A worker that died before its line: once more, then deskd's own small message tells whether the sandbox
            // reads at all. It does, so this message is too_complex (Security CP-I5).
            s.script(req -> new String(req, StandardCharsets.ISO_8859_1).contains("Subject: probe") ? real(req) : new byte[0]);
            int before = s.connections.get();
            assertThat(sb.parse(raw)).isEqualTo(new CourierParser.Refused("too_complex"));
            assertThat(s.connections.get() - before).isEqualTo(3);
            // No worker can run at all (a desk-agent image older than the Courier mode): the mail waits, never refused.
            s.script(req -> new byte[0]);
            assertThatThrownBy(() -> sb.parse(raw)).isInstanceOf(CourierParser.Unavailable.class);
            // An answer of very many tokens inside the byte cap is refused before it fills deskd's heap (CP-L4).
            byte[] many = ("OK\n{\"v\":1,\"to\":[" + "{},".repeat(2_000_000) + "{}]}").getBytes(StandardCharsets.US_ASCII);
            s.script(req -> many);
            assertThat(sb.parse(raw)).isEqualTo(new CourierParser.Refused("answer"));
            // Busy for a while, then a real answer.
            AtomicInteger busy = new AtomicInteger(3);
            s.script(req -> busy.getAndDecrement() > 0 ? "err busy\n".getBytes(StandardCharsets.US_ASCII) : real(req));
            assertThat(sb.parse(raw)).isInstanceOf(CourierParser.Parsed.class);
            s.script(req -> "err busy\n".getBytes(StandardCharsets.US_ASCII));
            assertThatThrownBy(() -> sb.parse(raw)).isInstanceOf(CourierParser.Unavailable.class);
            assertThat(sb.parse(new byte[(40 << 20) + 1])).isEqualTo(new CourierParser.Refused("too_large"));
        }
    }

    @Test
    void deskdWaitsPastTheSandboxsOwnKill() {
        // Security CP-L1: a connection always ends by desk-svc's own close after -clean, never by deskd giving up first,
        // so a worker that took itself over can't be holding the socket when the next message goes.
        assertThat(CourierSandbox.Settings.defaults(Path.of("x")).deadline())
                .isGreaterThanOrEqualTo(CourierSandbox.DESK_SVC_DEADLINE.plusSeconds(3));
    }

    @Test
    void aSandboxThatNeverAnswersIsATimeoutAtTheDeadline(@TempDir Path dir) throws Exception {
        try (ParseStandIn s = new ParseStandIn(dir.resolve("p"))) {
            s.script(req -> null);
            CourierSandbox sb = sandbox(s, 700, 300);
            long t = System.nanoTime();
            assertThat(sb.parse(sample("gmail-alternative"))).isEqualTo(new CourierParser.Refused("timeout"));
            assertThat((System.nanoTime() - t) / 1_000_000).isBetween(600L, 5_000L);
        }
    }

    @Test
    void hostileAnswersNeverGetPastAsAnythingButARefusalOrACappedMessage(@TempDir Path dir) throws Exception {
        int rounds = Integer.getInteger("courier.fuzz.answers", 1500);
        List<byte[]> seeds = new ArrayList<>();
        try (ParseStandIn real = new ParseStandIn(dir.resolve("seed"))) {
            CourierSandbox sb = sandbox(real, 10_000, 1_000);
            for (String n : List.of("gmail-alternative", "inline-image", "dangerous-attachments", "latin1-qp", "group-syntax")) {
                real.script(req -> {
                    byte[] answer = real(req);
                    seeds.add(answer);
                    return answer;
                });
                sb.parse(sample(n));
            }
        }
        SplittableRandom random = new SplittableRandom(20261114L);
        try (ParseStandIn s = new ParseStandIn(dir.resolve("p"))) {
            CourierSandbox sb = sandbox(s, 3_000, 100);
            int parsed = 0;
            int refusedOrUnavailable = 0;
            for (int i = 0; i < rounds; i++) {
                byte[] answer = mutate(seeds.get(random.nextInt(seeds.size())), random);
                s.script(req -> answer);
                try {
                    CourierParser.Result r = sb.parse(sample("gmail-alternative"));
                    if (r instanceof CourierParser.Parsed p) {
                        parsed++;
                        ParsedMessage m = p.message();
                        assertThat(m.text().length()).isLessThanOrEqualTo(ParsedMessage.MAX_TEXT);
                        assertThat(m.to().size()).isLessThanOrEqualTo(ParsedMessage.MAX_ADDRESSES);
                        assertThat(m.attachments().size()).isLessThanOrEqualTo(ParsedMessage.MAX_PARTS);
                    } else {
                        refusedOrUnavailable++;
                    }
                } catch (CourierParser.Unavailable e) {
                    refusedOrUnavailable++;
                }
            }
            System.out.printf("hostile answers: %d, %d parsed within caps, %d refused or unavailable%n", rounds, parsed, refusedOrUnavailable);
        }
    }

    /** What the real worker answers to a request. */
    static byte[] real(byte[] request) {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        com.minimalistalliance.desk.courier.parse.CourierWorker.serve(new java.io.ByteArrayInputStream(request), out, 10_000);
        return out.toByteArray();
    }

    /** A worker's real answer, damaged: bytes flipped, cut, repeated, nested, or a field made huge. */
    static byte[] mutate(byte[] seed, SplittableRandom r) {
        byte[] b = seed.clone();
        switch (r.nextInt(8)) {
            case 0 -> {
                for (int k = 0; k < 1 + r.nextInt(20); k++) {
                    b[r.nextInt(b.length)] = (byte) r.nextInt(256);
                }
            }
            case 1 -> b = java.util.Arrays.copyOf(b, r.nextInt(b.length + 1));
            case 2 -> {
                String deep = "OK\n" + "[".repeat(5000) + "]".repeat(5000);
                b = deep.getBytes(StandardCharsets.US_ASCII);
            }
            case 3 -> {
                StringBuilder x = new StringBuilder("OK\n{\"v\":1,\"to\":[");
                for (int k = 0; k < 20_000; k++) {
                    x.append(k == 0 ? "" : ",").append("{\"address\":\"u").append(k).append("@x.example\"}");
                }
                b = x.append("],\"text\":\"").append("‮\u0000".repeat(1000)).append("\"}").toString().getBytes(StandardCharsets.UTF_8);
            }
            case 4 -> b = ("OK\n{\"v\":1,\"text\":\"" + "a".repeat(3 << 20) + "\",\"html\":\"" + "<p>".repeat(2 << 20) + "\"}")
                    .getBytes(StandardCharsets.US_ASCII);
            case 5 -> b = ("OK\n{\"v\":1,\"v\":1,\"date\":-5,\"from\":\"x\",\"attachments\":[1,null,{\"part\":\"1\"},{\"part\":\"1\"}]}")
                    .getBytes(StandardCharsets.US_ASCII);
            case 6 -> {
                byte[] extra = new byte[r.nextInt(4096)];
                r.nextBytes(extra);
                byte[] c = java.util.Arrays.copyOf(b, b.length + extra.length);
                System.arraycopy(extra, 0, c, b.length, extra.length);
                b = c;
            }
            default -> {
                byte[] junk = new byte[r.nextInt(512)];
                r.nextBytes(junk);
                b = junk;
            }
        }
        return b;
    }
}
