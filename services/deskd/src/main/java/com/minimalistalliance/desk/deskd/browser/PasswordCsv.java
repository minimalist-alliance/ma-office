package com.minimalistalliance.desk.deskd.browser;

import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * A passwords file as browsers and password managers export it: CSV (RFC 4180, as Chromium reads it), UTF-8, with a
 * header row that names the columns. The names Chromium's own import knows are taken, in any order and case, so Chrome's,
 * Edge's, Firefox's, Safari's, Bitwarden's and 1Password's exports all read. Nothing here logs, and an error says only
 * what was wrong, never a field.
 *
 * <p>A row is checked before it goes anywhere: an http or https address with a host ({@link BrowserUrl}), a password, and
 * no field past deskd's limits. One that fails stays out with a reason; the rest go to Chromium's Password Manager, which
 * checks the address again and decides about the ones it already has.
 */
final class PasswordCsv {

    /** Well past any member's export: Chromium's own import takes files far smaller. */
    static final int MAX_BYTES = 2 * 1024 * 1024;
    static final int MAX_ROWS = 10_000;
    /** deskd's limits for one row: an address as long as a tab's, and a username, password or note as long as Chromium's notes. */
    static final int MAX_URL_CHARS = 2048;
    static final int MAX_FIELD_CHARS = 1000;
    /** Past this one field means it isn't a passwords file. */
    private static final int MAX_RAW_FIELD_CHARS = 64 * 1024;

    static final String REFUSED_URL = "url";
    static final String REFUSED_PASSWORD = "password";
    static final String REFUSED_LONG = "too_long";

    private static final List<String> URL_NAMES = List.of("url", "website", "origin", "hostname", "login_uri");
    private static final List<String> USERNAME_NAMES = List.of("username", "user", "login", "account", "login_username");
    private static final List<String> PASSWORD_NAMES = List.of("password", "login_password");
    private static final List<String> NOTE_NAMES = List.of("note", "notes", "comment", "extra");

    /** One row Chromium may take. {@code url} is in the form deskd gives Chromium. */
    record Row(String url, String username, String password, String note) {}

    /** One row that stays out, and why: {@value #REFUSED_URL}, {@value #REFUSED_PASSWORD} or {@value #REFUSED_LONG}. */
    record Refused(String site, String username, String reason) {}

    record Parsed(List<Row> rows, List<Refused> refused) {
        int total() {
            return rows.size() + refused.size();
        }
    }

    private PasswordCsv() {}

    /** @throws RpcException bad_request with {@code reason: format}, or too_large with {@code reason: rows} */
    static Parsed parse(byte[] bytes) throws RpcException {
        String text = utf8(bytes);
        List<List<String>> records = records(text);
        if (records.isEmpty()) {
            throw format();
        }
        List<String> header = records.get(0);
        int url = column(header, URL_NAMES);
        int username = column(header, USERNAME_NAMES);
        int password = column(header, PASSWORD_NAMES);
        int note = column(header, NOTE_NAMES);
        if (url < 0 || password < 0) {
            throw format();
        }
        List<Row> rows = new ArrayList<>();
        List<Refused> refused = new ArrayList<>();
        for (int i = 1; i < records.size(); i++) {
            List<String> record = records.get(i);
            if (record.size() == 1 && record.get(0).isEmpty()) {
                continue;
            }
            if (rows.size() + refused.size() >= MAX_ROWS) {
                throw new RpcException(RpcException.TOO_LARGE, "Too many passwords in one file", Map.of("limit", MAX_ROWS, "reason", "rows"));
            }
            String rawUrl = field(record, url).strip();
            String user = field(record, username);
            String pass = field(record, password);
            String text0 = field(record, note);
            String site = siteOf(rawUrl);
            if (rawUrl.length() > MAX_URL_CHARS || user.length() > MAX_FIELD_CHARS || pass.length() > MAX_FIELD_CHARS
                    || text0.length() > MAX_FIELD_CHARS) {
                refused.add(new Refused(site, shown(user), REFUSED_LONG));
                continue;
            }
            String given;
            try {
                given = BrowserUrl.parse(rawUrl);
            } catch (RpcException e) {
                refused.add(new Refused(site, shown(user), REFUSED_URL));
                continue;
            }
            if (pass.isEmpty()) {
                refused.add(new Refused(site, shown(user), REFUSED_PASSWORD));
                continue;
            }
            rows.add(new Row(given, user, pass, text0));
        }
        return new Parsed(rows, refused);
    }

