package com.minimalistalliance.desk.deskd.gateway;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.aws.AwsCredentials;
import com.minimalistalliance.desk.deskd.protocol.Json;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import org.junit.jupiter.api.Test;

class DeskAuthTest {

    /** The signature came from botocore over the same request (see SigV4Test). */
    @Test
    void theBlobIsWhatGatewayMd31SaysAndItsSignatureMatchesBotocore() throws Exception {
        AwsCredentials role = new AwsCredentials(
                "ASIAVEXAMPLE7Q2M", "secretExampleKey/abc+def", "IQoJb3JpZ2luX2VjEJrExampleToken==", Instant.MAX);
        String blob = DeskAuth.header(role, "gw.minimalistalliance.com", Instant.parse("2026-11-04T21:00:00Z"));
        assertThat(blob).doesNotContain("=").doesNotContain("+").doesNotContain("/");

        Map<String, Object> request = Json.parseObject(Base64.getUrlDecoder().decode(blob));
        assertThat(request)
                .containsEntry("method", "POST")
                .containsEntry("url", "https://sts.us-east-1.amazonaws.com/")
                .containsEntry("body", "Action=GetCallerIdentity&Version=2011-06-15");
        Map<String, Object> headers = Json.object(request, "headers");
        assertThat(headers)
                .containsEntry("content-type", "application/x-www-form-urlencoded; charset=utf-8")
                .containsEntry("host", "sts.us-east-1.amazonaws.com")
                .containsEntry("x-amz-date", "20261104T210000Z")
                .containsEntry("x-amz-security-token", role.sessionToken())
                .containsEntry("x-ma-gateway-id", "gw.minimalistalliance.com")
                .containsEntry("authorization",
                        "AWS4-HMAC-SHA256 Credential=ASIAVEXAMPLE7Q2M/20261104/us-east-1/sts/aws4_request, "
                                + "SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-ma-gateway-id, "
                                + "Signature=91a87e8b6f2ce20b0f8e67ff45a1559d5fccf1ef424ccfa1fb66d2b2ef71ac9e");
        // The gateway refuses a blob over 8192 chars. A real session token is about 1.5 KB.
        assertThat(blob.length()).isLessThan(8192);
    }

    /**
     * Desk Maia's proof (ma-platform desk-maia.md, "Auth"): the same blob, signing x-ma-maia-id and x-ma-body-sha256 and not
     * the gateway's id, so one made for the gateway or another env is refused at each. The signature is checked by signing
     * the blob's own headers again, as STS does.
     */
    @Test
    void desksMaiaProofSignsItsAudienceAndTheBodysHash() throws Exception {
        AwsCredentials role = new AwsCredentials(
                "ASIAVEXAMPLE7Q2M", "secretExampleKey/abc+def", "IQoJb3JpZ2luX2VjEJrExampleToken==", Instant.MAX);
        Instant at = Instant.parse("2026-11-14T21:00:00Z");
        String hash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
        String blob = DeskAuth.forMaia(role, "maia.minimalistalliance.com", hash, at);
        assertThat(blob).doesNotContain("=").doesNotContain("+").doesNotContain("/");
        Map<String, Object> request = Json.parseObject(Base64.getUrlDecoder().decode(blob));
        assertThat(request).containsEntry("method", "POST").containsEntry("url", "https://sts.us-east-1.amazonaws.com/")
                .containsEntry("body", "Action=GetCallerIdentity&Version=2011-06-15");
        Map<String, Object> headers = Json.object(request, "headers");
        assertThat(headers).containsEntry("x-ma-maia-id", "maia.minimalistalliance.com")
                .containsEntry("x-ma-body-sha256", hash)
                .containsEntry("content-type", "application/x-www-form-urlencoded; charset=utf-8")
                .containsEntry("host", "sts.us-east-1.amazonaws.com")
                .containsEntry("x-amz-date", "20261114T210000Z")
                .containsEntry("x-amz-security-token", role.sessionToken())
                .doesNotContainKey("x-ma-gateway-id");
        String authorization = (String) headers.get("authorization");
        assertThat(authorization).contains("/20261114/us-east-1/sts/aws4_request, ")
                .contains("SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-ma-body-sha256;x-ma-maia-id,");
        // Signed again from the blob's own headers, as STS checks it: the same signature.
        java.util.Map<String, String> again = com.minimalistalliance.desk.deskd.aws.SigV4.sign("POST",
                java.net.URI.create("https://sts.us-east-1.amazonaws.com/"),
                Map.of("content-type", (String) headers.get("content-type"), "x-ma-maia-id", "maia.minimalistalliance.com",
                        "x-ma-body-sha256", hash),
                "Action=GetCallerIdentity&Version=2011-06-15".getBytes(java.nio.charset.StandardCharsets.UTF_8), "sts",
                "us-east-1", role, at);
        assertThat(again.get("authorization")).isEqualTo(authorization);
        // Another body or audience is another signature.
        Map<String, Object> other = Json.object(Json.parseObject(Base64.getUrlDecoder().decode(
                DeskAuth.forMaia(role, "maia.minimalistalliance.com", hash.replace('9', '8'), at))), "headers");
        assertThat(other.get("authorization")).isNotEqualTo(authorization);
        Map<String, Object> staging = Json.object(Json.parseObject(Base64.getUrlDecoder().decode(
                DeskAuth.forMaia(role, "maia.staging.minimalistalliance.com", hash, at))), "headers");
        assertThat(staging.get("authorization")).isNotEqualTo(authorization);
        assertThat(blob.length()).isLessThan(8192);
    }
}
