package com.minimalistalliance.desk.deskd.platform;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;

import com.minimalistalliance.desk.deskd.aws.AwsCredentials;
import com.minimalistalliance.desk.deskd.aws.RoleCredentials;
import com.minimalistalliance.desk.deskd.aws.SigV4;
import com.minimalistalliance.desk.deskd.imds.ImdsClient;
import com.minimalistalliance.desk.deskd.imds.InstanceIdentity;
import com.minimalistalliance.desk.deskd.testing.FakePlatform;
import java.io.IOException;
import java.net.URI;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class AgentClientTest {

    private FakePlatform platform;
    private PlatformHttp http;
    private AgentClient client;

    @BeforeEach
    void setUp() throws Exception {
        platform = new FakePlatform();
        http = new PlatformHttp();
        RoleCredentials credentials = new RoleCredentials(new ImdsClient(http, platform.url()), Clock.systemUTC());
        client = new AgentClient(http, credentials, platform::url, Clock.systemUTC());
    }

    @AfterEach
    void tearDown() {
        http.close();
        platform.close();
    }

    /** Regression: HttpRequest.timeout stops at the headers on JDK 21, so this blocked for ever. */
    @Test
    void aResponseThatStallsAfterItsHeadersFailsInsideTheTimeout() {
        platform.heartbeatReplies.add(FakePlatform.Reply.STALLED);
        assertTimeoutPreemptively(Duration.ofSeconds(5), () ->
                assertThatThrownBy(() -> client.heartbeat(Map.of("seq", 1), Duration.ofMillis(300)))
                        .isInstanceOf(IOException.class));
    }

    /** Checks what really crossed the socket, including the Host the JDK's client chose to send. */
    private static void assertSignatureHolds(FakePlatform.Request request, boolean hasBody) {
        Instant at = DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'").withZone(ZoneOffset.UTC)
                .parse(request.header("x-amz-date"), Instant::from);
        URI uri = URI.create("http://" + request.header("host") + request.path());
        Map<String, String> signed = SigV4.sign(
                request.method(),
                uri,
                hasBody ? Map.of("content-type", request.header("content-type")) : Map.of(),
                request.body(),
                "execute-api",
                "us-east-1",
                new AwsCredentials(FakePlatform.ACCESS_KEY, FakePlatform.SECRET_KEY, FakePlatform.SESSION_TOKEN, Instant.MAX),
                at);
        assertThat(request.header("authorization")).isEqualTo(signed.get("authorization"));
        assertThat(request.header("x-amz-security-token")).isEqualTo(FakePlatform.SESSION_TOKEN);
    }

    @Test
    void helloIsSignedOverWhatWasActuallySent() throws Exception {
        Map<String, Object> reply = client.hello(Map.of("instanceId", "i-1", "bootId", "b"));
        assertThat(reply).containsEntry("state", "running").containsKey("config");
        FakePlatform.Request request = platform.awaitApi("/v1/agent/hello");
        assertThat(request.method()).isEqualTo("POST");
        assertThat(request.header("content-type")).isEqualTo("application/json");
        assertThat(request.header("authorization"))
                .startsWith("AWS4-HMAC-SHA256 Credential=" + FakePlatform.ACCESS_KEY + "/")
                .contains("/us-east-1/execute-api/aws4_request")
                .contains("SignedHeaders=content-type;host;x-amz-date;x-amz-security-token,");
        assertSignatureHolds(request, true);
    }

    @Test
    void getConfigSignsAnEmptyBodyWithNoContentType() throws Exception {
        assertThat(client.config()).containsKey("endpoints");
        FakePlatform.Request request = platform.awaitApi("/v1/agent/config");
        assertThat(request.method()).isEqualTo("GET");
        assertThat(request.header("authorization")).contains("SignedHeaders=host;x-amz-date;x-amz-security-token,");
        assertSignatureHolds(request, false);
    }

    @Test
    void anExpiredTokenFromApiGatewayRefreshesCredentialsOnceAndRetries() throws Exception {
        platform.helloReplies.add(FakePlatform.Reply.of(403, "{\"message\":\"The security token included in the request is expired\"}"));
        assertThat(client.hello(Map.of())).containsEntry("state", "running");
        assertThat(platform.countApi("/v1/agent/hello")).isEqualTo(2);
        assertThat(platform.credentialFetches).hasValue(2);
    }

    @Test
    void aSecondRefusalFromApiGatewayIsAFailure() {
        platform.helloReplies.add(FakePlatform.Reply.of(403, "{\"message\":\"Forbidden\"}"));
        platform.helloReplies.add(FakePlatform.Reply.of(403, "{\"message\":\"Forbidden\"}"));
        assertThatThrownBy(() -> client.hello(Map.of()))
                .isInstanceOfSatisfying(AgentClient.ApiException.class, e -> {
                    assertThat(e.status()).isEqualTo(403);
                    assertThat(e.code()).isNull();
                });
        assertThat(platform.countApi("/v1/agent/hello")).isEqualTo(2);
    }

    @Test
    void aRefusalFromPlatformIsNotRetriedAndKeepsItsCode() {
        platform.helloReplies.add(FakePlatform.Reply.of(403, "{\"error\":{\"code\":\"desk_mismatch\",\"message\":\"no\"}}"));
        assertThatThrownBy(() -> client.hello(Map.of()))
                .isInstanceOfSatisfying(AgentClient.ApiException.class, e -> assertThat(e.code()).isEqualTo("desk_mismatch"));
        assertThat(platform.countApi("/v1/agent/hello")).isEqualTo(1);
    }

    @Test
    void retryAfterComesThrough() {
        platform.heartbeatReplies.add(new FakePlatform.Reply(429, "{\"error\":{\"code\":\"rate_limited\"}}", Map.of("Retry-After", "15")));
        assertThatThrownBy(() -> client.heartbeat(Map.of(), Duration.ofSeconds(5)))
                .isInstanceOfSatisfying(AgentClient.ApiException.class,
                        e -> assertThat(e.retryAfter()).isEqualTo(Duration.ofSeconds(15)));
    }

    @Test
    void noApiBaseIsAFailureBeforeAnythingIsSent() {
        AgentClient noBase = new AgentClient(
                http, new RoleCredentials(new ImdsClient(http, platform.url()), Clock.systemUTC()), () -> null, Clock.systemUTC());
        assertThatThrownBy(noBase::config).isInstanceOf(IOException.class);
        assertThat(platform.apiRequests).isEmpty();
    }

    @Test
    void theApiBaseFollowsTheEnvTagUnlessDeskdEnvOverridesIt() {
        DeskState byTag = new DeskState("boot", null, null);
        assertThat(byTag.apiBase()).isNull();
        byTag.setIdentity(identity("prod"));
        assertThat(byTag.apiBase()).isEqualTo("https://api.minimalistalliance.com");
        byTag.setIdentity(identity("staging"));
        assertThat(byTag.apiBase()).isEqualTo("https://api.staging.minimalistalliance.com");
        byTag.setIdentity(identity("dev"));
        assertThat(byTag.apiBase()).isNull();

        DeskState overridden = new DeskState("boot", "http://127.0.0.1:8787", null);
        overridden.setIdentity(identity("prod"));
        assertThat(overridden.apiBase()).isEqualTo("http://127.0.0.1:8787");
    }

    private static InstanceIdentity identity(String env) {
        return new InstanceIdentity("d", "u", "test", env, "i", "1.2.3.4", "t", null);
    }
}
