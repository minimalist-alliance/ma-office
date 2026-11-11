package com.minimalistalliance.desk.deskd.tools;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * One area of the tools deskd runs for desk-agent: Files, the Browser or Notebook. {@link ToolHost} has already checked
 * that the tool is declared for this area, that the caller may use the area, and, before {@link #run}, that a call whose
 * class asks carries the member's approval, redeemed once. An area checks its own scope: a path inside the member's
 * Files, a tab of this run, a page the caller may edit.
 *
 * <p>Nothing an area returns or throws is logged with content: no path, page text, URL or typed text.
 */
public interface HostedTool {

    /**
     * deskd's own classification of the call, with nothing done: the class it rises to (never lower than the
     * declaration's, which {@link ToolHost} applies anyway), its context, target, the exact payload an approval would
     * hash, what it replaces, and a refusal decided before asking.
     */
    Look look(HostedCall call, RunLedger.Run run) throws ToolFailure, InterruptedException;

    /** Does it. Runs with {@code call.args()}, which for a call that asked are exactly what the member approved. */
    Result run(HostedCall call, RunLedger.Run run) throws ToolFailure, InterruptedException;

    /** The run ended: whatever the area holds for it goes, such as a browser context or a tab. Must not block long. */
    default void runEnded(String runId) {}

    /** Whether the area can work on this desk now. Its tools aren't offered while it can't. */
    default boolean available() {
        return true;
    }

    /**
     * Whether one of the area's tools is offered: one that can't do its job on this desk isn't, rather than answer every
     * call with a failure. Its calls are refused {@code unavailable}.
     */
    default boolean offers(String tool) {
        return true;
    }

    /**
     * deskd's classification of one call.
     *
     * @param risk the class it rises to, or null for the declaration's
     * @param context {@code agent} or {@code member:<site>}
     * @param target what it acts on, as API.md section 18's {@code target}
     * @param payload the exact arguments to run with, which an approval hashes: the call's own, normalized, plus what
     *     the desk adds for the card (a Browser element's {@code label}, {@code role} and {@code origin})
     * @param before what the change replaces, read now, not hashed; null for nothing
     * @param refusal a word for a call that would be refused anyway, so nobody is asked: {@code sensitive},
     *     {@code off_site}, {@code payment}, …; null for none
     */
    record Look(ToolRisk risk, String context, Map<String, Object> target, Map<String, Object> payload,
            Map<String, Object> before, String refusal) {
        public Look {
            context = context == null ? "agent" : context;
            target = target == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(target));
            Objects.requireNonNull(payload, "payload");
            payload = Collections.unmodifiableMap(new LinkedHashMap<>(payload));
            before = before == null ? null : Collections.unmodifiableMap(new LinkedHashMap<>(before));
        }

        /** The call's own arguments as the payload, in the agent's context, nothing more known. */
        public static Look plain(Map<String, Object> payload, Map<String, Object> target) {
            return new Look(null, "agent", target, payload, null, null);
        }

        public Look withRefusal(String reason) {
            return new Look(risk, context, target, payload, before, reason);
        }

        public Look withRisk(ToolRisk higher) {
            return new Look(risk == null ? higher : risk.atLeast(higher), context, target, payload, before, refusal);
        }
    }

    /**
     * What a call came to.
     *
     * @param content what the model reads: a string, or an object that goes as JSON
     * @param taints what this result adds to the run beyond the declaration's: {@code U}, {@code S}
     * @param chip what the reply's tool chip may show, words only: {@code session} ({@code agent} or {@code member}),
     *     {@code target}
     */
    record Result(Object content, Set<String> taints, Map<String, Object> chip) {
        public Result {
            Objects.requireNonNull(content, "content");
            taints = taints == null ? Set.of() : Set.copyOf(taints);
            chip = chip == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(chip));
        }

        public static Result of(Object content) {
            return new Result(content, Set.of(), Map.of());
        }
    }
}
