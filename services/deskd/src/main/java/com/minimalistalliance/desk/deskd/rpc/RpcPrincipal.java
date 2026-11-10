package com.minimalistalliance.desk.deskd.rpc;

/**
 * Who a request is from, taken from the session's verified token.
 *
 * @param sub the token's subject
 * @param scope {@link #OWNER}, {@link #EXPORT} or {@link #GUILD_MEMBER}, as the token said (API.md section 9)
 * @param sessionId the desk session carrying the request
 * @param video the token lets this session see the Browser
 * @param input the token lets this session drive the Browser
 * @param caller who it is, as relayed services get it
 */
public record RpcPrincipal(String sub, String scope, String sessionId, boolean video, boolean input, Caller caller) {

    /** The desk's owner, with everything the token allows. */
    public static final String OWNER = "owner";
    /** The owner too, but only for taking their data away: desk.status.get and data.* (ADR draft, decision 6). */
    public static final String EXPORT = "export";
    /** A member of the guild whose desk this is, on a guild desk only (API.md section 14). */
    public static final String GUILD_MEMBER = "guild_member";

    public RpcPrincipal(String sub, String scope, String sessionId, boolean video, boolean input) {
        this(sub, scope, sessionId, video, input, Caller.THE_OWNER);
    }

    public boolean isGuildMember() {
        return GUILD_MEMBER.equals(scope);
    }
}
