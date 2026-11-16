package com.minimalistalliance.desk.deskd.desks;

import com.minimalistalliance.desk.deskd.tools.Provenance;
import com.minimalistalliance.desk.deskd.tools.RunLedger;
import java.time.Clock;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Function;

/**
 * To-do's source kind {@code desk} (API.md §22 and §18): which run was given which message from another of the member's
 * desks, by deskd's own record, so {@code todo_add} can name it as where a to-do came from. Recorded into the run's
 * entry in deskd's {@link RunLedger}, as {@link Provenance} does for the other kinds.
 *
 * <ul>
 *   <li><b>On the answering desk:</b> a {@code msg} deskd opened here, for its answering agent. The run desk-agent starts
 *       for it names the message as its origin on its calls ({@code origin: {kind: "desk", envelopeId}}); deskd gives
 *       it to that run only if the run is the answering agent's and no other run has it (one run per message, the first
 *       to name it). A desk-agent that named the wrong run could only label that run's to-dos with a message deskd
 *       opened for that agent, and a {@code desk} source is untrusted in any case.
 *   <li><b>On the asking desk:</b> an answer deskd opened here, which desk-agent says the waiting {@code desk_message}
 *       call took: given to the run whose message it answers, by deskd's own record of which run sent it, and only
 *       within {@link #TAKEN_WITHIN_MS} of that send.
 *   <li><b>Desk Maia's reports (Maia Mode Phase 2):</b> an answer deskd opened here for {@code maia} after her wait (a
 *       report that came back while the member was away, put in her thread). Her later run names the answers in her
 *       thread on its calls ({@code origin: {kind: "maia", answers: [envelopeId, …]}}, oldest first); deskd gives each
 *       one it opened for {@code maia} (its own grant record's agent), not a failure word, within 7 days, so her
 *       {@code todo_add} with {@code desk {}} names the newest. Each one given also adds {@code U} to deskd's copy of
 *       the run's taint (another desk's words), and {@code S} for a private answer, so the item is marked untrusted
 *       whatever desk-agent says.
 * </ul>
 * Its ref is {@code {deskId, messageId}} (the envelope's id), its label "Message from {name} on another of your desks"
 * or "Answer from {name} …", from the signed envelope. Kept in memory for 7 days at most, {@link #MAX} of each; a restart
 * forgets it, as it ends every run. Nothing of it is logged.
 */
public final class DeskSources {

    static final int MAX = 2_048;
    /** A name in a label: "Message from " and " on another of your desks" leave 42 of To-do's 80. */
    static final int LABEL_NAME = 40;
    /** An answer is the sending run's only while its {@code desk_message} call could still be waiting: 120 s and 30. */
    static final long TAKEN_WITHIN_MS = 150_000;

    private record Sent(String runId, long at) {}

    /** @param privateBrief Desk Maia's brief from a run that held the member's private data on her desk (DMA-M1) */
    private record Received(String agentId, String fromDeskId, String fromAgentName, long at, boolean privateBrief) {}

    /** An answer opened here for {@code agentId} (its grant's half), with words in it. */
    private record Answered(String agentId, String fromDeskId, String answeredByName, long at, boolean privateAnswer) {}

    /** The most answers one of Desk Maia's calls may name: more than her thread's window ever holds. */
    static final int MAIA_ANSWERS = 32;

    private final Clock clock;
    private final Map<String, Sent> sent = new LinkedHashMap<>();
    private final Map<String, Received> received = new LinkedHashMap<>();
    private final Map<String, Answered> answered = new LinkedHashMap<>();
    /** Message id to the run that has it: one run per message. */
    private final Map<String, String> claimed = new LinkedHashMap<>();
    private volatile Function<String, RunLedger.Run> runs = id -> null;

    DeskSources(Clock clock) {
        this.clock = clock;
    }

    /** deskd's runs now, by id ({@link RunLedger#find}). */
    public void runs(Function<String, RunLedger.Run> finder) {
        this.runs = finder == null ? id -> null : finder;
    }

    /** {@code desk_message} made this envelope in this run. */
    synchronized void sent(String envelopeId, String runId) {
        if (envelopeId == null || runId == null) {
            return;
        }
        prune(sent, s -> s.at());
        sent.put(envelopeId, new Sent(runId, clock.millis()));
    }

