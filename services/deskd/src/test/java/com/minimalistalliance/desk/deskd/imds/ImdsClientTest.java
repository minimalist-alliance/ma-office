package com.minimalistalliance.desk.deskd.imds;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;

import com.minimalistalliance.desk.deskd.aws.AwsCredentials;
import com.minimalistalliance.desk.deskd.aws.RoleCredentials;
import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.testing.FakePlatform;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import com.minimalistalliance.desk.deskd.testing.TestTokens;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ImdsClientTest {

    private FakePlatform platform;
    private PlatformHttp http;
    private ImdsClient imds;

    @TempDir
    Path dir;

    @BeforeEach
    void setUp() throws Exception {
        platform = new FakePlatform();
        http = new PlatformHttp();
        imds = new ImdsClient(http, platform.url());
    }

    @AfterEach
    void tearDown() {
        http.close();
        platform.close();
    }

    @Test
    void readsEveryFactWithOneSessionToken() throws Exception {
        InstanceIdentity identity = imds.readIdentity();
        assertThat(identity.deskId()).isEqualTo(TestTokens.DESK_ID);
        assertThat(identity.userId()).isEqualTo(TestTokens.OWNER_ID);
        assertThat(identity.deskKind()).isEqualTo("test");
        assertThat(identity.env()).isEqualTo("staging");
        assertThat(identity.instanceId()).isEqualTo(FakePlatform.INSTANCE_ID);
        assertThat(identity.publicIpv4()).isEqualTo("203.0.113.7");
        assertThat(identity.instanceType()).isEqualTo("c7g.large");
        assertThat(identity.amiId()).isEqualTo("ami-0123456789abcdef0");
        assertThat(platform.imdsTokenPuts).hasValue(1);
    }

    /** Regression: "every request gets one second" didn't hold once the headers had arrived. */
    @Test
    void aReplyThatStallsAfterItsHeadersFailsInsideTheTimeout() {
        platform.imdsStalled = true;
        assertTimeoutPreemptively(Duration.ofSeconds(5), () ->
                assertThatThrownBy(imds::readIdentity).isInstanceOf(IOException.class));
    }

    @Test
    void aMissingTagIsAFailure() {
        platform.metadata.remove("/latest/meta-data/tags/instance/DeskId");
        assertThatThrownBy(imds::readIdentity).isInstanceOf(IOException.class);
    }

    @Test
    void aMissingAmiIdIsFine() throws Exception {
        platform.metadata.remove("/latest/meta-data/ami-id");
        assertThat(imds.readIdentity().amiId()).isNull();
    }

    @Test
    void anErrorIsAFailureAndTheNextTryWorks() throws Exception {
        platform.imdsFailuresLeft.set(1);
        assertThatThrownBy(imds::readIdentity).isInstanceOf(IOException.class);
        assertThat(imds.readIdentity().deskId()).isEqualTo(TestTokens.DESK_ID);
    }

    @Test
    void aSlowImdsFailsWithinTheOneSecondTimeout() {
        platform.imdsSlow = true;
        long started = System.nanoTime();
        assertThatThrownBy(imds::readIdentity).isInstanceOf(IOException.class);
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofMillis(2500));
    }

    @Test
    void roleCredentialsComeThroughAndHideTheirSecrets() throws Exception {
        AwsCredentials credentials = imds.roleCredentials();
        assertThat(credentials.accessKeyId()).isEqualTo(FakePlatform.ACCESS_KEY);
        assertThat(credentials.secretAccessKey()).isEqualTo(FakePlatform.SECRET_KEY);
        assertThat(credentials.sessionToken()).isEqualTo(FakePlatform.SESSION_TOKEN);
        assertThat(credentials.toString()).doesNotContain(FakePlatform.SECRET_KEY, FakePlatform.SESSION_TOKEN);
    }

    @Test
    void credentialsRefreshBeforeTheyExpireAndNotBefore() throws Exception {
        Instant now = Instant.parse("2026-11-05T00:00:00Z");
        MutableClock clock = new MutableClock(now);
        platform.credentialsExpire = now.plus(Duration.ofHours(1));
        RoleCredentials credentials = new RoleCredentials(imds, clock);

        credentials.current();
        clock.advance(Duration.ofMinutes(50));
        credentials.current();
        assertThat(platform.credentialFetches).hasValue(1);

        clock.advance(Duration.ofMinutes(6));
        platform.credentialsExpire = clock.instant().plus(Duration.ofHours(6));
        assertThat(credentials.current().expiration()).isEqualTo(platform.credentialsExpire);
        assertThat(platform.credentialFetches).hasValue(2);
    }

    @Test
    void ifImdsIsDownCredentialsStillGoodAreKeptUntilTheyExpire() throws Exception {
        Instant now = Instant.parse("2026-11-05T00:00:00Z");
        MutableClock clock = new MutableClock(now);
        platform.credentialsExpire = now.plus(Duration.ofMinutes(10));
        RoleCredentials credentials = new RoleCredentials(imds, clock);
        credentials.current();

        clock.advance(Duration.ofMinutes(8));
        platform.imdsFailuresLeft.set(100);
        assertThat(credentials.current().accessKeyId()).isEqualTo(FakePlatform.ACCESS_KEY);

        clock.advance(Duration.ofMinutes(3));
        assertThatThrownBy(credentials::current).isInstanceOf(IOException.class);
    }

    @Test
    void invalidatingMakesTheNextCallAskImds() throws Exception {
        RoleCredentials credentials = new RoleCredentials(imds, new MutableClock(Instant.now()));
        credentials.current();
        credentials.invalidate();
        credentials.current();
        assertThat(platform.credentialFetches).hasValue(2);
    }

    // ---- GDS-5: the image reads DeskKind once, and deskd uses its file

    private ImdsClient withFile(String content) throws IOException {
        Path file = dir.resolve("desk-kind");
        if (content != null) {
            Files.writeString(file, content);
        }
        return new ImdsClient(http, platform.url(), file);
    }

    @Test
    void noFileMeansIMDSsTagAsBefore() throws Exception {
        assertThat(withFile(null).readIdentity().deskKind()).isEqualTo("test");
    }

    private void tag(String kind) {
        platform.metadata.put("/latest/meta-data/tags/instance/DeskKind", kind);
    }

    @Test
    void aGuildFileWithAGuildTagIsAGuildDesk() throws Exception {
        tag("guild");
        assertThat(withFile("guild\n").readIdentity().deskKind()).isEqualTo("guild");
        assertThat(withFile("  guild \r\n").readIdentity().deskKind()).isEqualTo("guild");
    }

    @Test
    void aGuildFileWithAnyOtherTagIsRefused() throws Exception {
        for (String t : new String[] {"personal", "work", "custom", "test"}) {
            tag(t);
            assertThatThrownBy(() -> withFile("guild").readIdentity()).isInstanceOf(IOException.class)
                    .hasMessageContaining("disagree");
        }
    }

    @Test
    void aGuildFileWhenIMDSFailsIsRefused() throws Exception {
        tag("guild");
        platform.imdsFailuresLeft.set(100);
        assertThatThrownBy(() -> withFile("guild").readIdentity()).isInstanceOf(IOException.class);
    }

    @Test
    void aMemberFileTakesThePreciseKindFromIMDS() throws Exception {
        for (String t : new String[] {"personal", "work", "custom", "test"}) {
            tag(t);
            assertThat(withFile("member\n").readIdentity().deskKind()).isEqualTo(t);
        }
    }

    @Test
    void aMemberFileWithAGuildTagIsRefused() throws Exception {
        tag("guild");
        assertThatThrownBy(() -> withFile("member").readIdentity()).isInstanceOf(IOException.class)
                .hasMessageContaining("disagree");
    }

    @Test
    void aMemberFileWhenIMDSFailsIsRefusedAsAFailedReadIs() throws Exception {
        platform.imdsFailuresLeft.set(100);
        assertThatThrownBy(() -> withFile("member").readIdentity()).isInstanceOf(IOException.class);
    }

    @Test
    void aFileThatIsntGuildOrMemberIsRefused() throws Exception {
        for (String bad : new String[] {"gu1ld", "", "personal", "test", "Member", "guild member"}) {
            assertThatThrownBy(() -> withFile(bad).readIdentity()).isInstanceOf(IOException.class);
        }
    }
}
