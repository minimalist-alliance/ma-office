package com.minimalistalliance.desk.deskd.todo;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * {@code todo.export} (API.md §22; VISION "Where it lives", Export): a plain Markdown checklist of the open items then
 * the closed ones, or a complete JSON file of every item with its events. Titles and notes are the member's and agents'
 * plain text: in Markdown, the characters that would make a link, an image, HTML or a heading are escaped, so the file
 * reads back as the text it was.
 */
final class TodoExport {

    private TodoExport() {}

    static byte[] render(TodoStore store, String format, Clock clock) throws SQLException {
        List<Map<String, Object>> items = store.everything("json".equals(format));
        if ("json".equals(format)) {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("app", "todo");
            out.put("v", 1);
            out.put("exportedAt", clock.millis());
            out.put("zone", store.zone().getId());
            out.put("items", items);
            return Json.bytes(out);
        }
        StringBuilder md = new StringBuilder("# To-do\n\n");
        boolean open = false;
        boolean closed = false;
        for (Map<String, Object> item : items) {
            if (item.get("trashedAt") != null) {
                continue;
            }
            boolean isOpen = "open".equals(item.get("state"));
            if (isOpen && !open) {
                md.append("## Open\n\n");
                open = true;
            }
            if (!isOpen && !closed) {
                md.append(open ? "\n## Done\n\n" : "## Done\n\n");
                closed = true;
            }
            md.append(isOpen ? "- [ ] " : "- [x] ").append(escape((String) item.get("title")));
            if (item.get("due") instanceof Map<?, ?> due) {
                md.append(" (due ").append(due.get("date"));
                if (due.get("time") != null) {
                    md.append(' ').append(due.get("time"));
                }
                md.append(')');
            }
            if ("not_needed".equals(item.get("state"))) {
                md.append(" (not needed)");
            }
            if (item.get("source") instanceof Map<?, ?> source && source.get("label") instanceof String label
                    && !label.isBlank()) {
                md.append(" · ").append(escape(label));
            }
            md.append('\n');
            if (item.get("note") instanceof String note && !note.isBlank()) {
                for (String line : note.split("\n")) {
                    md.append("  ").append(escape(line)).append('\n');
                }
            }
        }
        if (!open && !closed) {
            md.append("Nothing here yet.\n");
        }
        return md.toString().getBytes(StandardCharsets.UTF_8);
    }

    /** Markdown's own characters escaped, so a title reads as itself. */
    static String escape(String text) {
        if (text == null) {
            return "";
        }
        StringBuilder out = new StringBuilder(text.length());
        for (int i = 0; i < text.length(); i++) {
            char ch = text.charAt(i);
            if ("\\`*_{}[]()<>#+-.!|~".indexOf(ch) >= 0) {
                out.append('\\');
            }
            out.append(ch);
        }
        return out.toString();
    }
}
