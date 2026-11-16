package com.minimalistalliance.desk.agent.maia.eval;

import com.minimalistalliance.desk.agent.tool.DeskLink;
import com.minimalistalliance.desk.agent.tool.ToolRegistry;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;

/**
 * A copy of the maia test package's MaiaDeskd for the evals (package access): deskd's side, scripted: Notebook writes (a page per create, the page's tab on an
 * append's look), To-do adds (each one a new id), Courier's new messages from a list the test fills, and any tool's
 * look or run the test overrides. It records every {@code tcall}. deskd's own checks are deskd's tests
 * ({@code DeskToolsMaiaTest}, {@code MaiaRecordTest}) and the real-socket ITs.
 */
public final class EvalDeskd implements DeskLink {

    public final List<Map<String, Object>> calls = new CopyOnWriteArrayList<>();
    public final Map<String, Function<Map<String, Object>, Reply>> looks = new ConcurrentHashMap<>();
    public final Map<String, Function<Map<String, Object>, Reply>> runs = new ConcurrentHashMap<>();
    /** Pages made, by id, with their tab. */
    public final Map<String, String> pageTabs = new ConcurrentHashMap<>();
    /** What {@code courier_new} gives next, then nothing. */
    public final List<Map<String, Object>> inbox = new CopyOnWriteArrayList<>();
    private final AtomicInteger ids = new AtomicInteger();

    @Override
    public Set<String> offered() {
        Set<String> all = new HashSet<>(ToolRegistry.NOTEBOOK);
        all.addAll(ToolRegistry.TODO);
        all.addAll(ToolRegistry.COURIER);
        all.addAll(ToolRegistry.FILES);
        all.addAll(ToolRegistry.DESKS);
        return all;
    }

    @Override
    public boolean keyed() {
        return true;
    }

    /** Desk Maia's model, deskd's relay and her service in one (null: deskd's hello didn't offer it). */
    volatile com.minimalistalliance.desk.agent.testing.FakeMaiaService service;

    @Override
    public boolean maiaModel() {
        return service != null;
    }

    @Override
    @SuppressWarnings("unchecked")
    public Reply call(Map<String, Object> call, Duration wait) {
        if ("maia_model".equals(call.get("tool"))) {
            com.minimalistalliance.desk.agent.testing.FakeMaiaService model = service;
            return model == null ? Reply.unavailable() : model.answer(call);
        }
        Map<String, Object> copy = new LinkedHashMap<>();
        call.forEach((k, v) -> {
            if (v != null) {
                copy.put(k, v);
            }
        });
        calls.add(copy);
        String tool = (String) call.get("tool");
        Map<String, Object> args = call.get("args") instanceof Map<?, ?> a ? (Map<String, Object>) a : Map.of();
        List<String> taint = call.get("taint") instanceof List<?> t ? (List<String>) t : List.of();
        if ("look".equals(call.get("phase"))) {
            Function<Map<String, Object>, Reply> look = looks.get(tool);
            if (look != null) {
                return look.apply(call);
            }
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("risk", null);
            r.put("context", "agent");
            Map<String, Object> target = new LinkedHashMap<>();
            if ("notebook_write".equals(tool) && args.get("pageId") instanceof String page) {
                target.put("kind", "page");
                target.put("pageId", page);
                target.put("tabId", pageTabs.get(page));
            }
            if ("todo_add".equals(tool)) {
                r.put("group", "todos");
            }
            r.put("target", target);
            r.put("payload", args);
            return new Reply(true, r, null, null, taint);
        }
        Function<Map<String, Object>, Reply> run = runs.get(tool);
        if (run != null) {
            return run.apply(call);
        }
        return switch (tool) {
            case "notebook_write" -> {
                String page = args.get("pageId") instanceof String p ? p : "pg-" + ids.incrementAndGet();
                if (args.get("new") instanceof Map<?, ?> made) {
                    pageTabs.put(page, String.valueOf(made.get("tabId")));
                }
                Map<String, Object> content = new LinkedHashMap<>();
                content.put("pageId", page);
                content.put("op", args.get("op"));
                content.put("saved", true);
                yield ok(content, List.of());
            }
            case "todo_add" -> ok(Map.of("id", "td-" + ids.incrementAndGet(), "created", true), List.of("S"));
            case "courier_new" -> {
                Map<String, Object> content = new LinkedHashMap<>();
                content.put("messages", new ArrayList<>(inbox));
                content.put("more", false);
                content.put("cursor", Map.of("receivedAt", 1, "messageId", "last"));
                inbox.clear();
                yield new Reply(true, Map.of("content", content, "taints", List.of("U", "S")), null, null,
                        List.of("U", "S"));
            }
            default -> ok(Map.of("done", true), taint);
        };
    }

    public static Reply ok(Map<String, Object> content, List<String> taint) {
        return new Reply(true, Map.of("content", content), null, null, taint);
    }

    public static Reply refused(String code, String reason) {
        return new Reply(false, null, code, reason, List.of());
    }

    public List<Map<String, Object>> runsOf(String tool) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> call : calls) {
            if (tool.equals(call.get("tool")) && !"look".equals(call.get("phase"))) {
                out.add(call);
            }
        }
        return out;
    }

    public List<Map<String, Object>> looksOf(String tool) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> call : calls) {
            if (tool.equals(call.get("tool")) && "look".equals(call.get("phase"))) {
                out.add(call);
            }
        }
        return out;
    }
}
