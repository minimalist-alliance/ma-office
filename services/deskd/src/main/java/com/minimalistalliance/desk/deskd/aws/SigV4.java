package com.minimalistalliance.desk.deskd.aws;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** AWS Signature Version 4 on JDK crypto: signed headers and presigned URLs. Keeps no state. */
public final class SigV4 {

    public static final String REGION = "us-east-1";

    /** The payload hash S3 accepts in a presigned URL. Other services want the empty body's hash. */
    public static final String UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

    private static final String ALGORITHM = "AWS4-HMAC-SHA256";
    private static final DateTimeFormatter AMZ_DATE =
            DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'").withZone(ZoneOffset.UTC);
    private static final HexFormat HEX = HexFormat.of();

    private SigV4() {}

    /**
     * Signs a request with headers.
     *
     * @param headers what to send besides the ones added here. Every one is signed
     * @return all the request's headers, names in lower case, with host, x-amz-date,
     *     x-amz-security-token and authorization added. The HTTP client sets host itself
     */
    public static Map<String, String> sign(
            String method, URI uri, Map<String, String> headers, byte[] body,
            String service, String region, AwsCredentials credentials, Instant now) {
        String amzDate = AMZ_DATE.format(now);
        TreeMap<String, String> signed = new TreeMap<>();
        headers.forEach((name, value) -> signed.put(name.toLowerCase(Locale.ROOT), value));
        signed.put("host", hostOf(uri));
        signed.put("x-amz-date", amzDate);
        if (credentials.sessionToken() != null) {
            signed.put("x-amz-security-token", credentials.sessionToken());
        }
        String signedNames = String.join(";", signed.keySet());
        String scope = scope(amzDate, region, service);
        String canonical = canonicalRequest(
                method, uri, canonicalQuery(uri.getRawQuery()), signed, signedNames, hex(sha256(body)));
        String signature = signature(credentials, amzDate, region, service, scope, canonical);

        Map<String, String> result = new LinkedHashMap<>(signed);
        result.put("authorization", ALGORITHM + " Credential=" + credentials.accessKeyId() + "/" + scope
                + ", SignedHeaders=" + signedNames + ", Signature=" + signature);
        return result;
    }

    /**
     * A presigned URL, signing only the host.
     *
     * @param payloadHash {@link #UNSIGNED_PAYLOAD} for S3, or the hash of an empty body
     */
    public static URI presign(
            String method, URI uri, String service, String region, Duration expires, String payloadHash,
            AwsCredentials credentials, Instant now) {
        String amzDate = AMZ_DATE.format(now);
        String scope = scope(amzDate, region, service);
        StringBuilder query = new StringBuilder();
        if (uri.getRawQuery() != null) {
            query.append(uri.getRawQuery()).append('&');
        }
        query.append("X-Amz-Algorithm=").append(ALGORITHM);
        query.append("&X-Amz-Credential=").append(encode(credentials.accessKeyId() + "/" + scope, true));
        query.append("&X-Amz-Date=").append(amzDate);
        query.append("&X-Amz-Expires=").append(expires.toSeconds());
        if (credentials.sessionToken() != null) {
            query.append("&X-Amz-Security-Token=").append(encode(credentials.sessionToken(), true));
        }
        query.append("&X-Amz-SignedHeaders=host");
        String canonicalQuery = canonicalQuery(query.toString());
        Map<String, String> host = Map.of("host", hostOf(uri));
        String canonical = canonicalRequest(method, uri, canonicalQuery, host, "host", payloadHash);
        String signature = signature(credentials, amzDate, region, service, scope, canonical);
        String port = uri.getPort() < 0 ? "" : ":" + uri.getPort();
        return URI.create(uri.getScheme() + "://" + uri.getHost() + port + rawPath(uri) + "?" + canonicalQuery
                + "&X-Amz-Signature=" + signature);
    }

    /** The host header as the JDK's client sends it: with the port only if the URL names one. */
    private static String hostOf(URI uri) {
        return uri.getPort() < 0 ? uri.getHost() : uri.getHost() + ":" + uri.getPort();
    }

