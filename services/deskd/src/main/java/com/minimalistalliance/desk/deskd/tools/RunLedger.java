package com.minimalistalliance.desk.deskd.tools;

import com.minimalistalliance.desk.deskd.rpc.Caller;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.Consumer;

/**
 * deskd's own copy of each run's taint (draft ADR, section 6): from desk-agent's flags on every call plus the taints of
 * deskd's own results, and only ever added to. A run is known from its first call to {@code run_end}, or until it has
 * been idle for {@link #IDLE}, longer than an approval can wait. In RAM only: a deskd restart forgets it, and desk-agent's
 * flags on the next call bring it back.
 *
 * <p>A run belongs to one agent: a call naming a known run with another agent is refused.
 */
public final class RunLedger {

    /** Longer than the longest an approval waits (24 hours), so a waiting run keeps its taint. */
    static final Duration IDLE = Duration.ofHours(25);
    /** Runs known at once. Past this, the one idle longest goes first: a desk runs at most a few at a time. */
    static final int MAX_RUNS = 256;

    /** The two flags, by their wire names. */
    public enum Flag {
        U,
        S;

        /** @return the flag, or null for a name that isn't one */
        static Flag of(Object name) {
            return "U".equals(name) ? U : "S".equals(name) ? S : null;
        }
    }

    /**
     * A source a tool deskd hosts gave this run (To-do's provenance, API.md §22): its kind ({@code courier},
     * {@code notebook}, {@code browser}, {@code files}), its ref as the tool named it, the label deskd wrote from its own
     * record of it, and its scope for merging (a Courier channel, the page, the file, the site).
     */
    public record Given(String kind, Map<String, Object> ref, String label, String threadKey) {
        public Given {
            ref = Map.copyOf(ref);
        }
    }

    /** The sources one run keeps, at most: the newest stay. */
    static final int GIVEN_MAX = 2_000;
    /** A desk origin's flag: {@code D:} and the desk's id (Desk Maia, API.md §23). */
    public static final String DESK_ORIGIN = "D:";
    /** Desk origins one run keeps, at most. */
    static final int ORIGINS_MAX = 64;
    /** What {@link Run#deskOrigins} holds past {@link #ORIGINS_MAX}: no desk's id, so no grant covers it. */
    public static final String TOO_MANY = "*";
    private static final java.util.regex.Pattern DESK_ID = java.util.regex.Pattern.compile("d-[a-z0-9]{1,40}");

    /** One run. Its flags only grow. */
    public static final class Run {
        private final String runId;
        private final String agentId;
        private final Caller caller;
        private final Set<Flag> flags = EnumSet.noneOf(Flag.class);
        private Instant lastUsed;
        /** What the run was given, by kind and canonical ref; insertion order, the oldest dropped past the cap. */
        private final Map<String, Given> given = new LinkedHashMap<>();
        /** The member's own message that started this run, by deskd's record of the relayed send; null if none. */
        private String startedBy;
        /**
         * Desks whose answers desk-agent says this run read ({@code D:<deskId>} flags: Desk Maia's "keeps to itself",
         * API.md §23). Grow-only, like the flags; deskd adds its own from the {@code desk} sources it gave the run.
         */
        private final Set<String> deskOrigins = new java.util.TreeSet<>();
        /** A tool deskd hosts gave this run {@code S}: the member's private data on this desk (Security's DMA-L5). */
        private boolean toolPrivate;

        Run(String runId, String agentId, Caller caller, Instant now) {
            this.runId = runId;
            this.agentId = agentId;
            this.caller = caller;
            this.lastUsed = now;
        }

        public String runId() {
            return runId;
        }

        public String agentId() {
            return agentId;
        }

        public Caller caller() {
            return caller;
        }

        public synchronized boolean untrusted() {
            return flags.contains(Flag.U);
        }

        public synchronized boolean privateData() {
            return flags.contains(Flag.S);
        }

        /** Whether a tool deskd hosts (Files, Notebook, Courier, To-do, Browser) gave this run {@code S}. */
        public synchronized boolean toolPrivate() {
            return toolPrivate;
        }

        /** {@link #add} for what a tool deskd hosts declared or returned. */
        public synchronized void addFromTool(Collection<?> names) {
            add(names);
            if (names != null && names.contains(Flag.S.name())) {
                toolPrivate = true;
            }
        }

        /**
         * Adds flags by wire name, and {@code D:<deskId>} desk origins; anything else is ignored. Never removes. At most
         * {@link #ORIGINS_MAX} desks are kept: past that, a desk origin can't be named, and {@link #deskOrigins} says
         * {@code *}, which no grant matches, so a brief from the run asks.
         */
        public synchronized void add(Collection<?> names) {
            if (names == null) {
                return;
            }
            for (Object name : names) {
                Flag flag = Flag.of(name);
                if (flag != null) {
                    flags.add(flag);
                } else if (name instanceof String word && word.startsWith(DESK_ORIGIN)) {
                    String deskId = word.substring(DESK_ORIGIN.length());
                    if (DESK_ID.matcher(deskId).matches()) {
                        deskOrigins.add(deskOrigins.size() < ORIGINS_MAX ? deskId : TOO_MANY);
                    }
                }
            }
        }

        /**
         * The desks whose answers this run holds: those desk-agent named ({@code D:} flags) and those deskd itself gave
         * it as a {@code desk} source. {@code *} when there were more than could be kept.
         */
        public synchronized Set<String> deskOrigins() {
            Set<String> out = new java.util.TreeSet<>(deskOrigins);
            for (Given g : given.values()) {
                if ("desk".equals(g.kind()) && g.ref().get("deskId") instanceof String deskId) {
                    out.add(deskId);
                }
            }
            return out;
        }

