package com.minimalistalliance.desk.deskd.session;

import com.minimalistalliance.desk.deskd.rpc.Caller;
import java.time.Instant;
import java.util.Objects;

/**
 * What a verified desk token allows. Only a {@link SessionAuthorizer} makes these, so holding one
 * means the token passed.
 *
 * @param sub the token's sub: the owner's user id, or a guild member's {@code gm-…}
 * @param sid the token's sid
 * @param scope owner, export or guild_member. A refresh must keep it (API.md section 9)
 * @param expectedFingerprint the token's cnf as 64 lowercase hex chars
 * @param video the session may receive the Browser stream
 * @param input the session may inject input
 * @param issuedAt the token's iat, which revocation by tokensValidAfter goes by
 * @param validUntil when the session closes unless refreshed: exp + 30 s
 * @param caller who it is, from the token alone ({@link Caller})
 * @param guildId a guild member's {@code ma_gid}, which a refresh must keep; null otherwise
 */
public record SessionGrant(
        String sub,
        String sid,
        String scope,
        String expectedFingerprint,
        boolean video,
        boolean input,
        Instant issuedAt,
        Instant validUntil,
        Caller caller,
        String guildId) {

    public SessionGrant {
        Objects.requireNonNull(caller, "caller");
    }

    /** The owner's, as every token was before guild members. */
    public SessionGrant(
            String sub,
            String sid,
            String scope,
            String expectedFingerprint,
            boolean video,
            boolean input,
            Instant issuedAt,
            Instant validUntil) {
        this(sub, sid, scope, expectedFingerprint, video, input, issuedAt, validUntil, Caller.THE_OWNER, null);
    }

    /** The same user and tab certificate, which is what makes a new session replace an old one. */
    boolean sameHolder(SessionGrant other) {
        return sub.equals(other.sub)
                && scope.equals(other.scope)
                && expectedFingerprint.equals(other.expectedFingerprint);
    }

    /**
     * A refresh must keep all of these. Step-up, which may change sid, isn't built yet. A guild member's refresh may
     * change their role, grants, name, badge and teen flag, and nothing else of who they are.
     */
    public boolean sameSession(SessionGrant other) {
        return sameHolder(other)
                && sid.equals(other.sid)
                && caller.samePerson(other.caller)
                && Objects.equals(guildId, other.guildId);
    }
}
