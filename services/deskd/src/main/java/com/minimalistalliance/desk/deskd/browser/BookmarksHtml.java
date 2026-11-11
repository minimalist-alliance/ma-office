package com.minimalistalliance.desk.deskd.browser;

import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;

/**
 * A bookmarks file as every browser exports it: the Netscape bookmark file, HTML with folders as {@code <H3>} followed by
 * a {@code <DL>} of what's in them and links as {@code <A HREF>}. Read straight from its bytes, so a big export, whose
 * {@code ICON} attributes are most of it, costs no more than the file: only titles and addresses become strings.
 *
 * <p>What it keeps is the folders and the http and https links ({@link BrowserUrl}). Everything else, such as
 * {@code javascript:} bookmarklets and {@code place:} queries, is counted and left out.
 */
final class BookmarksHtml {

    static final int MAX_BYTES = 8 * 1024 * 1024;
    static final int MAX_NODES = 20_000;
    /** Folders nested deeper than this keep their links in the deepest one kept. */
    static final int MAX_DEPTH = 32;
    static final int TITLE_CHARS = 1024;
    static final int FOLDER_CHARS = 256;

    /** A folder or a link, in the file's order, so a folder comes before what's in it. {@code parent} is -1 for the top. */
    record Node(int parent, boolean folder, String title, String url) {}

    record Parsed(List<Node> nodes, int links, int refused) {}

    private final byte[] b;
    private int i;
    private final List<Node> nodes = new ArrayList<>();
    private final Deque<Integer> open = new ArrayDeque<>();
    private int current = -1;
    private int pending = -1;
    private int links;
    private int refused;
    private boolean sawList;

    private BookmarksHtml(byte[] bytes) {
        this.b = bytes;
    }

    /** @throws RpcException bad_request with {@code reason: format}, or too_large with {@code reason: bookmarks} */
    static Parsed parse(byte[] bytes) throws RpcException {
        BookmarksHtml p = new BookmarksHtml(bytes);
        p.run();
        if (!p.sawList && p.links == 0 && p.refused == 0) {
            throw new RpcException(RpcException.BAD_REQUEST, "Not a bookmarks file this can read", Map.of("reason", "format"));
        }
        return new Parsed(List.copyOf(p.nodes), p.links, p.refused);
    }

    private void run() throws RpcException {
        while (i < b.length) {
            if (b[i] != '<') {
                i++;
                continue;
            }
            if (startsWith(i + 1, "!--")) {
                int end = indexOf("-->", i + 4);
                i = end < 0 ? b.length : end + 3;
                continue;
            }
            int nameStart = i + 1;
            boolean closing = nameStart < b.length && b[nameStart] == '/';
            if (closing) {
                nameStart++;
            }
            int nameEnd = nameStart;
            while (nameEnd < b.length && isLetterOrDigit(b[nameEnd])) {
                nameEnd++;
            }
            String name = ascii(nameStart, nameEnd);
            int tagEnd = tagEnd(nameEnd);
            if (tagEnd < 0) {
                // A file cut off inside a tag: what's left is no bookmark.
                break;
            }
            if (closing && name.equals("dl")) {
                current = open.isEmpty() ? -1 : open.pop();
            } else if (!closing && name.equals("dl")) {
                sawList = true;
                open.push(current);
                if (pending >= 0 && open.size() <= MAX_DEPTH) {
                    current = pending;
                }
                pending = -1;
            } else if (!closing && name.equals("h3")) {
                int textEnd = indexOfIgnoreCase("</h3", tagEnd);
                String title = text(tagEnd, textEnd < 0 ? b.length : textEnd, FOLDER_CHARS);
                add(new Node(current, true, title.isEmpty() ? "Folder" : title, null));
                pending = nodes.size() - 1;
                tagEnd = textEnd < 0 ? b.length : textEnd;
            } else if (!closing && name.equals("a")) {
                pending = -1;
                String href = attribute(nameEnd, tagEnd, "href");
                int textEnd = indexOfIgnoreCase("</a", tagEnd);
                String title = text(tagEnd, textEnd < 0 ? b.length : textEnd, TITLE_CHARS);
                tagEnd = textEnd < 0 ? b.length : textEnd;
                String url = null;
                if (href != null && href.length() <= PasswordCsv.MAX_URL_CHARS) {
                    try {
                        url = BrowserUrl.parse(entities(href).strip());
                    } catch (RpcException e) {
                        url = null;
                    }
                }
                if (url == null || url.length() > PasswordCsv.MAX_URL_CHARS) {
                    refused++;
                } else {
                    links++;
                    add(new Node(current, false, title.isEmpty() ? TabText.clean(url, TITLE_CHARS) : title, url));
                }
            }
            i = tagEnd;
        }
    }

    private void add(Node node) throws RpcException {
        if (nodes.size() >= MAX_NODES) {
            throw new RpcException(RpcException.TOO_LARGE, "Too many bookmarks in one file", Map.of("limit", MAX_NODES, "reason", "bookmarks"));
        }
        nodes.add(node);
    }

