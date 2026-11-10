package com.minimalistalliance.desk.deskd.platform;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * How much of other members' text a member without {@code moderate} may remove from one Notebook page on a guild desk,
 * over a rolling window (desk-notebook enforces it; API.md section 15, "The Notebook's edit budget").
 *
 * @param chars 0 to 100,000; 0 means only moderators may remove what another member wrote
 * @param windowMinutes 1 to 1,440
 */
public record EditBudget(int chars, int windowMinutes) {

    public static final int MAX_CHARS = 100_000;
    public static final int MAX_WINDOW_MINUTES = 1_440;
    /** What applies when neither the guild nor the Platform says: 500 characters in 10 minutes. */
    public static final EditBudget DEFAULT = new EditBudget(500, 10);

    /**
     * {@code {chars, windowMinutes}} as a whole-number pair within bounds, or null for anything else: missing, a decimal,
     * a string, out of range. Other keys are ignored.
     */
    public static EditBudget parse(Object value) {
        if (!(value instanceof Map<?, ?> map)) {
            return null;
        }
        Long chars = whole(map.get("chars"));
        Long minutes = whole(map.get("windowMinutes"));
        if (chars == null || minutes == null || chars < 0 || chars > MAX_CHARS || minutes < 1 || minutes > MAX_WINDOW_MINUTES) {
            return null;
        }
        return new EditBudget(chars.intValue(), minutes.intValue());
    }

    /** The guild's own budget, else the Platform's, else {@link #DEFAULT}. A level that is null is skipped. */
    public static EditBudget effective(EditBudget guild, EditBudget platform) {
        return guild != null ? guild : platform != null ? platform : DEFAULT;
    }

    private static Long whole(Object value) {
        return value instanceof Integer || value instanceof Long ? ((Number) value).longValue() : null;
    }

    public Map<String, Object> toJson() {
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("chars", chars);
        json.put("windowMinutes", windowMinutes);
        return json;
    }
}
