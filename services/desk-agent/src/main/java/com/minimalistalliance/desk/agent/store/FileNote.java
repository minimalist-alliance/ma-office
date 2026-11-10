package com.minimalistalliance.desk.agent.store;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.json.JsonFormatException;
import com.minimalistalliance.desk.agent.provider.Attachment;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * What the thread keeps of a file the member attached (ADR 0049): its cleaned name, a word for its type, its size and a
 * note for the member, such as {@code cut}. Never any of its content: the file itself is removed once the model has
 * processed it.
 */
public record FileNote(String name, String type, long size, String note) {

    public static FileNote of(Attachment attachment) {
        return new FileNote(attachment.name(), attachment.type(), attachment.size(), attachment.note());
    }

    /** The notes as the JSON the {@code message_files} table keeps. */
    public static String toJson(List<FileNote> notes) {
        return new String(Json.bytes(views(notes)), StandardCharsets.UTF_8);
    }

    /** The notes as a thread view carries them. */
    public static List<Map<String, Object>> views(List<FileNote> notes) {
        List<Map<String, Object>> list = new ArrayList<>();
        for (FileNote note : notes) {
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("name", note.name());
            view.put("type", note.type());
            view.put("size", note.size());
            if (note.note() != null) {
                view.put("note", note.note());
            }
            list.add(view);
        }
        return list;
    }

    /** The notes from stored JSON; none for anything unreadable. */
    public static List<FileNote> parse(String json) {
        List<FileNote> notes = new ArrayList<>();
        if (json == null) {
            return notes;
        }
        try {
            Map<String, Object> wrapped = Json.parseObject(("{\"files\":" + json + "}").getBytes(StandardCharsets.UTF_8));
            if (wrapped.get("files") instanceof List<?> list) {
                for (Object item : list) {
                    if (item instanceof Map<?, ?> map && map.get("name") instanceof String name
                            && map.get("type") instanceof String type && map.get("size") instanceof Number size) {
                        notes.add(new FileNote(name, type, size.longValue(),
                                map.get("note") instanceof String note ? note : null));
                    }
                }
            }
        } catch (JsonFormatException e) {
            // Nothing to show for a row that can't be read.
        }
        return notes;
    }

    /** The line a later turn's history carries in place of the file. */
    public String line() {
        return "[attached: " + name + " (" + type + ", " + Attachment.sizeLabel(size) + "); its content isn't kept]";
    }
}
