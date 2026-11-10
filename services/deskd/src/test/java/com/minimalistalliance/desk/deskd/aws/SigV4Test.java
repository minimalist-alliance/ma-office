package com.minimalistalliance.desk.deskd.aws;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Signatures here aren't computed by the code under test. The first three are AWS's own published
 * values. The others came from botocore, with the inputs written out here, by a script that isn't
 * in this repository.
 */
class SigV4Test {

    private static final Instant SUITE_TIME = Instant.parse("2015-08-30T12:36:00Z");
    private static final AwsCredentials SUITE = new AwsCredentials(
            "AKIDEXAMPLE", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", null, Instant.MAX);
    private static final AwsCredentials ROLE = new AwsCredentials(
            "ASIAVEXAMPLE7Q2M", "secretExampleKey/abc+def", "IQoJb3JpZ2luX2VjEJrExampleToken==", Instant.MAX);
    private static final Instant ROLE_TIME = Instant.parse("2026-11-04T21:00:00Z");

    @Test
    void awsTestSuiteGetVanilla() {
        Map<String, String> signed = SigV4.sign(
                "GET", URI.create("https://example.amazonaws.com/"), Map.of(), new byte[0],
                "service", "us-east-1", SUITE, SUITE_TIME);
        assertThat(signed).containsEntry("authorization",
                "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, "
                        + "SignedHeaders=host;x-amz-date, "
                        + "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
        assertThat(signed).containsEntry("x-amz-date", "20150830T123600Z").containsEntry("host", "example.amazonaws.com");
    }

    @Test
    void awsDocumentationExampleIamListUsers() {
        Map<String, String> signed = SigV4.sign(
                "GET", URI.create("https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08"),
                Map.of("Content-Type", "application/x-www-form-urlencoded; charset=utf-8"), new byte[0],
                "iam", "us-east-1", SUITE, SUITE_TIME);
        assertThat(signed.get("authorization")).endsWith(
                "SignedHeaders=content-type;host;x-amz-date, "
                        + "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7");
    }

    @Test
    void awsDocumentationExamplePresignedGet() {
        URI url = SigV4.presign(
                "GET", URI.create("https://examplebucket.s3.amazonaws.com/test.txt"), "s3", "us-east-1",
                Duration.ofDays(1), SigV4.UNSIGNED_PAYLOAD,
                new AwsCredentials("AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", null, Instant.MAX),
                Instant.parse("2013-05-24T00:00:00Z"));
        assertThat(url.toString()).isEqualTo("https://examplebucket.s3.amazonaws.com/test.txt"
                + "?X-Amz-Algorithm=AWS4-HMAC-SHA256"
                + "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request"
                + "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host"
                + "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
    }

    @Test
    void anAgentCallWithABodyAndASessionTokenMatchesBotocore() {
        Map<String, String> signed = SigV4.sign(
                "POST", URI.create("https://api.staging.minimalistalliance.com/v1/agent/heartbeat"),
                Map.of("content-type", "application/json"),
                "{\"bootId\":\"b\",\"seq\":1}".getBytes(StandardCharsets.UTF_8),
                "execute-api", SigV4.REGION, ROLE, ROLE_TIME);
        assertThat(signed).containsEntry("x-amz-security-token", ROLE.sessionToken());
        assertThat(signed.get("authorization")).isEqualTo(
                "AWS4-HMAC-SHA256 Credential=ASIAVEXAMPLE7Q2M/20261104/us-east-1/execute-api/aws4_request, "
                        + "SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, "
                        + "Signature=77b425c2ee7433acf675a9cb069606afc43908b04f9d1aa47af70dd5f55d1a29");
    }

    @Test
    void credentialsKeepTheirSecretsOutOfToString() {
        assertThat(ROLE.toString()).doesNotContain(ROLE.secretAccessKey(), ROLE.sessionToken(), ROLE.accessKeyId());
    }
}
