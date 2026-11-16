package com.minimalistalliance.desk.courier.testkit.soak;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Courier's soak harness (the launch plan §7: "7 days on test desks, 100,000 inbound messages across all channels: 0
 * lost, 0 doubled"), the parts that don't depend on which desk is under test.
 *
 * <ul>
 *   <li>A {@link Channel} puts one message, carrying a unique marker, into one source the desk reads: a linked mailbox
 *       ({@code FakeMailServer}), the mail door or a member's desk ({@code FakeRelay}), iMessage ({@code FakeBlueBubbles}).
 *       {@link Channels} has one for each.
 *   <li>A {@link Fault} is switched on for a window of the run: the relay down, acks lost, duplicates, the Mac gone, a
 *       UIDVALIDITY reset, or a hook on the desk itself (kill deskd, stop the desk, fill the disk) that the run on a real
 *       desk gives. {@link Faults} has the ones the fakes can do.
 *   <li>An {@link Observer} says which markers the desk stored, and how many times each: on a real desk, through
 *       {@code courier.*}; in the harness's own proof, a model.
 *   <li>{@link Runner} spreads the plan's messages over its duration (with bursts), runs the faults' windows, writes every
 *       message to the {@link Ledger} before it's sent (so a run that stops can be resumed and still reconciled), waits for
 *       the desk to settle, and writes the {@link Report}: lost, doubled and unexpected markers, per channel.
 * </ul>
 */
public final class Soak {

    private Soak() {}

    /** One message the run sends: its order, its channel, and the marker that finds it on the desk. */
    public record Item(long seq, String channel, String marker, Instant at) {}

    public interface Channel {
        String name();

        /** Puts the item's message into the source. Throwing means it wasn't sent, and it's tried again later. */
        void inject(Item item) throws Exception;
    }

    public interface Observer {
        /** Every marker the desk holds now, and how many messages carry it. */
        Map<String, Integer> observed() throws Exception;
    }

    public interface Fault {
        String name();

        void begin() throws Exception;

        void end() throws Exception;
    }

    /** A fault switched on {@code start} into the run, for {@code length}. */
    public record Window(String fault, Duration start, Duration length) {
        public Window {
            Objects.requireNonNull(fault);
        }
    }

    /**
     * @param burstShare the share of messages sent in bursts (ten at once) rather than spread evenly
     * @param settle how long to wait after the last message for the desk to have everything
     */
    public record Plan(long seed, int total, Duration duration, List<String> channels, double burstShare, List<Window> faults, Duration settle) {
        public Plan {
            channels = List.copyOf(channels);
            faults = List.copyOf(faults);
            if (total < 1 || channels.isEmpty() || burstShare < 0 || burstShare > 1) {
                throw new IllegalArgumentException("a plan needs messages, channels, and a burst share between 0 and 1");
            }
        }

        /** The launch plan's run: 100,000 messages over 7 days on every channel, with the §7 faults, settling for an hour. */
        public static Plan launchBar(long seed) {
            Duration day = Duration.ofDays(1);
            return new Plan(seed, 100_000, Duration.ofDays(7), List.of("imap", "door", "ma", "imessage"), 0.2, List.of(
                    new Window("relay-down", day.multipliedBy(1), Duration.ofHours(1)),
                    new Window("relay-down", day.multipliedBy(2), day),
                    new Window("relay-loses-acks", day.multipliedBy(3).plusHours(2), Duration.ofHours(2)),
                    new Window("relay-duplicates", day.multipliedBy(3).plusHours(6), Duration.ofHours(2)),
                    new Window("imessage-gone", day.multipliedBy(4), day),
                    new Window("imap-uidvalidity", day.multipliedBy(5), Duration.ofMinutes(1)),
                    new Window("desk-stop", day.multipliedBy(5).plusHours(12), Duration.ofHours(6)),
                    new Window("deskd-kill", day.multipliedBy(6), Duration.ofMinutes(5))), Duration.ofHours(1));
        }
    }

