package com.minimalistalliance.desk.deskd.tools;

import com.minimalistalliance.desk.deskd.files.AgentFiles;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The Files area of the Agent's tools (draft ADR "the Agent's tools and approvals", section 2; API.md section 18):
 * {@code files_list}, {@code files_search}, {@code files_read}, {@code files_write}, {@code files_mkdir},
 * {@code files_move} and {@code files_trash}, on the member's Files and nowhere else. It runs as the desk's owner on a
 * personal desk; {@link ToolHost} never calls it on a guild desk. Every path is checked on every call, a look included,
 * by {@link AgentFiles}: inside the Files root, links never followed, never {@code .trash} or {@code .uploads}. Nothing
 * deletes for good or empties the trash.
 *
 * <p>A replace binds the old file: the look reads its SHA-256 and remembers it for the run, keyed by the payload's
 * canonical hash; the run is refused {@code changed} if the file differs now, or if no look was remembered. Nothing here
 * logs or throws a path, a name or content.
 */
public final class FilesTools implements HostedTool {

    /** What a run remembers of looks at replaces: at most this many per run. */
    private static final int REMEMBERED = 256;

    private final AgentFiles files;
    private final Map<String, Map<String, AgentFiles.Expect>> looked = new ConcurrentHashMap<>();

    public FilesTools(AgentFiles files) {
        this.files = files;
    }

    @Override
    public boolean available() {
        return files.available();
    }

    @Override
    public void runEnded(String runId) {
        looked.remove(runId);
    }

    @Override
    public Look look(HostedCall call, RunLedger.Run run) throws ToolFailure, InterruptedException {
        try {
            return switch (call.tool()) {
                case "files_list" -> {
                    String path = optionalPath(call.args(), "path");
                    files.path(path, true);
                    yield Look.plain(payload("path", path), target(path));
                }
                case "files_search" -> {
                    String q = string(call.args(), "q");
                    String under = optionalPath(call.args(), "under");
                    files.path(under, true);
                    Map<String, Object> payload = payload("q", q);
                    if (call.args().get("under") != null) {
                        payload.put("under", under);
                    }
                    yield Look.plain(payload, target(under));
                }
                case "files_read" -> {
                    String path = string(call.args(), "path");
                    files.path(path, false);
                    Map<String, Object> payload = payload("path", path);
                    if (call.args().get("offset") != null) {
                        payload.put("offset", offset(call.args()));
                    }
                    yield Look.plain(payload, target(path));
                }
                case "files_write" -> lookWrite(call, run);
                case "files_mkdir" -> {
                    String path = string(call.args(), "path");
                    files.checkMkdir(path);
                    yield Look.plain(payload("path", path), target(path));
                }
                case "files_move" -> {
                    String from = string(call.args(), "from");
                    String to = string(call.args(), "to");
                    files.checkMove(from, to);
                    Map<String, Object> target = target(from);
                    target.put("to", to);
                    Map<String, Object> payload = payload("from", from);
                    payload.put("to", to);
                    yield Look.plain(payload, target);
                }
                case "files_trash" -> {
                    String path = string(call.args(), "path");
                    AgentFiles.Taking taking = files.trashBefore(path);
                    Map<String, Object> before = new LinkedHashMap<>();
                    before.put("bytes", taking.bytes());
                    before.put("dir", taking.dir());
                    yield new Look(ToolRisk.DELETE, "agent", target(path), payload("path", path), before, null);
                }
                default -> throw ToolFailure.notFound("tool");
            };
        } catch (AgentFiles.Refusal e) {
            throw failure(e);
        }
    }

    private Look lookWrite(HostedCall call, RunLedger.Run run) throws ToolFailure, AgentFiles.Refusal {
        Map<String, Object> payload = writePayload(call.args());
        String path = (String) payload.get("path");
        boolean replace = (Boolean) payload.get("replace");
        byte[] data = AgentFiles.encode((String) payload.get("text"));
        AgentFiles.Before current = files.checkWrite(path, data.length, replace);
        Map<String, Object> before = null;
        if (replace) {
            // ToolHost looks again at the call that runs; only the member-facing look binds what the approval was shown.
            if (call.look()) {
                remember(run.runId(), Canonical.sha256(payload), new AgentFiles.Expect(current == null ? null : current.sha256()));
            }
            if (current != null) {
                before = new LinkedHashMap<>();
                before.put("sha256", current.sha256());
                before.put("bytes", current.bytes());
            }
        }
        return new Look(ToolRisk.WRITE, "agent", target(path), payload, before, null);
    }

