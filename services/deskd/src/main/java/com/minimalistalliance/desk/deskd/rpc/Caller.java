package com.minimalistalliance.desk.deskd.rpc;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Who a session is, as its verified token says and nothing else: no client frame can set or change it. deskd hands it,
 * as {@link #toJson}, to every service it relays to (desk-agent, desk-notebook, Commons), which enforce with it
 * (docs/sub-status/deskd-guild-sessions.md, "The verified caller").
 *
 * @param kind {@link #OWNER} on a Personal or Work desk, {@link #GUILD_MEMBER} on a guild desk
 * @param memberId the guild-scoped member id, {@code gm-…}; null for the owner
 * @param role {@code lead}, {@code officer} or {@code member}; null for the owner
 * @param grants the effective grants, in {@link #GRANTS}' order: see {@link #effectiveGrants}
 * @param name the member's display name in the guild; null for the owner
 * @param badge {@code officer}, {@code lead} or null
 * @param teen the member is in the teen age band (a guild member only: the owner's band is {@code AgeBand}'s)
 */
public record Caller(String kind, String memberId, String role, List<String> grants, String name, String badge, boolean teen) {

    public static final String OWNER = "owner";
    public static final String GUILD_MEMBER = "guild_member";

    public static final String LEAD = "lead";
    public static final String OFFICER = "officer";
    public static final String MEMBER = "member";

    public static final String MODERATE = "moderate";
    public static final String INVITE = "invite";
    public static final String REMOVE_MEMBER = "remove_member";
    public static final String MANAGE_SPACES = "manage_spaces";
    public static final String MANAGE_AGENTS = "manage_agents";
    /** Every grant there is, in the order they're listed. */
    public static final List<String> GRANTS = List.of(MODERATE, INVITE, REMOVE_MEMBER, MANAGE_SPACES, MANAGE_AGENTS);

    /** The owner of a Personal or Work desk, who may do everything there. */
    public static final Caller THE_OWNER = new Caller(OWNER, null, null, List.of(), null, null, false);

    public Caller {
        grants = List.copyOf(grants);
    }

    /**
     * What a role's grants are: {@code lead} has all of them, whatever the token's array says; {@code member} none,
     * whatever it says; {@code officer} the token's, less any this deskd doesn't know.
     */
    public static List<String> effectiveGrants(String role, Collection<String> claimed) {
        if (LEAD.equals(role)) {
            return GRANTS;
        }
        if (!OFFICER.equals(role)) {
            return List.of();
        }
        List<String> grants = new ArrayList<>();
        for (String grant : GRANTS) {
            if (claimed.contains(grant)) {
                grants.add(grant);
            }
        }
        return List.copyOf(grants);
    }

    public boolean isGuildMember() {
        return GUILD_MEMBER.equals(kind);
    }

    /** True for the owner, and for a guild member who holds the grant ({@code lead} holds all of them). */
    public boolean has(String grant) {
        return OWNER.equals(kind) || grants.contains(grant);
    }

    /** The same person: a refresh may change everything else. */
    public boolean samePerson(Caller other) {
        return kind.equals(other.kind) && java.util.Objects.equals(memberId, other.memberId);
    }

    /** As services get it, every key present. */
    public Map<String, Object> toJson() {
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("kind", kind);
        json.put("memberId", memberId);
        json.put("role", role);
        json.put("grants", grants);
        json.put("name", name);
        json.put("badge", badge);
        json.put("teen", teen);
        return json;
    }

    /** Names a guild member by role only: never the name or id, which stay out of logs. */
    @Override
    public String toString() {
        return "Caller[" + kind + (role == null ? "" : ", " + role) + "]";
    }
}
