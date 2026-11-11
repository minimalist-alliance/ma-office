package com.minimalistalliance.desk.deskd.apps;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The reserved topic {@code app.summary} (the desk app contract, section 3.1): what the Desk app draws as the app's widget,
 * with its own components, so no app code runs on the canvas. {@code {badge?, problem?, rows: [{text, detail?, time?}]}}, at
 * most 6 rows, 120 characters of text or detail, a problem of 40, a badge from 0 to 999, and 8 KiB in all. deskd keeps the
 * last one, so the widget shows while the app isn't running. Anything else is dropped whole, never trimmed.
 */
final class AppSummary {

    static final int MAX_BYTES = 8 << 10;
    private static final int MAX_ROWS = 6;
    private static final int MAX_TEXT = 120;
    private static final int MAX_PROBLEM = 40;

    private AppSummary() {}

    /** @return the summary as deskd keeps and serves it, or null if it breaks a rule */
    static Map<String, Object> check(Object data) {
        if (!(data instanceof Map<?, ?>)) {
            return null;
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> json = (Map<String, Object>) data;
        if (!Set.of("badge", "problem", "rows").containsAll(json.keySet())) {
            return null;
        }
        Object badge = json.get("badge");
        if (badge != null && !(badge instanceof Integer b && b >= 0 && b <= 999)) {
            return null;
        }
        Object problem = json.get("problem");
        if (problem != null && !(problem instanceof String p && p.length() <= MAX_PROBLEM && plain(p))) {
            return null;
        }
        if (!(json.get("rows") instanceof List<?> rows) || rows.size() > MAX_ROWS) {
            return null;
        }
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object item : rows) {
            if (!(item instanceof Map<?, ?>)) {
                return null;
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> row = (Map<String, Object>) item;
            if (!Set.of("text", "detail", "time").containsAll(row.keySet())) {
                return null;
            }
            String text = Json.string(row, "text");
            Object detail = row.get("detail");
            Object time = row.get("time");
            if (text == null || text.length() > MAX_TEXT || !plain(text)
                    || (detail != null && !(detail instanceof String d && d.length() <= MAX_TEXT && plain(d)))
                    || (time != null && !(time instanceof String t && t.length() <= 40 && plain(t)))) {
                return null;
            }
            Map<String, Object> kept = new LinkedHashMap<>();
            kept.put("text", text);
            kept.put("detail", detail);
            kept.put("time", time);
            out.add(kept);
        }
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("badge", badge);
        summary.put("problem", problem);
        summary.put("rows", out);
        return Json.bytes(summary).length > MAX_BYTES ? null : summary;
    }

    private static boolean plain(String s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) {
                return false;
            }
        }
        return true;
    }
}
