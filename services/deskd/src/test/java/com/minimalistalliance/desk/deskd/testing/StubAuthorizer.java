package com.minimalistalliance.desk.deskd.testing;

import com.minimalistalliance.desk.deskd.session.SessionAuthorizer;
import com.minimalistalliance.desk.deskd.session.SessionGrant;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/** Knows the tokens a test gave it, and refuses every other one. The test stands in for ES256. */
public final class StubAuthorizer implements SessionAuthorizer {

    private final Map<String, SessionGrant> grants = new ConcurrentHashMap<>();
    private final Set<String> revokedSids = ConcurrentHashMap.newKeySet();
    private volatile Runnable afterCheck = () -> {};

    public void allow(String token, SessionGrant grant) {
        grants.put(token, grant);
    }

    public void revokeSid(String sid) {
        revokedSids.add(sid);
    }

    /** Runs once a token has passed on session.open, for what lands while the token is being checked. */
    public void afterCheck(Runnable action) {
        afterCheck = action;
    }

    /** A token for this user and this certificate, good for an hour. */
    public void allow(String token, String sub, String fingerprint) {
        allow(token, grant(sub, fingerprint, Duration.ofHours(1)));
    }

    public static SessionGrant grant(String sub, String fingerprint, Duration validFor) {
        return new SessionGrant(sub, "sid-" + sub, "owner", fingerprint, true, true, Instant.now(), Instant.now().plus(validFor));
    }

    @Override
    public SessionGrant authorizeOpen(String deskToken, Admission admission) throws RefusedException {
        SessionGrant grant = require(deskToken);
        afterCheck.run();
        admission.check(grant);
        return grant;
    }

    @Override
    public boolean isRevoked(SessionGrant grant) {
        return revokedSids.contains(grant.sid());
    }

    @Override
    public SessionGrant authorizeRefresh(String deskToken, SessionGrant current) throws RefusedException {
        return require(deskToken);
    }

    private SessionGrant require(String deskToken) throws RefusedException {
        SessionGrant grant = grants.get(deskToken);
        if (grant == null) {
            throw new RefusedException("invalid_token");
        }
        return grant;
    }
}