    /** What a run found. It passes with 0 lost, 0 doubled and 0 unexpected. */
    /**
     * @param notSent messages the run planned but no source took by the end (a fault that never cleared, a cap): the run
     *     didn't do what it said, so it fails
     */
    public record Report(Instant started, Instant finished, int injected, int observed, List<String> lost, List<String> doubled,
            List<String> unexpected, List<String> notSent, Map<String, int[]> perChannel, List<String> faultLog, int injectRetries) {

        public boolean passed() {
            return lost.isEmpty() && doubled.isEmpty() && unexpected.isEmpty() && notSent.isEmpty() && injected > 0;
        }

        public Map<String, Object> toJson() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("passed", passed());
            m.put("started", started.toString());
            m.put("finished", finished.toString());
            m.put("injected", injected);
            m.put("observed", observed);
            m.put("lost", lost.size());
            m.put("doubled", doubled.size());
            m.put("unexpected", unexpected.size());
            m.put("notSent", notSent.size());
            m.put("lostMarkers", lost.subList(0, Math.min(100, lost.size())));
            m.put("doubledMarkers", doubled.subList(0, Math.min(100, doubled.size())));
            m.put("unexpectedMarkers", unexpected.subList(0, Math.min(100, unexpected.size())));
            Map<String, Object> per = new LinkedHashMap<>();
            perChannel.forEach((k, v) -> per.put(k, Map.of("injected", v[0], "lost", v[1], "doubled", v[2])));
            m.put("perChannel", per);
            m.put("faults", faultLog);
            m.put("injectRetries", injectRetries);
            return m;
        }

        public String toMarkdown() {
            StringBuilder b = new StringBuilder();
            b.append("# Courier soak: ").append(passed() ? "PASSED" : "FAILED").append("\n\n");
            b.append("From ").append(started).append(" to ").append(finished).append(".\n\n");
            b.append("| Channel | Sent | Lost | Doubled |\n|---|---|---|---|\n");
            perChannel.forEach((k, v) -> b.append("| ").append(k).append(" | ").append(v[0]).append(" | ").append(v[1]).append(" | ").append(v[2]).append(" |\n"));
            b.append("| **All** | ").append(injected).append(" | ").append(lost.size()).append(" | ").append(doubled.size()).append(" |\n\n");
            b.append("Unexpected (on the desk, never sent): ").append(unexpected.size()).append(". Never sent (no source took them): ")
                    .append(notSent.size()).append(". Sends retried: ").append(injectRetries).append(".\n\n");
            b.append("## Faults\n\n");
            for (String f : faultLog) {
                b.append("- ").append(f).append('\n');
            }
            return b.toString();
        }
    }

    /**
     * Compares what was sent with what the desk holds. An item in {@code unconfirmed} wasn't confirmed sent: present once,
     * it went (a crash came between sending and the ledger's confirmation); absent, it's {@code notSent}, not lost.
     */
    static Report reconcile(Instant started, Instant finished, List<Item> injected, java.util.Set<String> unconfirmed,
            Map<String, Integer> observed, List<String> faultLog, int retries) {
        List<String> lost = new ArrayList<>();
        List<String> doubled = new ArrayList<>();
        List<String> notSent = new ArrayList<>();
        Map<String, int[]> per = new LinkedHashMap<>();
        java.util.Set<String> sent = new java.util.HashSet<>();
        for (Item i : injected) {
            sent.add(i.marker());
            int[] c = per.computeIfAbsent(i.channel(), k -> new int[3]);
            c[0]++;
            int n = observed.getOrDefault(i.marker(), 0);
            if (n == 0 && unconfirmed.contains(i.marker())) {
                c[0]--;
                notSent.add(i.marker());
            } else if (n == 0) {
                lost.add(i.marker());
                c[1]++;
            } else if (n > 1) {
                doubled.add(i.marker());
                c[2]++;
            }
        }
        List<String> unexpected = new ArrayList<>();
        int seen = 0;
        for (Map.Entry<String, Integer> e : observed.entrySet()) {
            seen += e.getValue();
            if (!sent.contains(e.getKey())) {
                unexpected.add(e.getKey());
            }
        }
        int sentCount = 0;
        for (int[] c : per.values()) {
            sentCount += c[0];
        }
        return new Report(started, finished, sentCount, seen, lost, doubled, unexpected, notSent, per, faultLog, retries);
    }

}
