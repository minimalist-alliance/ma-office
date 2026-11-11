package com.minimalistalliance.desk.deskd.apps;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.RpcContext;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The {@code apps.*} methods (deskd's API, section 19): additive to {@code deskApi} 1.x. The owner's, and on a guild desk
 * every member's, except what changes what's installed or stops it for everyone ({@code install}, {@code remove},
 * {@code stop}), which on a guild desk is the Founder's alone. An export session gets none of them.
 *
 * <p>{@code apps.call} reaches an app's declared reads and {@code apps.mutate} its declared mutations, never the other way
 * round, so deskd's own idempotency store keeps a mutation's reply for 10 minutes by its key as for any deskd mutation, and
 * the key goes on to the app as {@code idem} so it can dedupe across a deskd restart too.
 */
final class AppsMethods {

    static final Set<String> SCOPES = Set.of(RpcPrincipal.OWNER, RpcPrincipal.GUILD_MEMBER);
    static final Duration CALL_TIMEOUT = Duration.ofSeconds(30);
    private static final Pattern ID = Pattern.compile("[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*){2,}");
    private static final Pattern VERSION = Pattern.compile("(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})");
    private static final Pattern SHA256 = Pattern.compile("[0-9a-f]{64}");

    private final AppsModule module;

    AppsMethods(AppsModule module) {
        this.module = module;
    }

    void register(RpcDispatcher dispatcher) {
        dispatcher.register("apps.list", SCOPES, (context, params) -> {
            scope(context);
            return module.list();
        });
        dispatcher.register("apps.catalog.get", SCOPES, (context, params) -> {
            scope(context);
            return module.catalogJson();
        });
        dispatcher.registerMutation("apps.install", SCOPES, (context, params) -> {
            module.authorizeManage(context.principal());
            String id = id(params);
            String version = Json.string(params, "version");
            String sha = Json.string(params, "packageSha256");
            if (version == null || !VERSION.matcher(version).matches()) {
                throw bad("version");
            }
            if (sha == null || !SHA256.matcher(sha).matches()) {
                throw bad("packageSha256");
            }
            Map<String, Object> installed = module.installer.install(context, id, version, sha, grants(params));
            module.ensureDaily();
            return installed;
        });
        dispatcher.registerMutation("apps.remove", SCOPES, (context, params) -> {
            module.authorizeManage(context.principal());
            Object deleteData = params.getOrDefault("deleteData", false);
            if (!(deleteData instanceof Boolean)) {
                throw bad("deleteData");
            }
            String id = id(params);
            Map<String, Object> removed = module.installer.remove(context, id, (Boolean) deleteData);
            module.topics.endApp(id, RpcException.NOT_FOUND);
            module.topics.changed();
            return removed;
        });
        dispatcher.register("apps.start", SCOPES, (context, params) -> {
            module.authorize(context.principal());
            String id = id(params);
            module.runtime.ensureRunning(id, true);
            return state(id);
        });
        dispatcher.register("apps.stop", SCOPES, (context, params) -> {
            module.authorizeManage(context.principal());
            String id = id(params);
            if (module.runtime.process(id) == null) {
                throw notFound("app");
            }
            module.runtime.stop(id);
            return state(id);
        });
        dispatcher.register("apps.view.get", SCOPES, (context, params) -> {
            module.authorize(context.principal());
            return view(id(params));
        });
        dispatcher.register("apps.call", SCOPES, (context, params) -> relay(context, params, false));
        dispatcher.registerMutation("apps.mutate", SCOPES, (context, params) -> relay(context, params, true));
    }

    /** {@code apps.list} and {@code apps.catalog.get} answer while the switch is off, saying so, and need only the scope. */
    private void scope(RpcContext context) throws RpcException {
        try {
            module.authorize(context.principal());
        } catch (RpcException e) {
            if (!RpcException.UNAVAILABLE.equals(e.code())) {
                throw e;
            }
        }
    }

    private Object relay(RpcContext context, Map<String, Object> params, boolean mutation) throws RpcException, InterruptedException {
        module.authorize(context.principal());
        String id = id(params);
        String method = Json.string(params, "m");
        Object p = params.getOrDefault("p", Map.of());
        if (method == null || method.length() > 128) {
            throw bad("m");
        }
        if (!(p instanceof Map<?, ?>)) {
            throw bad("p");
        }
        AppRuntime.Process process = module.runtime.process(id);
        if (process == null) {
            throw notFound("app");
        }
        Boolean declared = process.manifest.methods().get(method);
        if (declared == null) {
            throw notFound("method");
        }
        if (declared != mutation) {
            throw new RpcException(RpcException.BAD_REQUEST, mutation ? "Not a mutation: use apps.call" : "A mutation: use apps.mutate",
                    Map.of("reason", "mutation"));
        }
        AppLink link = module.runtime.ensureRunning(id, false);
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("m", method);
        request.put("p", p);
        if (mutation) {
            request.put("idem", context.idem());
        }
        request.put("from", module.from(context.principal(), process));
        return link.call(request, CALL_TIMEOUT, mutation ? context::beginEffect : null);
    }

    /** The window's three files, as text, with the manifest and its signatures for the Desk app to check again itself. */
    private Map<String, Object> view(String id) throws RpcException {
        AppRuntime.Process p = module.runtime.process(id);
        if (p == null) {
            throw notFound("app");
        }
        AppManifest.Window window = p.manifest.window();
        if (window == null) {
            throw notFound("view");
        }
        String version = p.entry.version();
        Map<String, Object> files = new LinkedHashMap<>();
        try {
            for (String path : List.of(window.html(), window.script(), window.style())) {
                byte[] bytes = module.store.releaseFile(id, version, path, AppManifest.MAX_VIEW_BYTES);
                files.put(path, utf8(bytes));
            }
            Map<String, Object> json = new LinkedHashMap<>();
            json.put("id", id);
            json.put("version", version);
            json.put("manifest", utf8(module.store.manifestBytes(id, version)));
            json.put("signatures", utf8(module.store.signatureBytes(id, version)));
            json.put("files", files);
            return json;
        } catch (IOException e) {
            throw AppRuntime.unavailable("storage");
        }
    }

    private Map<String, Object> state(String id) {
        AppRuntime.Process p = module.runtime.process(id);
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("id", id);
        json.put("state", p == null ? AppRuntime.STOPPED : p.state);
        json.put("problem", p == null ? null : p.problem);
        return json;
    }

    private static String id(Map<String, Object> params) throws RpcException {
        String id = Json.string(params, "id");
        if (id == null || id.length() > 64 || !ID.matcher(id).matches()) {
            throw bad("id");
        }
        return id;
    }

    private static List<String> grants(Map<String, Object> params) throws RpcException {
        if (!(params.get("grants") instanceof List<?> list) || list.size() > 16) {
            throw bad("grants");
        }
        List<String> out = new ArrayList<>();
        for (Object item : list) {
            if (!(item instanceof String s) || s.length() > 32) {
                throw bad("grants");
            }
            out.add(s);
        }
        return out;
    }

    private static String utf8(byte[] bytes) throws RpcException {
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes))
                    .toString();
        } catch (CharacterCodingException e) {
            throw new RpcException(RpcException.PRECONDITION_FAILED, "The view isn't UTF-8 text", Map.of("reason", "view"));
        }
    }

    private static RpcException bad(String field) {
        return new RpcException(RpcException.BAD_REQUEST, "Bad " + field, Map.of("reason", "params", "detail", field));
    }

    private static RpcException notFound(String what) {
        return new RpcException(RpcException.NOT_FOUND, "No such " + what, Map.of("reason", what));
    }
}
