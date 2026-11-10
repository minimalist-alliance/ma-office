package com.minimalistalliance.desk.deskd.auth;

import com.minimalistalliance.desk.deskd.session.SessionGrant;
import com.minimalistalliance.desk.deskd.session.SessionManager;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.Collection;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * What Platform has revoked, from the gateway's revoke push and from heartbeat responses, which mean
 * the same (gateway.md 3.2, auth.md 6). It only ever has to outlast the tokens it's about: a token
 * lives at most 300 s plus 30 s of skew. So an entry older than that can go, and a user who signs in
 * again isn't locked out by an old revocation.
 *
 * <p>Applying a revocation also closes the sessions it matches.
 */
public final class Revocations {

    private static final Logger log = LoggerFactory.getLogger(Revocations.class);

    /** Heartbeats repeat sids for 15 minutes, so entries are refreshed for that long. */
    private static final Duration RETENTION = Duration.ofMinutes(15);
    private static final int MAX_ENTRIES = 1024;

    private final Clock clock;
    private final ReentrantLock lock = new ReentrantLock();
    private final Map<String, Instant> sids = new LinkedHashMap<>();
    private final Map<String, Instant> users = new LinkedHashMap<>();
    private Instant tokensValidAfter;
    private volatile SessionManager sessions;

    public Revocations(Clock clock) {
        this.clock = clock;
    }

    /** Sessions are built after this class, because the verifier that sessions use reads it. */
    public void closeSessionsThrough(SessionManager manager) {
        sessions = manager;
    }

    /**
     * Records a revocation and closes matching sessions. Doesn't block.
     *
     * @param tokensValidAfterText RFC 3339, or null
     */
    public void apply(Collection<String> revokedSids, Collection<String> userIds, String tokensValidAfterText) {
        Instant now = clock.instant();
        boolean changed = false;
        lock.lock();
        try {
            purge(now);
            for (String sid : revokedSids) {
                changed |= sids.put(sid, now) == null;
            }
            for (String user : userIds) {
                // A repeat still rescans: a session opened since the first revoke must go too.
                users.put(user, now);
                changed = true;
            }
            trim(sids);
            trim(users);
            Instant after = parse(tokensValidAfterText);
            if (after != null && (tokensValidAfter == null || after.isAfter(tokensValidAfter))) {
                tokensValidAfter = after;
                changed = true;
            }
        } finally {
            lock.unlock();
        }
        SessionManager manager = sessions;
        if (changed && manager != null) {
            manager.revoke(grant -> isRevoked(grant.sid(), grant.sub(), grant.issuedAt()));
        }
    }

    /** True if a token with these claims may no longer be used. */
    boolean isRevoked(String sid, String sub, Instant issuedAt) {
        lock.lock();
        try {
            purge(clock.instant());
            if (sids.containsKey(sid)) {
                return true;
            }
            // A token from the moment of the revocation counts as revoked: iat has whole seconds.
            Instant userRevokedAt = users.get(sub);
            if (userRevokedAt != null && !issuedAt.isAfter(userRevokedAt)) {
                return true;
            }
            return tokensValidAfter != null && issuedAt.isBefore(tokensValidAfter);
        } finally {
            lock.unlock();
        }
    }

    private void purge(Instant now) {
        Instant oldest = now.minus(RETENTION);
        sids.values().removeIf(at -> at.isBefore(oldest));
        users.values().removeIf(at -> at.isBefore(oldest));
    }

    private static void trim(Map<String, Instant> entries) {
        Iterator<String> oldestFirst = entries.keySet().iterator();
        while (entries.size() > MAX_ENTRIES && oldestFirst.hasNext()) {
            oldestFirst.next();
            oldestFirst.remove();
        }
    }

    private static Instant parse(String text) {
        if (text == null) {
            return null;
        }
        try {
            return OffsetDateTime.parse(text).toInstant();
        } catch (DateTimeParseException e) {
            log.warn("ignoring a tokensValidAfter that isn't RFC 3339");
            return null;
        }
    }
}
