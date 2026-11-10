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
}
