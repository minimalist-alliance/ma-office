package com.minimalistalliance.desk.deskd.files;

import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;

/** The errors of files.md section 1. A detail is a short code, never a path or a name. */
final class Errs {

    static final String EXISTS = "exists";
    static final String NO_SPACE = "no_space";
    static final String CHECK_REQUIRED = "check_required";
    static final String CHECK_INVALID = "check_invalid";
    static final String HASH_MISMATCH = "hash_mismatch";
    static final String TOO_MANY = "too_many";

    private Errs() {}

    static RpcException notFound() {
        return new RpcException(RpcException.NOT_FOUND, "No such file, folder or upload", Map.of());
    }

    static RpcException exists(boolean dir) {
        return new RpcException(EXISTS, "That name is taken", Map.of("kind", dir ? "dir" : "file"));
    }

    static RpcException exists(boolean dir, String suggest) {
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("kind", dir ? "dir" : "file");
        d.put("suggest", suggest);
        return new RpcException(EXISTS, "That name is taken", d);
    }

    static RpcException invalid(String reason) {
        return new RpcException(PathRules.INVALID, "Not usable", Map.of("reason", reason));
    }

    static RpcException badRequest(String param) {
        return new RpcException(RpcException.BAD_REQUEST, param + " is not valid", Map.of("reason", param));
    }

    static RpcException tree() {
        return new RpcException(RpcException.UNAVAILABLE, "The Files tree can't be used", Map.of("reason", "tree"));
    }

    static RpcException noSpace(Map<String, Object> details) {
        return new RpcException(NO_SPACE, "Not enough room on the drive", details);
    }

    static RpcException internal() {
        return new RpcException(RpcException.INTERNAL, "Something went wrong");
    }

    static RpcException io(IOException e) {
        return internal();
    }

    /** A tree failure, as the client sees it. */
    static RpcException of(SafeTree.TreeException e) {
        return switch (e.kind()) {
            case NOT_FOUND -> notFound();
            case NOT_A_DIR -> invalid("not_a_folder");
            case EXISTS -> new RpcException(EXISTS, "That name is taken", Map.of());
            case NOT_EMPTY -> new RpcException(EXISTS, "That folder is not empty", Map.of("kind", "dir"));
            case IO -> internal();
        };
    }
}
