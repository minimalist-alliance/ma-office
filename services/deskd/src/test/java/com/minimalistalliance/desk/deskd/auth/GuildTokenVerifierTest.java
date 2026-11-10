package com.minimalistalliance.desk.deskd.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.session.SessionAuthorizer;
import com.minimalistalliance.desk.deskd.session.SessionGrant;
import com.minimalistalliance.desk.deskd.testing.FakePlatform;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import com.minimalistalliance.desk.deskd.testing.TestTokens;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** A guild member's token on a guild desk, every claim of auth.md 4.5 (0.3.30), and the typ kept to its kind of desk. */
class GuildTokenVerifierTest {

    private static final String TAB = "cd".repeat(32);
    private static final Instant NOW = Instant.parse("2026-11-07T12:00:00Z");

    private FakePlatform platform;
    private PlatformHttp http;
    private MutableClock clock;
    private Revocations revocations;
    private DeskTokenVerifier verifier;
    private volatile boolean guildDesk = true;
    private volatile String guildId = TestTokens.GUILD_ID;
    private volatile String userId = null;

    @BeforeEach
    void setUp() throws Exception {
        platform = new FakePlatform();
        http = new PlatformHttp();
        clock = new MutableClock(NOW);
        revocations = new Revocations(clock);
        JwksCache keys = new JwksCache(http, () -> platform.url() + "/.well-known/jwks.json", clock);
        verifier = new DeskTokenVerifier(new DeskTokenVerifier.Trust() {
            @Override
            public String deskId() {
                return TestTokens.DESK_ID;
            }

            @Override
            public String userId() {
                return userId;
            }

            @Override
            public String issuer() {
                return TestTokens.ISSUER;
            }

            @Override
            public boolean guildDesk() {
                return guildDesk;
            }

            @Override
            public String guildId() {
                return guildId;
            }
        }, keys, revocations, clock);
    }

    @AfterEach
    void tearDown() {
        http.close();
        platform.close();
    }

    private Map<String, Object> claims() {
        return platform.tokens.memberClaims(TAB, NOW);
    }

    private String sign(Map<String, Object> claims) {
        return platform.tokens.es256(TestTokens.guildHeader(), claims);
    }

    private String with(Consumer<Map<String, Object>> change) {
        Map<String, Object> claims = claims();
        change.accept(claims);
        return sign(claims);
    }

    private void assertRefused(String token, String code) {
        assertThatThrownBy(() -> verifier.authorizeOpen(token))
                .isInstanceOfSatisfying(SessionAuthorizer.RefusedException.class, e -> assertThat(e.code()).isEqualTo(code));
    }

    @Test
    void aGoodMemberTokenGivesAMemberWithNoVideoOrInput() throws Exception {
        SessionGrant grant = verifier.authorizeOpen(platform.tokens.mintMember(TAB, NOW));
        assertThat(grant.scope()).isEqualTo("guild_member");
        assertThat(grant.sub()).isEqualTo(TestTokens.MEMBER_ID);
        assertThat(grant.video()).isFalse();
        assertThat(grant.input()).isFalse();
        assertThat(grant.expectedFingerprint()).isEqualTo(TAB);
        assertThat(grant.guildId()).isEqualTo(TestTokens.GUILD_ID);
        assertThat(grant.validUntil()).isEqualTo(NOW.plusSeconds(330));
        Caller caller = grant.caller();
        assertThat(caller.kind()).isEqualTo("guild_member");
        assertThat(caller.memberId()).isEqualTo(TestTokens.MEMBER_ID);
        assertThat(caller.role()).isEqualTo("officer");
        assertThat(caller.grants()).containsExactly("moderate", "invite");
        assertThat(caller.name()).isEqualTo("Sam");
        assertThat(caller.badge()).isEqualTo("officer");
        assertThat(caller.teen()).isFalse();
        assertThat(caller.toString()).doesNotContain("Sam").doesNotContain(TestTokens.MEMBER_ID);
    }