    @Override
    public Result run(HostedCall call, RunLedger.Run run) throws ToolFailure, InterruptedException {
        try {
            return switch (call.tool()) {
                case "files_list" -> {
                    AgentFiles.Listing listing = files.list(optionalPath(call.args(), "path"));
                    List<Object> entries = new ArrayList<>();
                    for (AgentFiles.Entry e : listing.entries()) {
                        Map<String, Object> m = new LinkedHashMap<>();
                        m.put("name", e.name());
                        m.put("kind", e.dir() ? "folder" : "file");
                        if (!e.dir()) {
                            m.put("bytes", e.size());
                        }
                        m.put("mtimeMs", e.mtimeMs());
                        entries.add(m);
                    }
                    Map<String, Object> out = new LinkedHashMap<>();
                    out.put("entries", entries);
                    if (listing.more()) {
                        out.put("more", true);
                        out.put("note", "Only the first " + AgentFiles.LIST_MAX + " entries are shown. Use files_search to find others.");
                    }
                    yield Result.of(out);
                }
                case "files_search" -> {
                    AgentFiles.Found found = files.search(string(call.args(), "q"), optionalPath(call.args(), "under"));
                    List<Object> hits = new ArrayList<>();
                    for (AgentFiles.Hit h : found.hits()) {
                        Map<String, Object> m = new LinkedHashMap<>();
                        m.put("path", h.path());
                        m.put("kind", h.dir() ? "folder" : "file");
                        hits.add(m);
                    }
                    Map<String, Object> out = new LinkedHashMap<>();
                    out.put("hits", hits);
                    if (found.truncated()) {
                        out.put("truncated", true);
                    }
                    yield Result.of(out);
                }
                case "files_read" -> {
                    String path = string(call.args(), "path");
                    AgentFiles.Read read = files.read(path, call.args().get("offset") == null ? 0 : offset(call.args()));
                    Map<String, Object> out = new LinkedHashMap<>();
                    out.put("path", path);
                    if (read.documentType() != null) {
                        out.put("kind", "document");
                        out.put("type", read.documentType());
                        out.put("data", Base64.getEncoder().encodeToString(read.document()));
                    } else {
                        out.put("text", read.text());
                        out.put("offset", read.offset());
                        out.put("next", read.next());
                    }
                    yield Result.of(out);
                }
                case "files_write" -> runWrite(call, run);
                case "files_mkdir" -> {
                    String path = string(call.args(), "path");
                    files.mkdir(path);
                    yield Result.of(Map.of("created", path));
                }
                case "files_move" -> {
                    String from = string(call.args(), "from");
                    String to = string(call.args(), "to");
                    files.move(from, to);
                    Map<String, Object> out = new LinkedHashMap<>();
                    out.put("from", from);
                    out.put("to", to);
                    yield Result.of(out);
                }
                case "files_trash" -> {
                    String path = string(call.args(), "path");
                    files.trash(path);
                    Map<String, Object> out = new LinkedHashMap<>();
                    out.put("trashed", path);
                    out.put("note", "In the member's Files trash, where it can be restored.");
                    yield Result.of(out);
                }
                default -> throw ToolFailure.notFound("tool");
            };
        } catch (AgentFiles.Refusal e) {
            throw failure(e);
        }
    }

    private Result runWrite(HostedCall call, RunLedger.Run run) throws ToolFailure, AgentFiles.Refusal {
        Map<String, Object> payload = writePayload(call.args());
        String path = (String) payload.get("path");
        boolean replace = (Boolean) payload.get("replace");
        byte[] data = AgentFiles.encode((String) payload.get("text"));
        AgentFiles.Expect expect = null;
        if (replace) {
            Map<String, AgentFiles.Expect> mine = looked.get(run.runId());
            expect = mine == null ? null : mine.get(Canonical.sha256(payload));
            if (expect == null) {
                throw ToolFailure.refused("changed");
            }
        }
        files.write(path, data, replace, expect);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("saved", path);
        out.put("bytes", data.length);
        if (replace) {
            out.put("replaced", true);
        }
        return Result.of(out);
    }

    private void remember(String runId, String hash, AgentFiles.Expect expect) {
        Map<String, AgentFiles.Expect> mine = looked.computeIfAbsent(runId, id -> Collections.synchronizedMap(
                new LinkedHashMap<>() {
                    private static final long serialVersionUID = 1L;

                    @Override
                    protected boolean removeEldestEntry(Map.Entry<String, AgentFiles.Expect> eldest) {
                        return size() > REMEMBERED;
                    }
                }));
        mine.put(hash, expect);
    }

    // ---- arguments

    private static Map<String, Object> payload(String key, Object value) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put(key, value);
        return m;
    }

    private static Map<String, Object> target(String path) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kind", "file");
        m.put("path", path);
        return m;
    }

    private static Map<String, Object> writePayload(Map<String, Object> args) throws ToolFailure {
        String path = string(args, "path");
        if (!(args.get("text") instanceof String text)) {
            throw ToolFailure.badArgs("text");
        }
        Object replace = args.get("replace");
        if (replace != null && !(replace instanceof Boolean)) {
            throw ToolFailure.badArgs("replace");
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("path", path);
        payload.put("text", text);
        payload.put("replace", Boolean.TRUE.equals(replace));
        return payload;
    }

    private static String string(Map<String, Object> args, String key) throws ToolFailure {
        if (!(args.get(key) instanceof String value)) {
            throw ToolFailure.badArgs(key);
        }
        return value;
    }

    /** A folder argument that may be left out: the root. */
    private static String optionalPath(Map<String, Object> args, String key) throws ToolFailure {
        Object value = args.get(key);
        if (value == null) {
            return "";
        }
        if (!(value instanceof String s)) {
            throw ToolFailure.badArgs(key);
        }
        return s;
    }

    private static long offset(Map<String, Object> args) throws ToolFailure {
        if (!(args.get("offset") instanceof Number n) || n.longValue() < 0 || n.doubleValue() != n.longValue()) {
            throw ToolFailure.badArgs("offset");
        }
        return n.longValue();
    }

    private static ToolFailure failure(AgentFiles.Refusal e) {
        String word = e.word();
        return switch (word) {
            case "path" -> ToolFailure.badArgs("path");
            case "not_found" -> ToolFailure.notFound("not_found");
            case "too_large" -> new ToolFailure(RpcException.TOO_LARGE, "too_large");
            case "no_space" -> new ToolFailure("no_space", "no_space", e.extra());
            case "internal" -> new ToolFailure(RpcException.INTERNAL, "internal");
            default -> ToolFailure.refused(word);
        };
    }
}
