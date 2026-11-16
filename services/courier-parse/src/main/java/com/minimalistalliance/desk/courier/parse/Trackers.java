package com.minimalistalliance.desk.courier.parse;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Who tracks: ADR 0076's pinned lists, as a host list, and the shapes an open-tracking pixel has whatever its host.
 *
 * <p>The list is the Browser blocker's own: the image's bake writes {@code courier-trackers.txt} from the EasyPrivacy
 * ruleset of uBlock Origin Lite's release that {@code image/recipe/adblock/blocker.pin} names
 * ({@code scripts/courier-trackers.py}: one lowercase ASCII host a line, or {@code host/path} for a host and a path prefix,
 * {@code #} comments), and the Courier sandbox gets it read-only. It's read once, before the worker's
 * security manager is installed, from the path in {@code -Dma.courier.trackers}. A host matches itself and any subdomain.
 * Without the file (an image from before it), the shapes below still remove pixels; the answer doesn't change otherwise.
 */
public final class Trackers {

    /** Hosts read at most: the pinned EasyPrivacy has some tens of thousands. */
    static final int MAX_HOSTS = 500_000;

    private static volatile Trackers current = new Trackers(Set.of());

    private final Set<String> hosts;
    /** Host and path prefixes ({@code ||host/path} rules): a host, or a domain it's under, then the path's start. */
    private final java.util.Map<String, java.util.List<String>> paths;

    private Trackers(Set<String> hosts) {
        this(hosts, java.util.Map.of());
    }

    private Trackers(Set<String> hosts, java.util.Map<String, java.util.List<String>> paths) {
        this.hosts = hosts;
        this.paths = paths;
    }

    /** The list in use. */
    static Trackers current() {
        return current;
    }

    /** Makes {@code trackers} the list in use (the worker at its start, tests). */
    public static void use(Trackers trackers) {
        current = trackers;
    }

    public static Trackers of(Set<String> hosts) {
        Set<String> clean = new HashSet<>();
        for (String h : hosts) {
            String host = host(h);
            if (host != null) {
                clean.add(host);
            }
        }
        return new Trackers(Set.copyOf(clean));
    }

    /** The list at {@code path}; an empty one if there's no such regular file or it can't be read. */
    public static Trackers load(String path) {
        if (path == null || path.isBlank()) {
            return new Trackers(Set.of());
        }
        Path file = Path.of(path);
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
            return new Trackers(Set.of());
        }
        try (InputStream in = Files.newInputStream(file)) {
            return read(in);
        } catch (IOException | RuntimeException e) {
            return new Trackers(Set.of());
        }
    }

    public static Trackers read(InputStream in) throws IOException {
        Set<String> hosts = new HashSet<>();
        java.util.Map<String, java.util.List<String>> paths = new java.util.HashMap<>();
        BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.US_ASCII));
        String line;
        int n = 0;
        while ((line = r.readLine()) != null && n < MAX_HOSTS) {
            if (line.startsWith("#")) {
                continue;
            }
            String entry = line.strip();
            int slash = entry.indexOf('/');
            if (slash > 0) {
                String host = host(entry.substring(0, slash));
                String path = entry.substring(slash);
                if (host != null && path.length() <= 512 && path.chars().allMatch(c -> c > 0x20 && c < 0x7F)) {
                    paths.computeIfAbsent(host, k -> new java.util.ArrayList<>()).add(path);
                    n++;
                }
                continue;
            }
            String host = host(entry);
            if (host != null) {
                hosts.add(host);
                n++;
            }
        }
        java.util.Map<String, java.util.List<String>> frozen = new java.util.HashMap<>();
        paths.forEach((k, v) -> frozen.put(k, java.util.List.copyOf(v)));
        return new Trackers(Set.copyOf(hosts), java.util.Map.copyOf(frozen));
    }

    private static final Pattern HOST = Pattern.compile("[a-z0-9_]([a-z0-9_-]{0,62}\\.)*[a-z0-9_-]{1,63}");

    private static String host(String s) {
        String h = s.trim().toLowerCase(Locale.ROOT);
        if (h.endsWith(".")) {
            h = h.substring(0, h.length() - 1);
        }
        return h.length() > 253 || !h.contains(".") || !HOST.matcher(h).matches() ? null : h;
    }

    public int size() {
        return hosts.size() + paths.values().stream().mapToInt(java.util.List::size).sum();
    }

    /** Whether an address (an ASCII host and its path with the query) is listed: by its host, or by a host and path prefix. */
    boolean listed(String host, String pathAndQuery) {
        if (listed(host)) {
            return true;
        }
        if (host == null || paths.isEmpty() || pathAndQuery == null) {
            return false;
        }
        String h = host.toLowerCase(Locale.ROOT);
        for (int i = 0; i < 64; i++) {
            java.util.List<String> prefixes = paths.get(h);
            if (prefixes != null) {
                for (String p : prefixes) {
                    if (pathAndQuery.startsWith(p)) {
                        return true;
                    }
                }
            }
            int dot = h.indexOf('.');
            if (dot < 0) {
                return false;
            }
            h = h.substring(dot + 1);
        }
        return false;
    }

    /** Whether an ASCII host, or a domain it's under, is listed. */
    boolean listed(String host) {
        if (host == null || hosts.isEmpty()) {
            return false;
        }
        String h = host.toLowerCase(Locale.ROOT);
        for (int i = 0; i < 64; i++) {
            if (hosts.contains(h)) {
                return true;
            }
            int dot = h.indexOf('.');
            if (dot < 0) {
                return false;
            }
            h = h.substring(dot + 1);
        }
        return false;
    }

    /**
     * The paths email services' open-tracking pixels have (SendGrid's {@code /wf/open}, {@code /track/open},
     * {@code /o.gif}, {@code /pixel.png}, {@code /beacon} and the like), so a pixel is removed even when its host isn't
     * listed and its size isn't given.
     */
    private static final Pattern PIXEL_PATH = Pattern.compile(
            "(?i)(?:^|/)(?:wf/open|track/open|trk/open|tracking/open|e/o|ss/o|open|o|pixel|beacon|spacer|imp|impression|"
                    + "trackopen|emailopen|mailopen|op|t)(?:\\.(?:gif|png|jpe?g|php|aspx?|cgi))?/?$");

    static boolean pixelPath(String path) {
        return path != null && path.length() <= 2048 && PIXEL_PATH.matcher(path).find();
    }
}
