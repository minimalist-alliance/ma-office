package com.minimalistalliance.desk.deskd.courier.relay;

import com.minimalistalliance.desk.deskd.courier.store.Accounts;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.RelayState;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.BiPredicate;

/**
 * The delivery picker (design §8.3, the plan §1.5): which medium and account a reply goes by, and why, so the composer can
 * say "By email · her last message was an email, 2 h ago". In order:
 *
 * <ol>
 *   <li>the medium (and account) of the last message received from the other party in this channel (in a group, from any
 *       of them), if a transport can send on it now and it reaches every recipient;
 *   <li>the channel's preferred medium, on the same terms;
 *   <li>{@code ma}, if every recipient has a member's address (an {@code ma} endpoint; an email address on the Courier
 *       domain is reached sealed by the email sender of the desk's address);
 *   <li>otherwise none: the member picks.
 * </ol>
 *
 * <p>Two rules on top: <b>a member's address is never mailed through {@code courier-send}</b> (the email sender seals to it
 * instead, so it reaches the same desk sealed), and <b>a pinned key that changed blocks the {@code ma} default</b>: no
 * default is offered until the member checks the new safety number (spike Q-C4).
 */
final class Picker {

    private Picker() {}

    /** The pick: {@code medium} and {@code accountId} (null when the member must choose), the reason, and every option. */
    record Pick(String medium, String accountId, String reason, String reasonMedium, Long reasonAt, List<String> blockedBy,
            List<Map<String, Object>> options) {
        Map<String, Object> toMap() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("medium", medium);
            m.put("accountId", accountId);
            Map<String, Object> why = new LinkedHashMap<>();
            why.put("kind", reason);
            why.put("medium", reasonMedium);
            why.put("at", reasonAt);
            if (!blockedBy.isEmpty()) {
                why.put("addresses", blockedBy);
            }
            m.put("reason", why);
            m.put("options", options);
            return m;
        }
    }

    /**
     * @param people the channel's people (or the draft's To), each with every endpoint they have
     * @param facts the channel's facts, or null for a new conversation
     * @param accounts the desk's accounts
     * @param canSend whether a transport can send on a medium and account now
     * @param courierDomain the Courier domain, or null while it isn't known
     * @param changed the member addresses whose pinned key changed
     */
    static Pick pick(List<RelayState.Person> people, RelayState.PickFacts facts, List<Courier.Account> accounts,
            BiPredicate<String, String> canSend, String courierDomain, Set<String> changed) {
        List<Map<String, Object>> options = new ArrayList<>();
        for (Courier.Account a : accounts) {
            String medium = mediumOf(a.kind());
            if (medium == null) {
                continue;
            }
            Map<String, Object> o = new LinkedHashMap<>();
            o.put("medium", medium);
            o.put("accountId", a.id());
            o.put("kind", a.kind());
            o.put("label", a.label());
            o.put("sendable", canSend.test(medium, a.id()));
            o.put("reaches", reachesAll(people, medium, courierDomain));
            if ("ma".equals(medium)) {
                List<String> blocked = blockedBy(people, courierDomain, changed);
                if (!blocked.isEmpty()) {
                    o.put("blocked", "key_changed");
                }
            }
            options.add(o);
        }
        if (people.isEmpty()) {
            return new Pick(null, null, "choose", null, null, List.of(), options);
        }
        // 1. The last message received from them.
        if (facts != null && facts.lastMedium() != null && facts.lastAccount() != null
                && usable(facts.lastMedium(), facts.lastAccount(), people, canSend, courierDomain)) {
            return guarded(new Pick(facts.lastMedium(), facts.lastAccount(), "last_inbound", facts.lastMedium(), facts.lastAt(), List.of(),
                    options), people, courierDomain, changed);
        }
        // 2. The channel's preferred medium, by the first account of it that can send.
        if (facts != null && facts.preferred() != null) {
            for (Courier.Account a : accounts) {
                if (facts.preferred().equals(mediumOf(a.kind())) && usable(facts.preferred(), a.id(), people, canSend, courierDomain)) {
                    return guarded(new Pick(facts.preferred(), a.id(), "preferred", facts.preferred(), null, List.of(), options), people,
                            courierDomain, changed);
                }
            }
        }
        // 3. Sealed between desks, if everyone has a member's address.
        for (Courier.Account a : accounts) {
            if (Accounts.MA.equals(a.kind()) && usable("ma", a.id(), people, canSend, courierDomain)) {
                return guarded(new Pick("ma", a.id(), "all_members", "ma", null, List.of(), options), people, courierDomain, changed);
            }
        }
        return new Pick(null, null, "choose", null, null, List.of(), options);
    }

    /** A changed key on any recipient takes the {@code ma} default away. */
    private static Pick guarded(Pick p, List<RelayState.Person> people, String courierDomain, Set<String> changed) {
        if (!"ma".equals(p.medium())) {
            return p;
        }
        List<String> blocked = blockedBy(people, courierDomain, changed);
        if (blocked.isEmpty()) {
            return p;
        }
        return new Pick(null, null, "key_changed", p.reasonMedium(), p.reasonAt(), blocked, p.options());
    }

    private static List<String> blockedBy(List<RelayState.Person> people, String courierDomain, Set<String> changed) {
        List<String> out = new ArrayList<>();
        for (RelayState.Person person : people) {
            for (String[] e : person.endpoints()) {
                String a = memberAddress(e, courierDomain);
                if (a != null && changed.contains(a) && !out.contains(a)) {
                    out.add(a);
                }
            }
        }
        return out;
    }

    private static boolean usable(String medium, String accountId, List<RelayState.Person> people, BiPredicate<String, String> canSend,
            String courierDomain) {
        return canSend.test(medium, accountId) && reachesAll(people, medium, courierDomain);
    }

    static boolean reachesAll(List<RelayState.Person> people, String medium, String courierDomain) {
        if (people.isEmpty()) {
            return false;
        }
        for (RelayState.Person p : people) {
            if (!reaches(p, medium, courierDomain)) {
                return false;
            }
        }
        return true;
    }

    private static boolean reaches(RelayState.Person p, String medium, String courierDomain) {
        for (String[] e : p.endpoints()) {
            String kind = e[0];
            boolean ok = switch (medium) {
                // A member's address is an email address too: mail to it goes sealed from the desk's address, or through the door
                // from a linked mailbox.
                case "email" -> "email".equals(kind) || "ma".equals(kind);
                // The queue sends an ma message to the contact's ma endpoints; an email address on the Courier domain is reached
                // sealed through the email sender instead.
                case "ma" -> "ma".equals(kind);
                case "imessage", "sms" -> "phone".equals(kind) || "apple".equals(kind);
                default -> false;
            };
            if (ok) {
                return true;
            }
        }
        return false;
    }

    /** The member's address an endpoint is, or null: an {@code ma} endpoint, or an email one on the Courier domain. */
    static String memberAddress(String[] endpoint, String courierDomain) {
        if ("ma".equals(endpoint[0])) {
            return endpoint[1];
        }
        if ("email".equals(endpoint[0]) && courierDomain != null && endpoint[1] != null) {
            String a = Invite.canonical(endpoint[1]);
            if (a != null && a.endsWith("@" + courierDomain)) {
                return a;
            }
        }
        return null;
    }

    static String mediumOf(String accountKind) {
        return switch (accountKind) {
            case Accounts.DESK, Accounts.IMAP, Accounts.JMAP -> "email";
            case Accounts.MA -> "ma";
            case Accounts.IMESSAGE -> "imessage";
            default -> null;
        };
    }
}
