package com.minimalistalliance.desk.deskd.imds;

import com.minimalistalliance.desk.deskd.aws.AwsCredentials;
import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.Map;

/**
 * IMDSv2 (desk-endpoint.md 5.2): a session token from PUT, then reads with it. Every request gets one
 * second. The base URL comes from deskd.env, so a stand-in can take IMDS's place.
 *
 * <p><b>DeskKind is read once, by the image</b> (the Security review's GDS-5): a slow IMDS at boot must not let the image
 * and deskd disagree about whether this is a guild desk. When the file the image's boot unit writes exists
 * ({@code deskd.desk-kind.file}, default {@code /run/ma/desk-kind}), it holds {@code guild} or {@code member}. {@code guild}
 * makes a guild desk only if IMDS's tag says {@code guild} too. {@code member} is never a guild desk: the precise kind
 * (personal, work, custom, test) comes from IMDS, and a {@code guild} tag there is a half-guild desk. Any disagreement, any
 * other content and any IMDS failure read nothing, and the boot tries again, so a half-guild desk never serves. With no
 * file, IMDS's tag is the answer, as before.
 */
public final class ImdsClient {

    private static final Duration TIMEOUT = Duration.ofSeconds(1);
    private static final long TOKEN_TTL_SECONDS = 21600;
    private static final String CREDENTIALS_PATH = "/latest/meta-data/iam/security-credentials/";

    /** What the image's file may hold. */
    private static final String FILE_GUILD = "guild";
    private static final String FILE_MEMBER = "member";

    private final PlatformHttp http;
    private final String base;
    private final Path kindFile;
    private volatile String token;
    private volatile long tokenExpiresNanos;

    public ImdsClient(PlatformHttp http, String base) {
        this(http, base, null);
    }

    /** @param kindFile where the image wrote its reading of DeskKind, or null for IMDS alone */
    public ImdsClient(PlatformHttp http, String base, Path kindFile) {
        this.kindFile = kindFile;
        this.http = http;
        this.base = base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
    }

    /** @throws IOException if IMDS can't be reached or anything required is missing */
    public InstanceIdentity readIdentity() throws IOException, InterruptedException {
        String deskId = require("/latest/meta-data/tags/instance/DeskId");
        String kind = deskKind(require("/latest/meta-data/tags/instance/DeskKind"));
        // A Guild Desk is nobody's (desks.md, "What a Guild Desk hears"), so it may have no UserId: nothing reads it there.
        String userId = "guild".equals(kind)
                ? read("/latest/meta-data/tags/instance/UserId")
                : require("/latest/meta-data/tags/instance/UserId");
        return new InstanceIdentity(
                deskId,
                userId,
                kind,
                require("/latest/meta-data/tags/instance/Env"),
                require("/latest/meta-data/instance-id"),
                require("/latest/meta-data/public-ipv4"),
                require("/latest/meta-data/instance-type"),
                read("/latest/meta-data/ami-id"));
    }

    /**
     * @param tag IMDS's DeskKind
     * @return the desk's kind, given the image's file if it left one
     * @throws IOException if the file is unreadable, holds anything but guild or member, or contradicts the tag
     */
    private String deskKind(String tag) throws IOException {
        if (kindFile == null) {
            return tag;
        }
        String fromImage;
        try {
            fromImage = Files.readString(kindFile, StandardCharsets.UTF_8).trim();
        } catch (NoSuchFileException e) {
            return tag;
        }
        if (FILE_GUILD.equals(fromImage)) {
            if (!FILE_GUILD.equals(tag)) {
                throw new IOException("the DeskKind file and IMDS disagree");
            }
            return FILE_GUILD;
        }
        if (FILE_MEMBER.equals(fromImage)) {
            if (FILE_GUILD.equals(tag)) {
                throw new IOException("the DeskKind file and IMDS disagree");
            }
            return tag;
        }
        throw new IOException("the DeskKind file isn't a DeskKind");
    }

    /** The instance role's current credentials. Failures don't quote the response, which is secret. */
    public AwsCredentials roleCredentials() throws IOException, InterruptedException {
        String roles = read(CREDENTIALS_PATH);
        if (roles == null || roles.isBlank()) {
            throw new IOException("this instance has no role");
        }
        String role = roles.lines().findFirst().orElseThrow().trim();
        String body = read(CREDENTIALS_PATH + role);
        if (body == null) {
            throw new IOException("the role's credentials are missing");
        }
        Map<String, Object> json;
        try {
            json = Json.parseObject(body.getBytes(StandardCharsets.UTF_8));
        } catch (JsonFormatException e) {
            throw new IOException("the role's credentials aren't JSON");
        }
        String accessKeyId = Json.string(json, "AccessKeyId");
        String secret = Json.string(json, "SecretAccessKey");
        String sessionToken = Json.string(json, "Token");
        String expiration = Json.string(json, "Expiration");
        if (!"Success".equals(Json.string(json, "Code"))
                || accessKeyId == null || secret == null || sessionToken == null || expiration == null) {
            throw new IOException("the role's credentials are incomplete");
        }
        try {
            return new AwsCredentials(accessKeyId, secret, sessionToken, Instant.parse(expiration));
        } catch (DateTimeParseException e) {
            throw new IOException("the role's credentials have a bad Expiration");
        }
    }

    private String require(String path) throws IOException, InterruptedException {
        String value = read(path);
        if (value == null || value.isBlank()) {
            throw new IOException("IMDS has nothing at " + path);
        }
        return value.trim();
    }

    /** @return the body, or null on 404 */
    private String read(String path) throws IOException, InterruptedException {
        HttpResponse<String> response = get(path);
        if (response.statusCode() == 401) {
            // The token expired early, or IMDS restarted.
            token = null;
            response = get(path);
        }
        return switch (response.statusCode()) {
            case 200 -> response.body();
            case 404 -> null;
            default -> throw new IOException("IMDS answered " + response.statusCode());
        };
    }

    private HttpResponse<String> get(String path) throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder(URI.create(base + path))
                .timeout(TIMEOUT)
                .header("X-aws-ec2-metadata-token", sessionToken())
                .GET()
                .build();
        return http.send(request, HttpResponse.BodyHandlers.ofString(), TIMEOUT);
    }

    private String sessionToken() throws IOException, InterruptedException {
        String current = token;
        if (current != null && System.nanoTime() - tokenExpiresNanos < 0) {
            return current;
        }
        HttpRequest request = HttpRequest.newBuilder(URI.create(base + "/latest/api/token"))
                .timeout(TIMEOUT)
                .header("X-aws-ec2-metadata-token-ttl-seconds", Long.toString(TOKEN_TTL_SECONDS))
                .PUT(HttpRequest.BodyPublishers.noBody())
                .build();
        HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString(), TIMEOUT);
        if (response.statusCode() != 200 || response.body().isBlank()) {
            throw new IOException("IMDS refused a token: " + response.statusCode());
        }
        String fresh = response.body().trim();
        // A concurrent caller may do the same, and either token works.
        tokenExpiresNanos = System.nanoTime() + Duration.ofSeconds(TOKEN_TTL_SECONDS - 60).toNanos();
        token = fresh;
        return fresh;
    }
}
