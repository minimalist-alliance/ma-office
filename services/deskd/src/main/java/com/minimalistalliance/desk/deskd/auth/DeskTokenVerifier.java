package com.minimalistalliance.desk.deskd.auth;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import com.minimalistalliance.desk.deskd.session.SessionAuthorizer;
import com.minimalistalliance.desk.deskd.session.SessionGrant;
import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.JWSObject;
import com.nimbusds.jose.JWSVerifier;
import java.text.ParseException;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * deskd's one way of checking a desk token, offline, on every session.open, session.refresh and AUTH
 * (design 4.2.2, auth.md 4.4). Check 7, the offer's fingerprint, comes later, against the grant's
 * expected fingerprint (desk-runtime.md 4.4).
 *
 * <p>Nimbus handles the JWS and the signature. Claims go through deskd's own JSON, because it rejects
 * repeated keys and leaves {@code aud} a plain string, so an array can't pass.
 *
 * <p>Two scopes pass: owner, with video and input, and export, with neither, which may call only desk.status.get and
 * data.* ({@link com.minimalistalliance.desk.deskd.rpc.RpcDispatcher}). Both are the owner's: sub must be the desk's
 * owner. Support scope and step-up aren't built yet, so any other scope is refused.
 *
 * <p><b>A guild desk</b> (the DeskKind tag {@code guild}) takes only guild members' tokens, {@code typ ma-guild+jwt} and
 * scope {@code guild_member}, and nothing else takes them (API.md section 14). Every claim must be there and well formed,
 * {@code aud} this desk, {@code ma_gid} the guild in config, and {@code sub} a member id: the owner's checks don't apply,
 * as a guild desk is nobody's. An owner's or export token is refused there, the Founder's included: the Founder comes as
 * a member with role {@code lead}, so nothing on a guild desk sees members' agent conversations (draft decision 6).
 * {@link MemberCheck} then holds a member to the guild's roster, once one has been read.
 */
public final class DeskTokenVerifier implements SessionAuthorizer {

    private static final Logger log = LoggerFactory.getLogger(DeskTokenVerifier.class);

    static final String TOKEN_TYPE = "ma-desk+jwt";
    static final String GUILD_TOKEN_TYPE = "ma-guild+jwt";
    /** auth.md's examples are {@code gm-} and 12 lowercase letters or digits. */
    static final Pattern MEMBER_ID = Pattern.compile("gm-[a-z0-9]{4,40}");
    private static final int MAX_NAME = 128;
    private static final int MAX_GRANTS = 32;
    private static final int MAX_TOKEN_CHARS = 4096;
    private static final long SKEW_SECONDS = 30;
    private static final long MAX_LIFETIME_SECONDS = 300;
    private static final int CNF_BYTES = 32;
    private static final String INVALID = "invalid_token";
    private static final String WRONG_DESK = "wrong_desk";
    private static final String NOT_READY = "desk_not_ready";

    /** What tokens are checked against. Every value is null until known, and then nothing passes. */
    public interface Trust {
        /** The DeskId tag. */
        String deskId();

        /** The UserId tag. */
        String userId();

        /** endpoints.issuer from config. */
        String issuer();

        /** The DeskKind tag says {@code guild}: only guild members' tokens pass here, and only there. */
        default boolean guildDesk() {
            return false;
        }

        /** config's {@code guild.guildId}, which a member's {@code ma_gid} must equal. Null until known. */
        default String guildId() {
            return null;
        }
    }

    private record Checked(SessionGrant grant, String jti, Instant usableUntil) {}

    /**
     * Whether a verified guild member may have a session now: the guild's roster, once deskd has read one. It runs after
     * every check of the token's own and before its {@code jti} is used up, so a token turned away can try again once the
     * roster has caught up.
     */
    @FunctionalInterface
    public interface MemberCheck {
        /** @throws RefusedException with the code for session.reject */
        void check(Caller caller) throws RefusedException;
    }

    private final Trust trust;
    private final JwksCache keys;
    private final Revocations revocations;
    private final Clock clock;
    private final ReplayCache replays = new ReplayCache();
    private volatile MemberCheck members = caller -> {};

    public DeskTokenVerifier(Trust trust, JwksCache keys, Revocations revocations, Clock clock) {
        this.trust = trust;
        this.keys = keys;
        this.revocations = revocations;
        this.clock = clock;
    }

