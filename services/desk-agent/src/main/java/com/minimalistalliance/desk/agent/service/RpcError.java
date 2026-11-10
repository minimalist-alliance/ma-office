package com.minimalistalliance.desk.agent.service;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * An {@code agent.*} call refused, in deskd's words (API.md section 4): a code, and {@code details} with a
 * {@code reason} and a {@code detail} or {@code scope}, all words, never content. deskd relays it unchanged.
 */
public final class RpcError extends Exception {

    private static final long serialVersionUID = 1L;

    private final String code;
    private final transient Map<String, Object> details;

    public RpcError(String code, Map<String, Object> details) {
        super(code, null, false, false);
        this.code = code;
        this.details = details;
    }

    public static RpcError of(String code, String... pairs) {
        Map<String, Object> details = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            details.put(pairs[i], pairs[i + 1]);
        }
        return new RpcError(code, details);
    }

    public static RpcError badRequest(String detail) {
        return of("bad_request", "detail", detail);
    }

    public static RpcError notFound(String detail) {
        return of("not_found", "detail", detail);
    }

    public String code() {
        return code;
    }

    public Map<String, Object> details() {
        return details;
    }
}