        /**
         * A tool deskd hosts gave this run a source: a Courier message, a page, a URL, a path, under its key
         * ({@code Provenance.key}). Recorded from deskd's own result, never from anything desk-agent says. Nothing of it is
         * logged.
         */
        public synchronized void gave(String key, String kind, Map<String, Object> ref, String label, String threadKey) {
            if (key == null || kind == null || ref == null || ref.isEmpty()) {
                return;
            }
            given.remove(key);
            given.put(key, new Given(kind, ref, label == null ? "" : label, threadKey));
            while (given.size() > GIVEN_MAX) {
                given.remove(given.keySet().iterator().next());
            }
        }

        /** The source of this kind given to this run last, or null: {@code desk}'s {@code {}} ref names it. */
        public synchronized Given latest(String kind) {
            Given last = null;
            for (Given g : given.values()) {
                if (g.kind().equals(kind)) {
                    last = g;
                }
            }
            return last;
        }

        /** What deskd recorded of this source for this run, by its key ({@code Provenance.key}), or null. */
        public synchronized Given given(String key) {
            return key == null ? null : given.get(key);
        }

        /**
         * Whether the member started this run with their own message, by deskd's record of the {@code agent.message.send}
         * it relayed from the member's session: a timer's, another agent's or Maia's run isn't.
         */
        public synchronized boolean attended() {
            return startedBy != null;
        }

        /** The member's message that started the run (the {@code agent_chat} source), or null. */
        public synchronized String startedBy() {
            return startedBy;
        }

        synchronized void startedBy(String messageId) {
            this.startedBy = messageId;
        }

        /** The flags now, as wire names in order. */
        public synchronized List<String> flags() {
            List<String> out = new ArrayList<>();
            for (Flag flag : flags) {
                out.add(flag.name());
            }
            return out;
        }

        @Override
        public String toString() {
            return "Run[" + runId + ", " + flags() + "]";
        }
    }

    private final Clock clock;
    private final Map<String, Run> runs = new LinkedHashMap<>(16, 0.75f, true);
    private final Consumer<String> ended;
    /** The runs the member started, by deskd's own record of each relayed send: run id to {agent id, message id, when}. */
    private final Map<String, Started> started = new LinkedHashMap<>(16, 0.75f, false);

    private record Started(String agentId, String messageId, Instant at) {}

    /** @param ended told of each run that ends or is forgotten, outside the ledger's lock */
    public RunLedger(Clock clock, Consumer<String> ended) {
        this.clock = clock;
        this.ended = ended;
    }

    /**
     * The run, made at its first call, with desk-agent's flags added.
     *
     * @throws ToolFailure {@code forbidden} {@code run} for a run of another agent
     */
    public Run join(String runId, String agentId, Caller caller, Collection<?> flags) throws ToolFailure {
        List<String> gone = new ArrayList<>();
        Run run;
        try {
            synchronized (this) {
                Instant now = clock.instant();
                expire(now, gone);
                run = runs.get(runId);
                if (run == null) {
                    while (runs.size() >= MAX_RUNS) {
                        String oldest = runs.keySet().iterator().next();
                        runs.remove(oldest);
                        gone.add(oldest);
                    }
                    run = new Run(runId, agentId, caller, now);
                    Started mine = started.get(runId);
                    if (mine != null && mine.agentId().equals(agentId)) {
                        run.startedBy(mine.messageId());
                    }
                    runs.put(runId, run);
                } else if (!run.agentId.equals(agentId) || !run.caller.samePerson(caller)) {
                    throw ToolFailure.forbidden("run");
                }
                run.lastUsed = now;
            }
        } finally {
            gone.forEach(ended);
        }
        run.add(flags);
        return run;
    }

    /**
     * The member's own message started this run: deskd relayed their {@code agent.message.send} from a session of theirs,
     * and desk-agent answered it with this run (API.md §11). The run is attended, and its {@code agent_chat} source is that
     * message. Kept as long as a run is (25 hours), for 256 runs at most.
     */
    public synchronized void memberStarted(String runId, String agentId, String messageId) {
        if (runId == null || agentId == null || messageId == null) {
            return;
        }
        Instant now = clock.instant();
        started.entrySet().removeIf(e -> Duration.between(e.getValue().at(), now).compareTo(IDLE) >= 0);
        started.put(runId, new Started(agentId, messageId, now));
        while (started.size() > MAX_RUNS) {
            started.remove(started.keySet().iterator().next());
        }
        Run run = runs.get(runId);
        if (run != null && run.agentId.equals(agentId)) {
            run.startedBy(messageId);
        }
    }

    /** The run deskd holds now, or null. Doesn't make one. */
    public synchronized Run find(String runId) {
        return runId == null ? null : runs.get(runId);
    }

    /** The run ended: forgotten, and its areas told. Harmless for a run deskd never saw. */
    public void end(String runId) {
        synchronized (this) {
            runs.remove(runId);
            started.remove(runId);
        }
        ended.accept(runId);
    }

    /** Every run ends, as at deskd's shutdown. */
    public void endAll() {
        List<String> all;
        synchronized (this) {
            all = new ArrayList<>(runs.keySet());
            runs.clear();
        }
        all.forEach(ended);
    }

    /** For tests and /health: how many runs are known. */
    public synchronized int size() {
        return runs.size();
    }

    /** For tests: the runs known now, by id. */
    synchronized Set<String> runIds() {
        return Collections.unmodifiableSet(new TreeSet<>(runs.keySet()));
    }

    private void expire(Instant now, List<String> gone) {
        var it = runs.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<String, Run> entry = it.next();
            if (Duration.between(entry.getValue().lastUsed, now).compareTo(IDLE) < 0) {
                break; // access order: the rest are newer
            }
            it.remove();
            gone.add(entry.getKey());
        }
    }
}