    /** The roster's check of guild members. Set once, as deskd starts. */
    public void checkMembers(MemberCheck check) {
        members = check;
    }

    @Override
    public SessionGrant authorizeOpen(String deskToken, Admission admission) throws RefusedException {
        Checked checked = check(deskToken);
        checkMember(checked.grant());
        admission.check(checked.grant());
        return claim(checked);
    }

    @Override
    public SessionGrant authorizeRefresh(String deskToken, SessionGrant current) throws RefusedException {
        Checked checked = check(deskToken);
        if (!current.sameSession(checked.grant())) {
            throw refuse("a refresh changes the session", INVALID);
        }
        checkMember(checked.grant());
        return claim(checked);
    }

    private void checkMember(SessionGrant grant) throws RefusedException {
        if (grant.caller().isGuildMember()) {
            members.check(grant.caller());
        }
    }

    @Override
    public boolean isRevoked(SessionGrant grant) {
        return revocations.isRevoked(grant.sid(), grant.sub(), grant.issuedAt());
    }

    /** Last, so a token that fails anything else hasn't used up its jti. */
    private SessionGrant claim(Checked checked) throws RefusedException {
        if (!replays.claim(checked.jti(), checked.usableUntil(), clock.instant())) {
            throw refuse("a jti seen before", INVALID);
        }
        return checked.grant();
    }

    private Checked check(String token) throws RefusedException {
        String deskId = trust.deskId();
        String userId = trust.userId();
        String issuer = trust.issuer();
        boolean guildDesk = trust.guildDesk();
        // A guild desk has no owner, so no UserId to wait for.
        if (deskId == null || (userId == null && !guildDesk) || issuer == null) {
            throw refuse("identity or config isn't known yet", NOT_READY);
        }
        String guildId = guildDesk ? trust.guildId() : null;
        if (guildDesk && guildId == null) {
            throw refuse("a guild desk whose guild isn't known yet", NOT_READY);
        }
        if (token == null || token.isEmpty() || token.length() > MAX_TOKEN_CHARS) {
            throw refuse("a missing or oversized token", INVALID);
        }
        JWSObject jws;
        try {
            jws = JWSObject.parse(token);
        } catch (ParseException | RuntimeException e) {
            // This also takes alg none, which isn't a JWS. Nimbus throws NullPointerException on a
            // header of null, and a bad token must always read as invalid_token, never as not ready.
            throw refuse("a token that won't parse", INVALID);
        }
        // Each kind of desk takes one typ, and never the other's.
        verifySignature(jws, guildDesk ? GUILD_TOKEN_TYPE : TOKEN_TYPE);
        Map<String, Object> claims;
        try {
            claims = Json.parseObject(jws.getPayload().toBytes());
        } catch (JsonFormatException e) {
            throw refuse("claims that aren't one JSON object", INVALID);
        }
        return guildDesk ? checkMemberClaims(claims, deskId, guildId, issuer) : checkClaims(claims, deskId, userId, issuer);
    }

    private void verifySignature(JWSObject jws, String type) throws RefusedException {
        JWSHeader header = jws.getHeader();
        if (!JWSAlgorithm.ES256.equals(header.getAlgorithm())) {
            throw refuse("an algorithm other than ES256", INVALID);
        }
        if (header.getType() == null || !type.equals(header.getType().getType())) {
            throw refuse("a typ other than this desk's", INVALID);
        }
        String kid = header.getKeyID();
        if (kid == null || kid.isEmpty()) {
            throw refuse("no kid", INVALID);
        }
        JWSVerifier verifier;
        try {
            verifier = keys.verifierFor(kid);
        } catch (JwksCache.KeysUnavailableException e) {
            throw refuse("no signing keys to check against", NOT_READY);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw refuse("interrupted while fetching keys", NOT_READY);
        }
        if (verifier == null) {
            throw refuse("an unknown kid", INVALID);
        }
        try {
            if (!jws.verify(verifier)) {
                throw refuse("a bad signature", INVALID);
            }
        } catch (JOSEException | IllegalStateException e) {
            throw refuse("a signature that can't be checked", INVALID);
        }
    }