    /** The host, for the member to know which row it was, or null if the address has none. */
    static String siteOf(String url) {
        int scheme = url.indexOf("://");
        if (scheme < 0) {
            return null;
        }
        int start = scheme + 3;
        int end = start;
        while (end < url.length() && "/?#".indexOf(url.charAt(end)) < 0) {
            end++;
        }
        String authority = url.substring(start, end);
        int at = authority.lastIndexOf('@');
        String host = at >= 0 ? authority.substring(at + 1) : authority;
        int colon = host.startsWith("[") ? host.indexOf("]:") + 1 : host.lastIndexOf(':');
        if (colon > 0) {
            host = host.substring(0, colon);
        }
        host = TabText.clean(host.toLowerCase(Locale.ROOT), 253);
        return host.isEmpty() ? null : host;
    }

    private static String shown(String username) {
        return TabText.clean(username, 64);
    }

    private static String field(List<String> record, int index) {
        return index >= 0 && index < record.size() ? record.get(index) : "";
    }

    private static int column(List<String> header, List<String> names) {
        for (int i = 0; i < header.size(); i++) {
            String name = header.get(i).strip().toLowerCase(Locale.ROOT);
            if (names.contains(name)) {
                return i;
            }
        }
        return -1;
    }

    private static String utf8(byte[] bytes) throws RpcException {
        int start = bytes.length >= 3 && (bytes[0] & 0xFF) == 0xEF && (bytes[1] & 0xFF) == 0xBB && (bytes[2] & 0xFF) == 0xBF ? 3 : 0;
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes, start, bytes.length - start))
                    .toString();
        } catch (CharacterCodingException e) {
            throw format();
        }
    }

    /**
     * RFC 4180: fields split on commas, records on CRLF or LF, a quoted field may hold either and doubles its quotes. A
     * quote inside an unquoted field is taken as it is, as Chromium takes it. A quoted field left open is no CSV.
     */
    static List<List<String>> records(String text) throws RpcException {
        List<List<String>> records = new ArrayList<>();
        List<String> record = new ArrayList<>();
        StringBuilder field = new StringBuilder();
        boolean quoted = false;
        boolean wasQuoted = false;
        int i = 0;
        int n = text.length();
        while (i < n) {
            char c = text.charAt(i);
            if (quoted) {
                if (c == '"') {
                    if (i + 1 < n && text.charAt(i + 1) == '"') {
                        field.append('"');
                        i += 2;
                        continue;
                    }
                    quoted = false;
                    i++;
                    continue;
                }
                field.append(c);
            } else if (c == '"' && field.isEmpty() && !wasQuoted) {
                quoted = true;
                wasQuoted = true;
            } else if (c == ',') {
                record.add(field.toString());
                field.setLength(0);
                wasQuoted = false;
            } else if (c == '\n' || c == '\r') {
                record.add(field.toString());
                field.setLength(0);
                wasQuoted = false;
                records.add(record);
                record = new ArrayList<>();
                if (c == '\r' && i + 1 < n && text.charAt(i + 1) == '\n') {
                    i++;
                }
            } else {
                field.append(c);
            }
            if (field.length() > MAX_RAW_FIELD_CHARS) {
                throw format();
            }
            i++;
        }
        if (quoted) {
            throw format();
        }
        if (!field.isEmpty() || !record.isEmpty() || wasQuoted) {
            record.add(field.toString());
            records.add(record);
        }
        return records;
    }

    static RpcException format() {
        return new RpcException(RpcException.BAD_REQUEST, "Not a passwords file this can read", Map.of("reason", "format"));
    }
}
