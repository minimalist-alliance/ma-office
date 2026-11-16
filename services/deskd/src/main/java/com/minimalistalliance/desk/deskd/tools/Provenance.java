package com.minimalistalliance.desk.deskd.tools;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * What a run was given, for To-do's provenance (API.md §22, "deskd's checks"; the To-do VISION §4): after a tool deskd
 * hosts has run, the sources its result named go into deskd's own record of the run ({@link RunLedger.Run#gave}), with a
 * label written from that same result, never from anything the model sends. {@code todo_add} then accepts a source only
 * if this run was given it ({@code source_unknown} otherwise).
 *
 * <ul>
 *   <li>{@code notebook_read}: the page, by {@code pageId}, labelled with its title.
 *   <li>{@code files_read}: the file, by its path, labelled with its name.
 *   <li>{@code browser_open}, {@code browser_read} and the actions that answer with the page: the page, by its URL
 *       (http and https only, the fragment left out), labelled with its host and title.
 *   <li>{@code courier_read} and {@code courier_new} (Courier's read tools, {@link CourierTools}): each message the run
 *       was given (one read whole, a channel's page, the new ones), by {@code messageId}, labelled "Email from {contact}
 *       · {subject}" from Courier's contact record; a sender Courier couldn't confirm (Other's strangers, or an email
 *       whose DMARC didn't pass: Security's answer to the store's question 1) by its address, never a display name, with
 *       "(unconfirmed)" (the name or address cut to 40 so the mark fits, CR-L1), scoped to its channel. A search's hits and a list aren't a read, as for Files and Notebook (Security's TD-L1).
 *   <li>{@code desk}: a message from another of the member's desks, by its envelope's id, recorded by
 *       {@code desks/DeskSources} from deskd's own record of the envelopes it opened (the message that started a run on
 *       the answering desk; an answer the waiting {@code desk_message} call took on the asking one), labelled with the
 *       other agent's name from the signed envelope.
 * </ul>
 * A ref the model names is matched on what identifies it ({@link #key}), so a URL with another fragment or a path with a
 * slash at either end is the same source.
 */
public final class Provenance {

    private Provenance() {}

    /** After a call ran: what its result named goes into the run's record. Never throws. */
    static void record(String tool, Object content, RunLedger.Run run) {
        if (run == null || !(content instanceof Map<?, ?> out)) {
            return;
        }
        try {
            switch (tool) {
                // Only what the run read: a search hit or a listed page isn't (Security's TD-L1).
                case "notebook_read" -> page(out, run);
                case "files_read" -> file(out.get("path"), run);
                case "browser_open", "browser_read", "browser_click", "browser_press", "browser_type", "browser_back" ->
                        web(out, run);
                // Only what the run was given whole: a search's hits and a list aren't a read (TD-L1).
                case "courier_read", "courier_new" -> courier(out, run);
                default -> {
                    // Nothing else names a source.
                }
            }
        } catch (RuntimeException e) {
            // A result that isn't the shape expected records nothing, and the add that cites it is refused.
        }
    }

    /**
     * The key a source is recorded and looked up by: its kind and what identifies it. Null for a ref that can't be one.
     */
    public static String key(String kind, Map<String, Object> ref) {
        if (kind == null || ref == null) {
            return null;
        }
        return switch (kind) {
            case "notebook" -> ref.get("pageId") instanceof String id && !id.isBlank() ? "notebook\n" + id : null;
            case "files" -> ref.get("path") instanceof String path && !strip(path).isEmpty() ? "files\n" + strip(path) : null;
            case "browser" -> ref.get("url") instanceof String url && webUrl(url) != null ? "browser\n" + webUrl(url) : null;
            case "courier" -> ref.get("messageId") instanceof String id && !id.isBlank() ? "courier\n" + id : null;
            case "desk" -> ref.get("messageId") instanceof String id && !id.isBlank() ? "desk\n" + id : null;
            default -> null;
        };
    }

    private static void page(Map<?, ?> m, RunLedger.Run run) {
        if (!(m.get("pageId") instanceof String pageId) || pageId.isBlank()) {
            return;
        }
        String title = m.get("title") instanceof String t ? t : "";
        Map<String, Object> ref = Map.of("pageId", pageId);
        run.gave(key("notebook", ref), "notebook", ref, title.isBlank() ? "A Notebook page" : "Notebook page · " + title,
                "notebook:" + pageId);
    }

    private static void file(Object path, RunLedger.Run run) {
        if (!(path instanceof String p) || strip(p).isEmpty()) {
            return;
        }
        String clean = strip(p);
        String name = clean.substring(clean.lastIndexOf('/') + 1);
        Map<String, Object> ref = Map.of("path", clean);
        run.gave(key("files", ref), "files", ref, "File · " + name, "files:" + clean);
    }

    private static void web(Map<?, ?> out, RunLedger.Run run) {
        if (!(out.get("url") instanceof String url)) {
            return;
        }
        String clean = webUrl(url);
        if (clean == null) {
            return;
        }
        String host = URI.create(clean).getHost();
        String title = out.get("title") instanceof String t ? t : "";
        Map<String, Object> ref = Map.of("url", clean);
        run.gave(key("browser", ref), "browser", ref, title.isBlank() ? "Page on " + host : host + " · " + title,
                "browser:" + host + URI.create(clean).getRawPath());
    }

    /** §12's messages: a message whole, a page of a channel, or the new ones. */
    private static void courier(Map<?, ?> out, RunLedger.Run run) {
        message(out, run);
        each(out.get("messages"), m -> message(m, run));
    }

    private static void message(Map<?, ?> m, RunLedger.Run run) {
        if (!(m.get("messageId") instanceof String messageId) || messageId.isBlank()) {
            return;
        }
        String channelId = m.get("channelId") instanceof String c ? c : null;
        boolean me = m.get("from") instanceof Map<?, ?> f && Boolean.TRUE.equals(f.get("me"));
        boolean unconfirmed = !me && (Boolean.FALSE.equals(m.get("senderKnown"))
                || Boolean.FALSE.equals(m.get("senderConfirmed")));
        String name = m.get("from") instanceof Map<?, ?> from && from.get("name") instanceof String n && !n.isBlank() ? n : null;
        String address = m.get("from") instanceof Map<?, ?> from && from.get("endpoint") instanceof String e && !e.isBlank()
                ? e : null;
        // A sender Courier couldn't confirm (Other's strangers; an email whose DMARC didn't pass) is named by the address
        // it came from, never a display name it wrote, and says so; the name is cut so the mark always fits To-do's
        // 80-character label (Security's CR-L1).
        String who = me ? "you" : unconfirmed ? (address != null ? address : name) : (name != null ? name : address);
        who = who == null ? "" : cut(who, WHO_MAX);
        if (unconfirmed && !who.isBlank()) {
            who = who + " (unconfirmed)";
        }
        String subject = m.get("subject") instanceof String s ? s : "";
        String medium = "email".equals(m.get("medium")) ? "Email" : "Message";
        String label = medium + (who.isBlank() ? "" : " from " + who) + (subject.isBlank() ? "" : " · " + subject);
        Map<String, Object> ref = new LinkedHashMap<>();
        ref.put("messageId", messageId);
        if (channelId != null) {
            ref.put("channelId", channelId);
        }
        run.gave(key("courier", ref), "courier", ref, label, channelId == null ? null : "courier:" + channelId);
    }

    /** A sender's name or address in a label, at most: with " (unconfirmed)" and "Email from ", well inside 80. */
    static final int WHO_MAX = 40;

    private static String cut(String s, int max) {
        if (s.codePointCount(0, s.length()) <= max) {
            return s;
        }
        return s.substring(0, s.offsetByCodePoints(0, max - 1)) + "…";
    }

    private static void each(Object list, java.util.function.Consumer<Map<?, ?>> action) {
        if (list instanceof List<?> items) {
            for (Object item : items) {
                if (item instanceof Map<?, ?> m) {
                    action.accept(m);
                }
            }
        }
    }

    private static String strip(String path) {
        String p = path.strip();
        while (p.startsWith("/")) {
            p = p.substring(1);
        }
        while (p.endsWith("/")) {
            p = p.substring(0, p.length() - 1);
        }
        return p;
    }

    /** An http or https URL without its fragment, host in lower case; null for anything else. */
    static String webUrl(String url) {
        try {
            URI u = new URI(url.strip());
            String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
            if ((!scheme.equals("http") && !scheme.equals("https")) || u.getHost() == null || u.getRawUserInfo() != null
                    || url.length() > 2048) {
                return null;
            }
            String path = u.getRawPath() == null || u.getRawPath().isEmpty() ? "/" : u.getRawPath();
            String port = u.getPort() < 0 ? "" : ":" + u.getPort();
            String s = scheme + "://" + u.getHost().toLowerCase(Locale.ROOT) + port + path;
            return u.getRawQuery() == null ? s : s + "?" + u.getRawQuery();
        } catch (URISyntaxException | IllegalArgumentException e) {
            return null;
        }
    }
}