    /** A {@code msg} opened here for {@code agentId}, the agent the member chose to answer. The first time only. */
    synchronized void received(String envelopeId, String agentId, String fromDeskId, String fromAgentName) {
        received(envelopeId, agentId, fromDeskId, fromAgentName, false);
    }

    /** The same, saying whether it is Desk Maia's private brief ({@code private} in her envelope). */
    synchronized void received(String envelopeId, String agentId, String fromDeskId, String fromAgentName,
            boolean privateBrief) {
        if (envelopeId == null || agentId == null || fromDeskId == null || received.containsKey(envelopeId)) {
            return;
        }
        prune(received, r -> r.at());
        received.put(envelopeId, new Received(agentId, fromDeskId, fromAgentName, clock.millis(), privateBrief));
    }

    /**
     * An {@code answer} opened here for {@code agentId}, the agent of this desk's half of its grant (deskd's own record),
     * with words in it: the first time only. A failure word ({@code failed}) is no source, so it isn't kept.
     */
    synchronized void answered(String envelopeId, String agentId, String fromDeskId, String answeredByName,
            boolean privateAnswer) {
        if (envelopeId == null || agentId == null || fromDeskId == null || answered.containsKey(envelopeId)) {
            return;
        }
        prune(answered, r -> r.at());
        answered.put(envelopeId, new Answered(agentId, fromDeskId, answeredByName, clock.millis(), privateAnswer));
    }

    /**
     * Security's DMA-M1: the run answering Desk Maia's private brief holds {@code S} from her words, so its answer back
     * to the desk that sent them stays {@code own}. True only when {@code replyTo} is a private brief opened here, from
     * {@code toDeskId}, that this run has as its origin, and not stale. Anything else is false, and the answer asks as
     * W6 says; so does one from a run a tool here gave {@code S} (DMA-L5, {@link DeskTools}).
     */
    public synchronized boolean answersPrivateBrief(String replyTo, String runId, String toDeskId) {
        if (replyTo == null || runId == null || toDeskId == null) {
            return false;
        }
        Received r = received.get(replyTo);
        return r != null && r.privateBrief() && r.fromDeskId().equals(toDeskId) && runId.equals(claimed.get(replyTo))
                && !stale(r.at());
    }

    /**
     * A call's {@code origin}: a run that names a {@code msg} opened here as the one that started it gets it as a source,
     * when it is the answering agent's run and no other run has it.
     */
    public void origin(RunLedger.Run run, Object origin) {
        if (run != null && origin instanceof Map<?, ?> m && "maia".equals(m.get("kind"))) {
            maiaAnswers(run, m.get("answers"));
            return;
        }
        if (run == null || !(origin instanceof Map<?, ?> o) || !"desk".equals(o.get("kind"))
                || !(o.get("envelopeId") instanceof String envelopeId)) {
            return;
        }
        Received r;
        synchronized (this) {
            r = received.get(envelopeId);
            if (r == null || !r.agentId().equals(run.agentId()) || stale(r.at())) {
                return;
            }
            String holder = claimed.get(envelopeId);
            if (holder != null && !holder.equals(run.runId())) {
                return;
            }
            prune(claimed, h -> 0L);
            claimed.put(envelopeId, run.runId());
        }
        if (r.privateBrief()) {
            // Desk Maia's private brief: deskd's own S for the run, whatever desk-agent sends (Security's DMA-I8).
            run.add(java.util.List.of(RunLedger.Flag.S.name()));
        }
        give(run, envelopeId, r.fromDeskId(), "Message from " + labelName(r.fromAgentName()) + " on another of your desks");
    }

    /**
     * An answer opened here ({@code opened}, deskd's own view) that the waiting {@code desk_message} call took: given to
     * the run that sent the message it answers, if deskd still holds that run.
     */
    public void answerTaken(Map<String, Object> opened) {
        if (opened == null || !"answer".equals(opened.get("kind")) || opened.get("failed") != null
                || !(opened.get("replyTo") instanceof String replyTo) || !(opened.get("id") instanceof String id)
                || !(opened.get("fromDeskId") instanceof String fromDeskId)) {
            return;
        }
        Sent s;
        synchronized (this) {
            s = sent.get(replyTo);
        }
        // Only while the call could still be waiting: 120 s and a margin from the send (Security's DM-I5).
        if (s == null || clock.millis() - s.at() > TAKEN_WITHIN_MS) {
            return;
        }
        RunLedger.Run run = runs.apply(s.runId());
        if (run != null) {
            give(run, id, fromDeskId, "Answer from " + labelName((String) opened.get("answeredByName"))
                    + " on another of your desks");
        }
    }

