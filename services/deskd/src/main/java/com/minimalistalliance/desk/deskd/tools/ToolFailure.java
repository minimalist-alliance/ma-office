package com.minimalistalliance.desk.deskd.tools;

import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * A hosted tool that didn't do what it was asked: a deskd error code and one word, which desk-agent turns into the
 * model's "Refused: {word}." and the approval's {@code result.error}. Never content: no path, no page text, no URL.
 */
public final class ToolFailure extends Exception {

    private static final long serialVersionUID = 1L;

    private final String code;
    private final String reason;
    private final transient Map<String, Object> extra;

    public ToolFailure(String code, String reason) {
        this(code, reason, Map.of());
    }

    /** @param extra more details, such as a limit: numbers and words only */
    public ToolFailure(String code, String reason, Map<String, Object> extra) {
        super(code + " " + reason, null, false, false);
        this.code = Objects.requireNonNull(code);
        this.reason = Objects.requireNonNull(reason);
        this.extra = extra == null ? Map.of() : Map.copyOf(extra);
    }

    /** Refused for a reason the model can act on: {@code changed}, {@code gone}, {@code exists}, … */
    public static ToolFailure refused(String reason) {
        return new ToolFailure(RpcException.CONFLICT, reason);
    }

    /** The arguments aren't what the tool takes: {@code reason} names the field or the rule. */
    public static ToolFailure badArgs(String reason) {
        return new ToolFailure(RpcException.BAD_REQUEST, reason);
    }

    public static ToolFailure notFound(String reason) {
        return new ToolFailure(RpcException.NOT_FOUND, reason);
    }

    public static ToolFailure forbidden(String reason) {
        return new ToolFailure(RpcException.FORBIDDEN, reason);
    }

    public static ToolFailure unavailable(String reason) {
        return new ToolFailure(RpcException.UNAVAILABLE, reason);
    }

    /** A thing the desk's own deskd error says, such as Files' {@code no_space}, as its code and reason. */
    public static ToolFailure of(RpcException e) {
        Object reason = e.details() == null ? null : e.details().get("reason");
        Object detail = e.details() == null ? null : e.details().get("detail");
        String word = reason instanceof String r ? r : detail instanceof String d ? d : e.code();
        return new ToolFailure(e.code(), word);
    }

    public String code() {
        return code;
    }

    public String reason() {
        return reason;
    }

    /** {@code terr}'s details: {@code reason} and any extra. */
    public Map<String, Object> details() {
        Map<String, Object> details = new LinkedHashMap<>(extra);
        details.put("reason", reason);
        return details;
    }
}
