package com.minimalistalliance.desk.agent.service;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Who a request or a subscription is for, as deskd verified it from the session's token and nothing else (deskd's
 * {@code API.md} section 14). deskd adds it to every relayed {@code req} and {@code sub}; desk-agent goes by it alone,
 * never by anything in {@code p}.
 *
 * <ul>
 *   <li>{@code owner}: a Personal or Work desk's owner, who sees and does everything here. A frame with no caller is the
 *       owner's: a deskd from before guilds, and deskd's own pushes.
 *   <li>{@code guild_member}: on a guild desk, a member, who sees only their own agent and thread, under the guild's
 *       limits. Their agent's id is their member id.
 *   <li>{@code system}: deskd's own subscription to {@code agent.state}, for the heartbeat, which sees every agent's
 *       status. It may do nothing else.
 * </ul>
 */
public record Caller(String kind, String memberId, String role, List<String> grants, boolean teen) {

    public static final String OWNER_KIND = "owner";
    public static final String MEMBER_KIND = "guild_member";
    public static final String SYSTEM_KIND = "system";
    public static final String MANAGE_AGENTS = "manage_agents";

    /** A member's id, and so their agent's: {@code gm-} and lowercase letters and digits (deskd checks the same). */
    public static final Pattern MEMBER_ID = Pattern.compile("gm-[a-z0-9]{4,40}");

    public static final Caller OWNER = new Caller(OWNER_KIND, null, null, List.of(), false);
    public static final Caller SYSTEM = new Caller(SYSTEM_KIND, null, null, List.of(), false);

    public Caller {
        grants = List.copyOf(grants);
    }

    /**
     * The frame's {@code caller}, or the owner if there's none. Anything malformed is refused, never read as the owner.
     *
     * @throws RpcError {@code forbidden} with {@code reason: caller}
     */
    public static Caller parse(Object value) throws RpcError {
        if (value == null) {
            return OWNER;
        }
        if (!(value instanceof Map<?, ?> map) || !(map.get("kind") instanceof String kind)) {
            throw refused();
        }
        switch (kind) {
            case OWNER_KIND:
                return OWNER;
            case SYSTEM_KIND:
                return SYSTEM;
            case MEMBER_KIND:
                break;
            default:
                throw refused();
        }
        if (!(map.get("memberId") instanceof String memberId) || !MEMBER_ID.matcher(memberId).matches()) {
            throw refused();
        }
        String role = map.get("role") instanceof String text ? text : null;
        List<String> grants = new ArrayList<>();
        if (map.get("grants") instanceof List<?> list) {
            for (Object grant : list) {
                if (grant instanceof String text) {
                    grants.add(text);
                }
            }
        }
        // A missing flag can't be read as an adult's.
        if (map.containsKey("teen") && !(map.get("teen") instanceof Boolean)) {
            throw refused();
        }
        boolean teen = !Boolean.FALSE.equals(map.get("teen"));
        return new Caller(MEMBER_KIND, memberId, role, grants, teen);
    }

    public boolean isOwner() {
        return OWNER_KIND.equals(kind);
    }

    public boolean isMember() {
        return MEMBER_KIND.equals(kind);
    }

    public boolean isSystem() {
        return SYSTEM_KIND.equals(kind);
    }

    /** The owner, or a member holding the grant (the Founder holds every one). */
    public boolean has(String grant) {
        return isOwner() || (isMember() && grants.contains(grant));
    }

    /** True for a member agent's id: the member's own id. */
    public static boolean isMemberAgent(String agentId) {
        return agentId != null && MEMBER_ID.matcher(agentId).matches();
    }

    /** Whether this caller may see the agent: the owner theirs, a member only their own, the system all. */
    public boolean sees(String agentId) {
        if (isSystem()) {
            return true;
        }
        if (isMember()) {
            return memberId.equals(agentId);
        }
        return !isMemberAgent(agentId);
    }

    static RpcError refused() {
        return RpcError.of("forbidden", "reason", "caller");
    }

    /** No member id in logs. */
    @Override
    public String toString() {
        return "Caller[" + kind + "]";
    }
}
