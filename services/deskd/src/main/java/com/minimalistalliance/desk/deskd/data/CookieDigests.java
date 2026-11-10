package com.minimalistalliance.desk.deskd.data;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * data.browser.cookies' answer: which cookies there are and whether each value is the same, never a cookie (draft ADR,
 * decision 7). {@code k} is the first 16 hex characters of SHA-256 of {@code domain\tname\tpath}, {@code v} the same of
 * the value, both over UTF-8, and {@code e} the expiry in whole Unix seconds, or -1 for a session cookie, so the move can
 * leave out what expired in between. Two desks whose Chromium reads the same cookies give the same items, so the move
 * compares them. Items are sorted, by {@code k}, {@code v} then {@code e}, as Chromium's order isn't the same on two
 * desks.
 */
final class CookieDigests {

    private static final int HEX_CHARS = 16;

    private CookieDigests() {}

    /** @param cookies as Storage.getCookies gives them. A field that isn't a string counts as empty */
    static Map<String, Object> of(List<Map<String, Object>> cookies) {
        List<Map<String, Object>> items = new ArrayList<>(cookies.size());
        for (Map<String, Object> cookie : cookies) {
            String key = text(cookie, "domain") + "\t" + text(cookie, "name") + "\t" + text(cookie, "path");
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("k", digest(key));
            item.put("v", digest(text(cookie, "value")));
            item.put("e", expiry(cookie));
            items.add(item);
        }
        items.sort(Comparator.comparing((Map<String, Object> item) -> (String) item.get("k"))
                .thenComparing(item -> (String) item.get("v"))
                .thenComparingLong(item -> (Long) item.get("e")));
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("count", items.size());
        result.put("items", items);
        return result;
    }

    static String digest(String text) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hash).substring(0, HEX_CHARS);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("no SHA-256", null);
        }
    }

    /** CDP's {@code expires} is seconds as a number, -1 for a session cookie, which {@code session} also says. */
    static long expiry(Map<String, Object> cookie) {
        if (Boolean.TRUE.equals(cookie.get("session")) || !(cookie.get("expires") instanceof Number expires)) {
            return -1;
        }
        double seconds = expires.doubleValue();
        return Double.isFinite(seconds) && seconds >= 0 ? (long) Math.floor(seconds) : -1;
    }

    private static String text(Map<String, Object> cookie, String key) {
        return cookie.get(key) instanceof String value ? value : "";
    }
}
