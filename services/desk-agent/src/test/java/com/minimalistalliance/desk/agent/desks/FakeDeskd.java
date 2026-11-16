package com.minimalistalliance.desk.agent.desks;

import com.minimalistalliance.desk.agent.tool.DeskLink;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicLong;

/**
 * deskd's side of messages between desks, for desk-agent's tests: the grants it holds, {@code desk_message} and
 * {@code desk_answer}'s looks and runs, and envelopes whose payload goes in the clear ({@code sim}), as deskd's sealed
 * ones would open to. {@code notebook_read} reads the member's private data ({@code S}). Its own checks are deskd's:
 * no envelope on a half it doesn't hold active, and a {@code send} only with the member's approval.
 */
final class FakeDeskd implements DeskLink {

    final String deskId;
    final String account = "user-1";
    /** Send halves: grant → {agentId, toDeskId, active?}. */
    final Map<String, String[]> sends = new ConcurrentHashMap<>();
    /** Answer halves: grant → {agentId (Y), fromDeskId, fromAgentId}. */
    final Map<String, String[]> answers = new ConcurrentHashMap<>();
    final Map<String, AtomicLong> seqs = new ConcurrentHashMap<>();
    final List<Map<String, Object>> calls = new CopyOnWriteArrayList<>();
    private final AtomicLong ids = new AtomicLong(1);
    /**
     * Keeps run-phase replies by key as deskd does (API.md §18, "Keys"): the same key answered from what it kept,
     * another call under it {@code key_mismatch}, a {@code retry} for a key it doesn't hold {@code key_unknown}.
     */
    volatile boolean keyed;
    private final Map<String, Reply> kept = new ConcurrentHashMap<>();
    private final Map<String, String> fingerprints = new ConcurrentHashMap<>();
    /** Calls refused {@code key_mismatch}. */
    final List<Map<String, Object>> mismatched = new CopyOnWriteArrayList<>();
    /** Envelopes made by run-phase calls, by tool. */
    final List<String> madeBy = new CopyOnWriteArrayList<>();

    FakeDeskd(String deskId) {
        this.deskId = deskId;
    }

    @Override
    public Set<String> offered() {
        return Set.of("desk_message", "desk_answer", "notebook_read");
    }

    String newId() {
        return "env-" + DeskBookTest.base32(ids.getAndIncrement() + (deskId.hashCode() & 0xffffL) * 100_000L, 26);
    }

    private long nextSeq(String grantId) {
        return seqs.computeIfAbsent(grantId, g -> new AtomicLong()).incrementAndGet();
    }

    /** An envelope as desk-agent's outbox keeps it, its payload in {@code sim}. */
    Map<String, Object> made(String kind, String grantId, String to, Map<String, Object> fields) {
        String id = newId();
        long seq = nextSeq(grantId);
        Map<String, Object> sim = new LinkedHashMap<>(fields);
        sim.put("kind", kind);
        sim.put("grantId", grantId);
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("v", 1);
        envelope.put("id", id);
        envelope.put("from", deskId);
        envelope.put("to", to);
        envelope.put("sim", sim);
        Map<String, Object> made = new LinkedHashMap<>();
        made.put("id", id);
        made.put("grantId", grantId);
        made.put("toDeskId", to);
        made.put("kind", kind);
        made.put("seq", seq);
        made.put("envelope", envelope);
        return made;
    }

    /** What deskd would hand desk-agent for an envelope it opened. */
    @SuppressWarnings("unchecked")
    static Map<String, Object> opened(Map<String, Object> envelope, long seq, long sentAt) {
        Map<String, Object> sim = (Map<String, Object>) envelope.get("sim");
        Map<String, Object> out = new LinkedHashMap<>(sim);
        out.put("id", envelope.get("id"));
        out.put("fromDeskId", envelope.get("from"));
        out.put("seq", seq);
        out.put("sentAt", sentAt);
        return out;
    }

    @Override
    public boolean keyed() {
        return keyed;
    }

