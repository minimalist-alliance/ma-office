package com.minimalistalliance.desk.deskd.browser.minified;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TreeSet;

/**
 * The lists that ship with deskd, one host per line: a host is on a list if it's an entry or under one. They're in the
 * release, so they change only with a release of deskd, and nothing on a desk fetches them.
 *
 * <ul>
 *   <li>{@code sensitive-sites.txt}: sites that always open as the stream, as their pages are the member's money, mail,
 *       health or identity (Security T47-7). Only ever adds sensitivity.
 *   <li>{@code payment-hosts.txt}: payment providers whose frames hold card fields (T47-1).
 *   <li>{@code video-hosts.txt}: players whose frames are a video island rather than an unknown frame.
 * </ul>
 */
final class HostLists {

    private static final String BASE = "/com/minimalistalliance/desk/deskd/browser/minified/";

    final List<String> sensitive;
    final List<String> payment;
    final List<String> video;
    /** Ad and tracker frames' hosts: never content, never another site's frame over the page. */
    final List<String> ad;
    /** Consent managers' frames' hosts: the site's consent banner, never content. */
    final List<String> consent;

    private HostLists(List<String> sensitive, List<String> payment, List<String> video, List<String> ad, List<String> consent) {
        this.sensitive = sensitive;
        this.payment = payment;
        this.video = video;
        this.ad = ad;
        this.consent = consent;
    }

    static HostLists load() {
        return new HostLists(read("sensitive-sites.txt"), read("payment-hosts.txt"), read("video-hosts.txt"),
                read("ad-hosts.txt"), read("consent-hosts.txt"));
    }

    static boolean on(List<String> list, String host) {
        if (host == null || host.isEmpty()) {
            return false;
        }
        String lower = host.toLowerCase(Locale.ROOT);
        for (String entry : list) {
            if (lower.equals(entry) || (lower.length() > entry.length() && lower.endsWith(entry) && lower.charAt(lower.length() - entry.length() - 1) == '.')) {
                return true;
            }
        }
        return false;
    }

    private static List<String> read(String name) {
        try (InputStream in = HostLists.class.getResourceAsStream(BASE + name)) {
            if (in == null) {
                throw new IllegalStateException("missing resource " + name);
            }
            Set<String> hosts = new TreeSet<>();
            for (String line : new String(in.readAllBytes(), StandardCharsets.UTF_8).split("\n")) {
                String host = line.strip().toLowerCase(Locale.ROOT);
                if (!host.isEmpty() && !host.startsWith("#")) {
                    hosts.add(host);
                }
            }
            return List.copyOf(new ArrayList<>(hosts));
        } catch (IOException e) {
            throw new IllegalStateException("unreadable resource " + name, e);
        }
    }
}
