package com.minimalistalliance.desk.agent.provider.http;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * Server-sent events, as Anthropic's and OpenAI's streams send them: {@code event:} and {@code data:} lines, an event
 * per blank line. Lines are capped, so a provider (or something posing as one) can't make desk-agent buffer without
 * end. Comments and other fields are skipped.
 */
public final class SseReader {

    /** One event. {@code name} is null when the stream gave none. */
    public record Event(String name, String data) {}

    static final int MAX_LINE = 1 << 20;
    static final int MAX_EVENT = 4 << 20;

    private final InputStream in;
    private final byte[] buffer = new byte[8192];
    private int position;
    private int limit;

    public SseReader(InputStream in) {
        this.in = in;
    }

    /** @return the next event, or null at the end of the stream */
    public Event next() throws IOException {
        String name = null;
        StringBuilder data = null;
        while (true) {
            String line = readLine();
            if (line == null) {
                return data == null ? null : new Event(name, data.toString());
            }
            if (line.isEmpty()) {
                if (data != null) {
                    return new Event(name, data.toString());
                }
                name = null;
                continue;
            }
            if (line.startsWith(":")) {
                continue;
            }
            int colon = line.indexOf(':');
            String field = colon < 0 ? line : line.substring(0, colon);
            String value = colon < 0 ? "" : line.substring(colon + 1);
            if (value.startsWith(" ")) {
                value = value.substring(1);
            }
            if (field.equals("event")) {
                name = value;
            } else if (field.equals("data")) {
                if (data == null) {
                    data = new StringBuilder();
                } else {
                    data.append('\n');
                }
                if (data.length() + value.length() > MAX_EVENT) {
                    throw new IOException("event too large");
                }
                data.append(value);
            }
        }
    }

    private String readLine() throws IOException {
        ByteArrayOutputStream line = null;
        while (true) {
            if (position == limit) {
                limit = in.read(buffer);
                position = 0;
                if (limit < 0) {
                    limit = 0;
                    return line == null ? null : line.toString(StandardCharsets.UTF_8);
                }
            }
            int start = position;
            while (position < limit && buffer[position] != '\n') {
                position++;
            }
            if (line == null) {
                line = new ByteArrayOutputStream();
            }
            line.write(buffer, start, position - start);
            if (line.size() > MAX_LINE) {
                throw new IOException("line too long");
            }
            if (position < limit) {
                position++;
                String text = line.toString(StandardCharsets.UTF_8);
                return text.endsWith("\r") ? text.substring(0, text.length() - 1) : text;
            }
        }
    }
}