    @Override
    public Reply call(Map<String, Object> call, Duration wait) {
        calls.add(Map.copyOf(call));
        String key = call.get("key") instanceof String k ? k : null;
        if (!keyed || key == null || "look".equals(call.get("phase")) || "run_end".equals(call.get("tool"))) {
            return answer(call);
        }
        synchronized (kept) {
            Reply was = kept.get(key);
            if (was != null) {
                if (!com.minimalistalliance.desk.agent.testing.KeyFingerprint.of(call).equals(fingerprints.get(key))) {
                    mismatched.add(Map.copyOf(call));
                    return new Reply(false, null, "bad_request", "key_mismatch", List.of());
                }
                return was;
            }
            if (Boolean.TRUE.equals(call.get("retry"))) {
                return new Reply(false, null, "conflict", "key_unknown", List.of());
            }
            Reply reply = answer(call);
            kept.put(key, reply);
            fingerprints.put(key, com.minimalistalliance.desk.agent.testing.KeyFingerprint.of(call));
            return reply;
        }
    }

    @SuppressWarnings("unchecked")
    private Reply answer(Map<String, Object> call) {
        String tool = (String) call.get("tool");
        List<String> taint = call.get("taint") instanceof List<?> t ? (List<String>) t : List.of();
        Map<String, Object> args = call.get("args") instanceof Map<?, ?> a ? (Map<String, Object>) a : Map.of();
        String agentId = (String) call.get("agentId");
        boolean look = "look".equals(call.get("phase"));
        String risk = taint.contains("S") ? "send" : "own";
        switch (tool) {
            case "run_end" -> {
                return new Reply(true, Map.of(), null, null, taint);
            }
            case "notebook_read" -> {
                if (look) {
                    return lookReply("read", args, Map.of("kind", "page"), null);
                }
                return new Reply(true, Map.of("content", "The member's private page.", "taints", List.of("S")), null,
                        null, union(taint, "S"));
            }
            case "desk_message" -> {
                String desk = (String) args.get("desk");
                String grantId = null;
                for (Map.Entry<String, String[]> e : sends.entrySet()) {
                    if (e.getValue()[0].equals(agentId) && e.getValue()[1].equals(desk) && "active".equals(e.getValue()[2])) {
                        grantId = e.getKey();
                    }
                }
                if (look) {
                    return lookReply(risk, args, Map.of("kind", "desk", "deskId", String.valueOf(desk)),
                            grantId == null ? "no_grant" : null);
                }
                if (grantId == null) {
                    return new Reply(false, null, "forbidden", "no_grant", taint);
                }
                if ("send".equals(risk) && call.get("approval") == null) {
                    return new Reply(false, null, "forbidden", "approval_required", taint);
                }
                Map<String, Object> made = made("msg", grantId, desk, Map.of("fromAgentId", agentId, "fromAgentName",
                        "Researcher", "text", args.get("text")));
                madeBy.add(tool);
                return new Reply(true, Map.of("content", made, "taints", List.of()), null, null, taint);
            }
            case "desk_answer" -> {
                String grantId = (String) args.get("grantId");
                String[] half = answers.get(grantId);
                if (look) {
                    Map<String, Object> target = new LinkedHashMap<>();
                    target.put("kind", "desk");
                    target.put("deskId", half == null ? null : half[1]);
                    target.put("agentId", half == null ? null : half[2]);
                    return lookReply(risk, args, target, half == null || !half[0].equals(agentId) ? "no_grant" : null);
                }
                if (half == null || !half[0].equals(agentId)) {
                    return new Reply(false, null, "forbidden", "no_grant", taint);
                }
                if ("send".equals(risk) && call.get("approval") == null) {
                    return new Reply(false, null, "forbidden", "approval_required", taint);
                }
                Map<String, Object> fields = new LinkedHashMap<>();
                fields.put("replyTo", args.get("replyTo"));
                fields.put("answeredBy", agentId);
                fields.put("answeredByName", "Helper");
                if (args.get("failed") instanceof String failed) {
                    fields.put("failed", failed);
                } else {
                    fields.put("text", args.get("text"));
                }
                fields.put("private", taint.contains("S"));
                Map<String, Object> made = made("answer", grantId, half[1], fields);
                return new Reply(true, Map.of("content", made, "taints", List.of()), null, null, taint);
            }
            default -> {
                return new Reply(false, null, "not_found", "tool", taint);
            }
        }
    }

    private static Reply lookReply(String risk, Map<String, Object> payload, Map<String, Object> target, String refusal) {
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("risk", risk);
        r.put("context", "agent");
        r.put("target", target);
        r.put("payload", payload);
        r.put("before", null);
        r.put("refusal", refusal);
        return new Reply(true, r, null, null, List.of());
    }

    private static List<String> union(List<String> taint, String flag) {
        List<String> out = new ArrayList<>(taint);
        if (!out.contains(flag)) {
            out.add(flag);
        }
        return out;
    }
}