    private Checked checkClaims(Map<String, Object> claims, String deskId, String userId, String issuer)
            throws RefusedException {
        if (!issuer.equals(Json.string(claims, "iss"))) {
            throw refuse("a wrong iss", INVALID);
        }
        if (!deskId.equals(Json.string(claims, "aud"))) {
            throw refuse("a wrong aud", WRONG_DESK);
        }
        if (!userId.equals(Json.string(claims, "ma_owner"))) {
            throw refuse("a wrong ma_owner", WRONG_DESK);
        }
        Long iat = wholeNumber(claims, "iat");
        Long nbf = wholeNumber(claims, "nbf");
        Long exp = wholeNumber(claims, "exp");
        if (iat == null || nbf == null || exp == null) {
            throw refuse("a missing time claim", INVALID);
        }
        Instant now = clock.instant();
        long nowSeconds = now.getEpochSecond();
        if (exp - iat > MAX_LIFETIME_SECONDS || exp <= iat) {
            throw refuse("a lifetime out of range", INVALID);
        }
        // now < exp + 30 with whole seconds on the right: at exactly exp + 30 it has expired.
        if (nowSeconds < nbf - SKEW_SECONDS || nowSeconds >= exp + SKEW_SECONDS || nowSeconds < iat - SKEW_SECONDS) {
            throw refuse("a token outside its time window", INVALID);
        }
        String scope = Json.string(claims, "scope");
        if (!RpcPrincipal.OWNER.equals(scope) && !RpcPrincipal.EXPORT.equals(scope)) {
            throw refuse("a scope other than owner or export", INVALID);
        }
        String sub = nonEmpty(claims, "sub");
        String sid = nonEmpty(claims, "sid");
        String jti = nonEmpty(claims, "jti");
        if (sub == null || sid == null || jti == null) {
            throw refuse("a missing sub, sid or jti", INVALID);
        }
        // Owner scope means the desk's owner is the one connecting (auth.md 4.2), and an export is theirs too.
        if (!sub.equals(userId)) {
            throw refuse("a sub other than the owner", INVALID);
        }
        Instant issuedAt = Instant.ofEpochSecond(iat);
        if (revocations.isRevoked(sid, sub, issuedAt)) {
            throw refuse("a revoked token", INVALID);
        }
        String expected = fingerprintHex(claims);
        if (expected == null) {
            throw refuse("a missing or malformed cnf", INVALID);
        }
        Instant usableUntil = Instant.ofEpochSecond(exp + SKEW_SECONDS);
        // An export session sees nothing of the screen and types nothing: it only takes the owner's data away.
        boolean owner = RpcPrincipal.OWNER.equals(scope);
        SessionGrant grant = new SessionGrant(sub, sid, scope, expected, owner, owner, issuedAt, usableUntil);
        return new Checked(grant, jti, usableUntil);
    }

