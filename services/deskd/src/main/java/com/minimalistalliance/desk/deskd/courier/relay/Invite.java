package com.minimalistalliance.desk.deskd.courier.relay;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * An invite link (contract 0.4.0 §2.1): {@code ma://courier/<address>#k=<fingerprint>}. The address is canonical (lower
 * case, no {@code +tag}); the fingerprint is the contract's, 8 groups of 4 lower-case hex digits. A first contact opened
 * from one is verified with no extra step: the keys the directory gives must have that fingerprint, or nothing is pinned.
 */
public record Invite(String address, String fingerprint) {

    /** A canonical Courier address: the envelope library's grammar (contract §1). */
    static final Pattern ADDRESS = Pattern.compile(
            "[a-z0-9](?:[a-z0-9]|[.-](?=[a-z0-9])){1,30}[a-z0-9]@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}");
    private static final Pattern LINK = Pattern.compile("ma://courier/([^#?/\\s]{1,320})#k=([0-9A-Fa-f]{4}(?:-[0-9A-Fa-f]{4}){7})");

    /** The link for an address and its fingerprint. */
    public static String link(String address, String fingerprint) {
        return "ma://courier/" + address + "#k=" + fingerprint;
    }

    /**
     * Reads a link: exactly the contract's shape, nothing before or after it, an address that's canonical once lower-cased
     * (a {@code +tag} is taken off).
     *
     * @return the invite, or null if it isn't one
     */
    public static Invite parse(String link) {
        if (link == null || link.length() > 400) {
            return null;
        }
        Matcher m = LINK.matcher(link.strip());
        if (!m.matches()) {
            return null;
        }
        String address = canonical(m.group(1));
        return address == null ? null : new Invite(address, m.group(2).toLowerCase(Locale.ROOT));
    }

    /** An address in its canonical form (lower case, no {@code +tag}), or null if it isn't a Courier address. */
    public static String canonical(String address) {
        if (address == null || address.length() > 320) {
            return null;
        }
        String a = address.strip().toLowerCase(Locale.ROOT);
        int at = a.lastIndexOf('@');
        if (at <= 0) {
            return null;
        }
        String local = a.substring(0, at);
        int plus = local.indexOf('+');
        if (plus >= 0) {
            local = local.substring(0, plus);
        }
        String out = local + a.substring(at);
        return ADDRESS.matcher(out).matches() ? out : null;
    }
}