    @Test
    void theRoleDecidesTheGrantsAndAnUnknownGrantIsAbsent() throws Exception {
        Caller lead = verifier.authorizeOpen(with(c -> {
            c.put("ma_grole", "lead");
            c.put("ma_grants", List.of());
        })).caller();
        assertThat(lead.grants()).containsExactlyElementsOf(Caller.GRANTS);
        Caller member = verifier.authorizeOpen(with(c -> {
            c.put("ma_grole", "member");
            c.put("ma_grants", List.of("moderate", "manage_agents"));
        })).caller();
        assertThat(member.grants()).isEmpty();
        Caller officer = verifier.authorizeOpen(with(c -> c.put("ma_grants", List.of("manage_agents", "fly", "moderate", "moderate")))).caller();
        assertThat(officer.grants()).containsExactly("moderate", "manage_agents");
        Caller teen = verifier.authorizeOpen(with(c -> {
            c.put("ma_teen", true);
            c.put("ma_badge", null);
        })).caller();
        assertThat(teen.teen()).isTrue();
        assertThat(teen.badge()).isNull();
    }

    @Test
    void everyClaimMissingIsRefused() {
        List<String> required = new ArrayList<>(Arrays.asList(
                "iss", "sub", "scope", "sid", "jti", "iat", "nbf", "exp", "auth_time", "cnf", "ma_grole", "ma_grants",
                "ma_name", "ma_badge", "ma_teen"));
        for (String claim : required) {
            assertThatThrownBy(() -> verifier.authorizeOpen(with(c -> c.remove(claim))))
                    .as(claim)
                    .isInstanceOfSatisfying(SessionAuthorizer.RefusedException.class,
                            e -> assertThat(e.code()).isEqualTo("invalid_token"));
        }
        // aud and ma_gid name the desk: those are wrong_desk, as a desk token's aud is.
        assertRefused(with(c -> c.remove("aud")), "wrong_desk");
        assertRefused(with(c -> c.remove("ma_gid")), "wrong_desk");
    }

    @Test
    void everyClaimMalformedIsRefused() {
        List<Consumer<Map<String, Object>>> bad = List.of(
                c -> c.put("sub", "7d1c0e4a-5b3f-4c2d-9e8a-1f2b3c4d5e6f"),
                c -> c.put("sub", "gm-UPPER"),
                c -> c.put("sub", ""),
                c -> c.put("scope", "owner"),
                c -> c.put("scope", "export"),
                c -> c.put("ma_grole", "founder"),
                c -> c.put("ma_grole", null),
                c -> c.put("ma_grants", "moderate"),
                c -> c.put("ma_grants", List.of("moderate", 3)),
                c -> c.put("ma_name", ""),
                c -> c.put("ma_name", "a\u0000b"),
                c -> c.put("ma_name", "x".repeat(129)),
                c -> c.put("ma_name", 7),
                c -> c.put("ma_badge", "member"),
                c -> c.put("ma_teen", "false"),
                c -> c.put("ma_teen", null),
                c -> c.put("auth_time", "yesterday"),
                c -> c.put("cnf", Map.of("x5t#S256", "AAAA")),
                c -> c.put("iat", 1.5));
        for (int i = 0; i < bad.size(); i++) {
            Consumer<Map<String, Object>> change = bad.get(i);
            assertThatThrownBy(() -> verifier.authorizeOpen(with(change)))
                    .as("case %d", i)
                    .isInstanceOfSatisfying(SessionAuthorizer.RefusedException.class,
                            e -> assertThat(e.code()).isEqualTo("invalid_token"));
        }
    }

    @Test
    void anotherDeskOrGuildIsWrongDesk() {
        assertRefused(with(c -> c.put("aud", "d-otherdesk0001")), "wrong_desk");
        assertRefused(with(c -> c.put("aud", List.of(TestTokens.DESK_ID))), "wrong_desk");
        assertRefused(with(c -> c.put("ma_gid", "gu-another0guild")), "wrong_desk");
    }

    @Test
    void aGuildDeskTakesNoDeskTokenAndNoOtherDeskTakesAGuildToken() {
        userId = TestTokens.OWNER_ID;
        // An owner's token, its own typ, on a guild desk: the Founder comes as a member.
        assertRefused(platform.tokens.mint(TAB, NOW), "invalid_token");
        // A member's claims under the desk typ.
        assertRefused(platform.tokens.es256(TestTokens.header(), claims()), "invalid_token");
        // And a member's token on a Personal desk.
        guildDesk = false;
        assertRefused(platform.tokens.mintMember(TAB, NOW), "invalid_token");
    }

