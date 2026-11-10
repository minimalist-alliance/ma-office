package com.minimalistalliance.desk.deskd.gateway;

import com.minimalistalliance.desk.deskd.aws.AwsCredentials;
import com.minimalistalliance.desk.deskd.aws.SigV4;
import com.minimalistalliance.desk.deskd.protocol.Json;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * X-MA-Desk-Auth (gateway.md 3.1): a signed sts:GetCallerIdentity request that the gateway sends to
 * STS itself to learn which desk is calling. It's good for one use, so each connection attempt makes
 * a new one.
 */
final class DeskAuth {

    private static final URI STS = URI.create("https://sts.us-east-1.amazonaws.com/");
    private static final String BODY = "Action=GetCallerIdentity&Version=2011-06-15";
    private static final String CONTENT_TYPE = "application/x-www-form-urlencoded; charset=utf-8";

    private DeskAuth() {}

    /** @param gatewayId config's endpoints.gatewayId: signed, so the blob works only there */
    static String header(AwsCredentials credentials, String gatewayId, Instant now) {
        Map<String, String> headers = SigV4.sign(
                "POST",
                STS,
                Map.of("content-type", CONTENT_TYPE, "x-ma-gateway-id", gatewayId),
                BODY.getBytes(StandardCharsets.UTF_8),
                "sts",
                SigV4.REGION,
                credentials,
                now);
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("method", "POST");
        request.put("url", STS.toString());
        request.put("headers", new LinkedHashMap<>(headers));
        request.put("body", BODY);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(Json.bytes(request));
    }
}