    /**
     * Desk Maia's run names the answers in her thread, oldest first: each one deskd opened here for {@code maia}, with words
     * in it and within 7 days, is given to the run in that order (so {@code desk {}} names the newest), with {@code U}
     * (and {@code S} for a private one) on deskd's own copy of the run's taint. Only her runs; anything else names
     * nothing. At most {@link #MAIA_ANSWERS}, the newest.
     */
    private void maiaAnswers(RunLedger.Run run, Object raw) {
        if (!DeskTools.MAIA.equals(run.agentId()) || !(raw instanceof java.util.List<?> ids) || ids.isEmpty()) {
            return;
        }
        java.util.List<?> newest = ids.subList(Math.max(0, ids.size() - MAIA_ANSWERS), ids.size());
        java.util.List<String[]> give = new java.util.ArrayList<>();
        boolean anyPrivate = false;
        synchronized (this) {
            for (Object id : newest) {
                if (!(id instanceof String envelopeId) || !Envelope.ID.matcher(envelopeId).matches()) {
                    continue;
                }
                Answered a = answered.get(envelopeId);
                if (a == null || !a.agentId().equals(run.agentId()) || stale(a.at())) {
                    continue;
                }
                anyPrivate |= a.privateAnswer();
                give.add(new String[] {envelopeId, a.fromDeskId(), a.answeredByName()});
            }
        }
        if (give.isEmpty()) {
            return;
        }
        // Another desk's words: untrusted, whatever desk-agent's flags say; private when the answering run read the member's
        // private data there.
        run.add(anyPrivate ? java.util.List.of(RunLedger.Flag.U.name(), RunLedger.Flag.S.name())
                : java.util.List.of(RunLedger.Flag.U.name()));
        for (String[] g : give) {
            give(run, g[0], g[1], "Answer from " + labelName(g[2]) + " on another of your desks");
        }
    }

    private static void give(RunLedger.Run run, String envelopeId, String fromDeskId, String label) {
        Map<String, Object> ref = new LinkedHashMap<>();
        ref.put("deskId", fromDeskId);
        ref.put("messageId", envelopeId);
        run.gave(Provenance.key("desk", ref), "desk", ref, label, "desk:" + fromDeskId);
    }

    /**
     * The other desk's name for its agent, as a label shows it: one plain line, with nothing hidden in it (Security's
     * DMA2-L2: control, format and bidi characters, line and paragraph separators, private-use and unpaired surrogates
     * are dropped; any other space is a space), at most {@link #LABEL_NAME} code points; "an agent" if nothing is left.
     */
    static String labelName(String name) {
        if (name == null) {
            return "an agent";
        }
        StringBuilder plain = new StringBuilder();
        name.codePoints().forEach(cp -> {
            switch (Character.getType(cp)) {
                case Character.CONTROL, Character.FORMAT, Character.PRIVATE_USE, Character.SURROGATE,
                        Character.UNASSIGNED, Character.LINE_SEPARATOR, Character.PARAGRAPH_SEPARATOR -> {}
                case Character.SPACE_SEPARATOR -> plain.append(' ');
                default -> plain.appendCodePoint(cp);
            }
        });
        String n = plain.toString().replaceAll(" {2,}", " ").strip();
        if (n.isEmpty()) {
            return "an agent";
        }
        int[] cps = n.codePoints().limit(LABEL_NAME).toArray();
        return new String(cps, 0, cps.length).strip();
    }

    private boolean stale(long at) {
        return clock.millis() - at > DeskMessaging.MAX_AGE_MS;
    }

    private <V> void prune(Map<String, V> map, java.util.function.ToLongFunction<V> at) {
        long now = clock.millis();
        Iterator<Map.Entry<String, V>> it = map.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<String, V> e = it.next();
            if (map.size() >= MAX || (at.applyAsLong(e.getValue()) > 0 && now - at.applyAsLong(e.getValue())
                    > DeskMessaging.MAX_AGE_MS)) {
                it.remove();
            } else {
                break;
            }
        }
    }
}