    /**
     * A guild member's token (API.md section 14). Every claim of the contract must be there and well formed; an unknown
     * grant counts as absent, and the role decides the grants in the end ({@link Caller#effectiveGrants}). No Browser
     * exists on a guild desk, so the grant has neither video nor input.
     */
    private Checked checkMemberClaims(Map<String, Object> claims, String deskId, String guildId, String issuer)
            throws RefusedException {
        if (!issuer.equals(Json.string(claims, "iss"))) {
            throw refuse("a wrong iss", INVALID);
        }
        if (!(claims.get("aud") instanceof String aud) || !deskId.equals(aud)) {
            throw refuse("a wrong aud", WRONG_DESK);
        }
        if (!(claims.get("ma_gid") instanceof String gid) || !guildId.equals(gid)) {
            throw refuse("a wrong ma_gid", WRONG_DESK);
        }
        if (!RpcPrincipal.GUILD_MEMBER.equals(claims.get("scope"))) {
            throw refuse("a scope other than guild_member", INVALID);
        }
        Long iat = wholeNumber(claims, "iat");
        Long nbf = wholeNumber(claims, "nbf");
        Long exp = wholeNumber(claims, "exp");
        Long authTime = wholeNumber(claims, "auth_time");
        if (iat == null || nbf == null || exp == null || authTime == null) {
            throw refuse("a missing time claim", INVALID);
        }
        long nowSeconds = clock.instant().getEpochSecond();
        if (exp - iat > MAX_LIFETIME_SECONDS || exp <= iat) {
            throw refuse("a lifetime out of range", INVALID);
        }
        if (nowSeconds < nbf - SKEW_SECONDS || nowSeconds >= exp + SKEW_SECONDS || nowSeconds < iat - SKEW_SECONDS) {
            throw refuse("a token outside its time window", INVALID);
        }
        String sub = nonEmpty(claims, "sub");
        String sid = nonEmpty(claims, "sid");
        String jti = nonEmpty(claims, "jti");
        if (sub == null || sid == null || jti == null || !MEMBER_ID.matcher(sub).matches()) {
            throw refuse("a missing or malformed sub, sid or jti", INVALID);
        }
        Object role = claims.get("ma_grole");
        if (!Caller.LEAD.equals(role) && !Caller.OFFICER.equals(role) && !Caller.MEMBER.equals(role)) {
            throw refuse("a missing or unknown ma_grole", INVALID);
        }
        List<String> claimed = grants(claims.get("ma_grants"));
        if (claimed == null) {
            throw refuse("a missing or malformed ma_grants", INVALID);
        }
        String name = displayName(claims.get("ma_name"));
        if (name == null) {
            throw refuse("a missing or malformed ma_name", INVALID);
        }
        Object badge = claims.get("ma_badge");
        if (!claims.containsKey("ma_badge") || (badge != null && !Caller.OFFICER.equals(badge) && !Caller.LEAD.equals(badge))) {
            throw refuse("a missing or unknown ma_badge", INVALID);
        }
        if (!(claims.get("ma_teen") instanceof Boolean teen)) {
            throw refuse("a missing or malformed ma_teen", INVALID);
        }
        Instant issuedAt = Instant.ofEpochSecond(iat);
        if (revocations.isRevoked(sid, sub, issuedAt)) {
            throw refuse("a revoked token", INVALID);
        }
        String expected = fingerprintHex(claims);
        if (expected == null) {
            throw refuse("a missing or malformed cnf", INVALID);
        }
        String grole = (String) role;
        Caller caller = new Caller(Caller.GUILD_MEMBER, sub, grole, Caller.effectiveGrants(grole, claimed), name,
                (String) badge, teen);
        Instant usableUntil = Instant.ofEpochSecond(exp + SKEW_SECONDS);
        SessionGrant grant = new SessionGrant(
                sub, sid, RpcPrincipal.GUILD_MEMBER, expected, false, false, issuedAt, usableUntil, caller, guildId);
        return new Checked(grant, jti, usableUntil);
    }

    /** A list of strings, at most {@link #MAX_GRANTS}, or null if it's anything else. */
    private static List<String> grants(Object value) {
        if (!(value instanceof List<?> list) || list.size() > MAX_GRANTS) {
            return null;
        }
        List<String> grants = new ArrayList<>(list.size());
        for (Object item : list) {
            if (!(item instanceof String grant)) {
                return null;
            }
            grants.add(grant);
        }
        return grants;
    }

    /** 1 to 128 characters, none of them a control character, or null. */
    static String displayName(Object value) {
        if (!(value instanceof String name) || name.isBlank() || name.length() > MAX_NAME) {
            return null;
        }
        for (int i = 0; i < name.length(); i++) {
            if (Character.isISOControl(name.charAt(i))) {
                return null;
            }
        }
        return name;
    }

    /** cnf.x5t#S256 as 64 lowercase hex chars, which session.create wants. */
    private static String fingerprintHex(Map<String, Object> claims) {
        Map<String, Object> cnf = Json.object(claims, "cnf");
        String encoded = cnf == null ? null : Json.string(cnf, "x5t#S256");
        if (encoded == null) {
            return null;
        }
        try {
            byte[] digest = Base64.getUrlDecoder().decode(encoded);
            return digest.length == CNF_BYTES ? HexFormat.of().formatHex(digest) : null;
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static String nonEmpty(Map<String, Object> claims, String key) {
        String value = Json.string(claims, key);
        return value == null || value.isEmpty() ? null : value;
    }

    private static Long wholeNumber(Map<String, Object> claims, String key) {
        Object value = claims.get(key);
        return value instanceof Integer || value instanceof Long ? ((Number) value).longValue() : null;
    }

    /** Says why at debug level, from a fixed list: nothing from the token itself. */
    private static RefusedException refuse(String why, String code) {
        log.debug("token refused: {}", why);
        return new RefusedException(code);
    }
}