    /** Just past the tag's {@code >}, with quoted values skipped whole, or -1 if the file ends first. */
    private int tagEnd(int from) {
        int j = from;
        byte quote = 0;
        while (j < b.length) {
            byte c = b[j];
            if (quote != 0) {
                if (c == quote) {
                    quote = 0;
                }
            } else if (c == '"' || c == '\'') {
                quote = c;
            } else if (c == '>') {
                return j + 1;
            }
            j++;
        }
        return -1;
    }

    /** One attribute's raw value between {@code from} and the tag's end, or null. */
    private String attribute(int from, int end, String wanted) {
        int j = from;
        while (j < end) {
            while (j < end && !isLetterOrDigit(b[j])) {
                j++;
            }
            int nameStart = j;
            while (j < end && (isLetterOrDigit(b[j]) || b[j] == '_' || b[j] == '-')) {
                j++;
            }
            String name = ascii(nameStart, j);
            while (j < end && b[j] == ' ') {
                j++;
            }
            if (j >= end || b[j] != '=') {
                continue;
            }
            j++;
            while (j < end && b[j] == ' ') {
                j++;
            }
            int valueStart;
            int valueEnd;
            if (j < end && (b[j] == '"' || b[j] == '\'')) {
                byte quote = b[j];
                valueStart = j + 1;
                valueEnd = valueStart;
                while (valueEnd < end && b[valueEnd] != quote) {
                    valueEnd++;
                }
                j = valueEnd + 1;
            } else {
                valueStart = j;
                valueEnd = j;
                while (valueEnd < end && b[valueEnd] != ' ' && b[valueEnd] != '>') {
                    valueEnd++;
                }
                j = valueEnd;
            }
            if (name.equals(wanted)) {
                return new String(b, valueStart, Math.min(valueEnd, end) - valueStart, StandardCharsets.UTF_8);
            }
        }
        return null;
    }

    /** The text between, tags dropped, entities read and spaces collapsed, cleaned as a title. */
    private String text(int from, int to, int max) {
        StringBuilder raw = new StringBuilder();
        int j = from;
        int start = from;
        while (j < to) {
            if (b[j] == '<') {
                raw.append(new String(b, start, j - start, StandardCharsets.UTF_8));
                int end = tagEnd(j + 1);
                j = end < 0 ? to : Math.min(end, to);
                start = j;
                continue;
            }
            j++;
        }
        raw.append(new String(b, start, Math.max(0, to - start), StandardCharsets.UTF_8));
        String collapsed = entities(raw.toString()).replaceAll("\\s+", " ").strip();
        return TabText.clean(collapsed, max);
    }

    static String entities(String s) {
        if (s.indexOf('&') < 0) {
            return s;
        }
        StringBuilder out = new StringBuilder(s.length());
        int j = 0;
        while (j < s.length()) {
            char c = s.charAt(j);
            int semi = c == '&' ? s.indexOf(';', j) : -1;
            if (semi > j && semi - j <= 10) {
                String name = s.substring(j + 1, semi);
                String decoded = switch (name) {
                    case "amp" -> "&";
                    case "lt" -> "<";
                    case "gt" -> ">";
                    case "quot" -> "\"";
                    case "apos" -> "'";
                    case "nbsp" -> " ";
                    default -> numeric(name);
                };
                if (decoded != null) {
                    out.append(decoded);
                    j = semi + 1;
                    continue;
                }
            }
            out.append(c);
            j++;
        }
        return out.toString();
    }

    private static String numeric(String name) {
        if (name.length() < 2 || name.charAt(0) != '#') {
            return null;
        }
        try {
            boolean hex = name.charAt(1) == 'x' || name.charAt(1) == 'X';
            int code = Integer.parseInt(name.substring(hex ? 2 : 1), hex ? 16 : 10);
            return Character.isValidCodePoint(code) && !(code >= 0xD800 && code <= 0xDFFF) ? new String(Character.toChars(code)) : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private boolean startsWith(int at, String s) {
        if (at + s.length() > b.length) {
            return false;
        }
        for (int k = 0; k < s.length(); k++) {
            if (b[at + k] != s.charAt(k)) {
                return false;
            }
        }
        return true;
    }

    private int indexOf(String s, int from) {
        for (int j = from; j + s.length() <= b.length; j++) {
            if (startsWith(j, s)) {
                return j;
            }
        }
        return -1;
    }

    private int indexOfIgnoreCase(String lower, int from) {
        outer:
        for (int j = from; j + lower.length() <= b.length; j++) {
            for (int k = 0; k < lower.length(); k++) {
                int c = b[j + k];
                if (c >= 'A' && c <= 'Z') {
                    c += 'a' - 'A';
                }
                if (c != lower.charAt(k)) {
                    continue outer;
                }
            }
            return j;
        }
        return -1;
    }

    private String ascii(int from, int to) {
        StringBuilder s = new StringBuilder(to - from);
        for (int k = from; k < to; k++) {
            int c = b[k];
            s.append((char) (c >= 'A' && c <= 'Z' ? c + ('a' - 'A') : c));
        }
        return s.toString();
    }

    private static boolean isLetterOrDigit(byte c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
    }
}