    @Test
    void aGuildDeskWhoseGuildIsntKnownYetIsNotReady() {
        guildId = null;
        assertRefused(platform.tokens.mintMember(TAB, NOW), "desk_not_ready");
    }

    @Test
    void theTimeWindowAndLifetimeHoldAsForDeskTokens() {
        assertRefused(with(c -> c.put("exp", NOW.getEpochSecond() + 301)), "invalid_token");
        clock.advance(Duration.ofSeconds(329));
        assertThat(verifierPasses(platform.tokens.mintMember(TAB, NOW))).isTrue();
        // exp + 30 s, when a session that wasn't refreshed closes.
        clock.advance(Duration.ofSeconds(1));
        assertRefused(platform.tokens.mintMember(TAB, NOW), "invalid_token");
    }

    private boolean verifierPasses(String token) {
        try {
            verifier.authorizeOpen(token);
            return true;
        } catch (SessionAuthorizer.RefusedException e) {
            return false;
        }
    }

    @Test
    void aJtiWorksOnce() throws Exception {
        String token = platform.tokens.mintMember(TAB, NOW);
        verifier.authorizeOpen(token);
        assertRefused(token, "invalid_token");
    }

    @Test
    void aRefreshMayChangeTheRoleButNotWhoOrWhichSession() throws Exception {
        SessionGrant current = verifier.authorizeOpen(platform.tokens.mintMember(TAB, NOW));
        SessionGrant demoted = verifier.authorizeRefresh(with(c -> {
            c.put("ma_grole", "member");
            c.put("ma_grants", List.of());
            c.put("ma_name", "Sam K");
            c.put("ma_badge", null);
        }), current);
        assertThat(demoted.caller().role()).isEqualTo("member");
        assertThat(demoted.caller().grants()).isEmpty();
        assertThat(demoted.caller().name()).isEqualTo("Sam K");
        for (Consumer<Map<String, Object>> change : List.<Consumer<Map<String, Object>>>of(
                c -> c.put("sub", "gm-someoneelse1"),
                c -> c.put("sid", "s-another"),
                c -> c.put("cnf", Map.of("x5t#S256", java.util.Base64.getUrlEncoder().withoutPadding()
                        .encodeToString(java.util.HexFormat.of().parseHex("ef".repeat(32))))))) {
            assertThatThrownBy(() -> verifier.authorizeRefresh(with(change), current))
                    .isInstanceOfSatisfying(SessionAuthorizer.RefusedException.class,
                            e -> assertThat(e.code()).isEqualTo("invalid_token"));
        }
    }

    @Test
    void aRevokedSignInIsRefused() {
        revocations.apply(List.of("s-membersession"), List.of(), null);
        assertRefused(platform.tokens.mintMember(TAB, NOW), "invalid_token");
    }

    @Test
    void theRosterHasTheLastWordAndARefusalLeavesTheJti() throws Exception {
        List<Caller> checked = new ArrayList<>();
        verifier.checkMembers(caller -> {
            checked.add(caller);
            throw new SessionAuthorizer.RefusedException("invalid_token");
        });
        String token = platform.tokens.mintMember(TAB, NOW);
        assertRefused(token, "invalid_token");
        assertThat(checked).hasSize(1);
        verifier.checkMembers(caller -> {});
        // Not used up by the roster's refusal: the same token gets in once the roster agrees.
        assertThat(verifier.authorizeOpen(token).caller().memberId()).isEqualTo(TestTokens.MEMBER_ID);
    }

    @Test
    void aMemberTokenNeedsNoUserIdTag() throws Exception {
        userId = null;
        assertThat(verifier.authorizeOpen(platform.tokens.mintMember(TAB, NOW)).sub()).isEqualTo(TestTokens.MEMBER_ID);
        clock.advance(Duration.ofSeconds(1));
    }
}