    private static String rawPath(URI uri) {
        String path = uri.getRawPath();
        return path == null || path.isEmpty() ? "/" : path;
    }

    private static String scope(String amzDate, String region, String service) {
        return amzDate.substring(0, 8) + "/" + region + "/" + service + "/aws4_request";
    }

    private static String canonicalRequest(
            String method, URI uri, String canonicalQuery, Map<String, String> headers, String signedNames,
            String payloadHash) {
        StringBuilder canonical = new StringBuilder();
        canonical.append(method).append('\n');
        // The already encoded path is encoded again, for every service but S3. deskd only signs paths
        // where that makes no difference to S3.
        canonical.append(encode(rawPath(uri), false));
        canonical.append('\n').append(canonicalQuery).append('\n');
        new TreeMap<>(headers).forEach((name, value) -> canonical
                .append(name)
                .append(':')
                .append(value.trim().replaceAll(" +", " "))
                .append('\n'));
        canonical.append('\n').append(signedNames).append('\n').append(payloadHash);
        return canonical.toString();
    }

    private static String canonicalQuery(String rawQuery) {
        if (rawQuery == null || rawQuery.isEmpty()) {
            return "";
        }
        List<String[]> pairs = new ArrayList<>();
        for (String pair : rawQuery.split("&")) {
            int equals = pair.indexOf('=');
            String name = equals < 0 ? pair : pair.substring(0, equals);
            String value = equals < 0 ? "" : pair.substring(equals + 1);
            pairs.add(new String[] {
                encode(URLDecoder.decode(name, StandardCharsets.UTF_8), true),
                encode(URLDecoder.decode(value, StandardCharsets.UTF_8), true)
            });
        }
        pairs.sort(Comparator.<String[], String>comparing(pair -> pair[0]).thenComparing(pair -> pair[1]));
        StringBuilder out = new StringBuilder();
        for (String[] pair : pairs) {
            out.append(out.isEmpty() ? "" : "&").append(pair[0]).append('=').append(pair[1]);
        }
        return out.toString();
    }

    private static String signature(
            AwsCredentials credentials, String amzDate, String region, String service, String scope, String canonical) {
        String stringToSign = ALGORITHM + "\n" + amzDate + "\n" + scope + "\n"
                + hex(sha256(canonical.getBytes(StandardCharsets.UTF_8)));
        byte[] key = hmac(("AWS4" + credentials.secretAccessKey()).getBytes(StandardCharsets.UTF_8), amzDate.substring(0, 8));
        key = hmac(key, region);
        key = hmac(key, service);
        key = hmac(key, "aws4_request");
        return hex(hmac(key, stringToSign));
    }

    /** RFC 3986 unreserved characters stay; everything else becomes %XX of its UTF-8 bytes. */
    private static String encode(String value, boolean encodeSlash) {
        StringBuilder out = new StringBuilder(value.length() + 8);
        for (byte raw : value.getBytes(StandardCharsets.UTF_8)) {
            char c = (char) (raw & 0xFF);
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                    || c == '-' || c == '_' || c == '.' || c == '~' || (c == '/' && !encodeSlash)) {
                out.append(c);
            } else {
                out.append('%').append(HEX.toHexDigits(raw).toUpperCase(Locale.ROOT));
            }
        }
        return out.toString();
    }

    public static String sha256Hex(byte[] bytes) {
        return hex(sha256(bytes));
    }

    private static String hex(byte[] bytes) {
        return HEX.formatHex(bytes);
    }

    private static byte[] sha256(byte[] bytes) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(bytes);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("no SHA-256 in this JRE", e);
        }
    }

    private static byte[] hmac(byte[] key, String data) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            return mac.doFinal(data.getBytes(StandardCharsets.UTF_8));
        } catch (GeneralSecurityException e) {
            // Not chained: a crypto exception must never carry key material into a log.
            throw new IllegalStateException("no HmacSHA256 in this JRE", null);
        }
    }
}
