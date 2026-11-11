package com.minimalistalliance.desk.agent.tool;

import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Function;

/**
 * deskd's side of the tools, scripted: it offers what a test says, records every {@code tcall}, and answers each with
 * the test's function for that tool and phase, or a plain look and an empty result.
 */
final class FakeDeskLink implements DeskLink {

    volatile Set<String> offered = Set.copyOf(new java.util.HashSet<>(allHosted()));
    final List<Map<String, Object>> calls = new CopyOnWriteArrayList<>();
    final Map<String, Function<Map<String, Object>, Reply>> looks = new ConcurrentHashMap<>();
    final Map<String, Function<Map<String, Object>, Reply>> runs = new ConcurrentHashMap<>();

    static List<String> allHosted() {
        List<String> all = new ArrayList<>(ToolRegistry.FILES);
        all.addAll(ToolRegistry.BROWSER);
        all.addAll(ToolRegistry.NOTEBOOK);
        return all;
    }

    @Override
    public Set<String> offered() {
        return offered;
    }

    @Override
    @SuppressWarnings("unchecked")
    public Reply call(Map<String, Object> call, Duration wait) {
        calls.add(Map.copyOf(withoutNulls(call)));
        String tool = (String) call.get("tool");
        if ("look".equals(call.get("phase"))) {
            Function<Map<String, Object>, Reply> look = looks.get(tool);
            if (look != null) {
                return look.apply(call);
            }
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("risk", null);
            r.put("context", "agent");
            r.put("target", Map.of());
            r.put("payload", call.get("args"));
            return new Reply(true, r, null, null, (List<String>) call.get("taint"));
        }
        Function<Map<String, Object>, Reply> run = runs.get(tool);
        if (run != null) {
            return run.apply(call);
        }
        return ok(Map.of("content", "done"), (List<String>) call.get("taint"));
    }

    static Reply ok(Map<String, Object> r, List<String> taint) {
        return new Reply(true, r, null, null, taint);
    }

    static Reply look(String risk, String context, Map<String, Object> payload, String refusal) {
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("risk", risk);
        r.put("context", context);
        r.put("target", Map.of("kind", "file", "path", String.valueOf(payload.get("path"))));
        r.put("payload", payload);
        r.put("before", null);
        r.put("refusal", refusal);
        return new Reply(true, r, null, null, List.of());
    }

    static Reply refused(String code, String reason) {
        return new Reply(false, null, code, reason, List.of());
    }

    /** The run-phase calls of a tool. */
    List<Map<String, Object>> runsOf(String tool) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> call : calls) {
            if (tool.equals(call.get("tool")) && !"look".equals(call.get("phase"))) {
                out.add(call);
            }
        }
        return out;
    }

    private static Map<String, Object> withoutNulls(Map<String, Object> call) {
        Map<String, Object> out = new LinkedHashMap<>();
        call.forEach((k, v) -> {
            if (v != null) {
                out.put(k, v);
            }
        });
        return out;
    }
}
