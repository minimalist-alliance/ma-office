package com.minimalistalliance.desk.deskd.docs;

import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Where a document belongs (deskd {@code API.md} §25 "How a place is decided"; the draft ADR's decision 3): a fixed
 * table, first match wins, pure code with no model. Text never lifts a document above Maybe from an unknown sender and
 * never makes anything urgent; when unsure, Maybe, never hidden. The decision carries the step that made it
 * ({@code basis}) for the evals, and the reason the member sees.
 */
final class Places {

    private Places() {}

    static final String NEEDS = "needs";
    static final String READ = "read";
    static final String RECORDS = "records";
    static final String WORKING = "working";
    static final Set<String> ALL = Set.of(NEEDS, READ, RECORDS, WORKING);

    /** The reader's asks that ask the member to act. */
    static final Set<String> ACTING = Set.of("sign", "pay", "approve", "reply", "decide");
    static final Set<String> RECORD_KINDS = Set.of("receipt", "statement", "confirmation");
    /** File name words for the welcome's kinds (desk text, so Maybe at most). */
    static final Pattern WELCOME_WORDS = Pattern.compile(
            "(?i)(?:^|[^a-z])(invoice|bill|contract|agreement|sign|signature|lease|statement of work|sow|permission slip|consent form)(?:[^a-z]|$)");

    /** What code knows of a document when it decides. Every field is structure or a checked fact, never free text. */
    record Facts(
            String kind, // file, download, attachment, page, agent_output, writeup
            String danger,
            String lane, // Courier's: people, updates, other; null elsewhere
            boolean bulk,
            boolean senderKnown,
            String personKey,
            String domain,
            String origName,
            boolean letThrough,
            Long todoDueAt, // linked to an open to-do: its due time, -1 for none, null for no link
            boolean newVersionOfNeeds, // a new version of one that was in Needs you, changed by someone else
            boolean ownUpload,
            int signaturesEmpty,
            int formEmpty,
            boolean firstOfSenderKind,
            String senderEarlierPlace, // this sender's earlier confirmed place, or null
            Reader reader, // the reader's checked facts, or null
            long arrivedAt,
            long now,
            boolean openedEver,
            String agentName) {}

    /** The reader's checked facts (desk-agent's {@code DocReader}). */
    record Reader(String what, List<String> asks, Long dueAt, Integer signPage) {}

    /** A member's or the welcome's rule. */
    record Rule(String id, String person, String domain, String kind, String source, String effect, String madeBy) {
        /** How specific: person and kind 5, person 4, domain and kind 3, kind 2, source 1. */
        int rank() {
            if (person != null && kind != null) {
                return 5;
            }
            if (person != null) {
                return 4;
            }
            if (domain != null && kind != null) {
                return 3;
            }
            if (kind != null) {
                return 2;
            }
            return source != null ? 1 : 0;
        }

        boolean matches(Facts f, String what) {
            if (person != null && !person.equals(f.personKey())) {
                return false;
            }
            if (domain != null && !domain.equals(f.domain())) {
                return false;
            }
            if (kind != null && !kind.equals(what)) {
                return false;
            }
            return source == null || source.equals(sourceOf(f.kind()));
        }
    }

    /** The place, whether it's Maybe, the reason code and its value, the step that decided, and a due time. */
    record Decision(String place, boolean maybe, String reason, String reasonArg, int basis, Long dueAt) {}

    static String sourceOf(String kind) {
        return switch (kind) {
            case "attachment" -> "courier";
            case "page" -> "notebook";
            case "writeup" -> "writeup";
            case "download" -> "downloads";
            default -> "files";
        };
    }

    /** The kind a rule names: the reader's {@code what} if it ran, else a word in the file name, else null. */
    static String kindOf(Facts f) {
        if (f.reader() != null && f.reader().what() != null && !"other".equals(f.reader().what())) {
            return f.reader().what();
        }
        if (f.origName() != null) {
            String n = f.origName().toLowerCase(Locale.ROOT);
            for (String k : List.of("invoice", "contract", "statement", "receipt", "form", "report", "letter")) {
                if (n.contains(k)) {
                    return k;
                }
            }
        }
        return null;
    }

    static Decision decide(Facts f, List<Rule> rules, List<Rule> welcome) {
        String who = null; // the reason's name is filled by the caller from the record
        // 1. Danger.
        if (f.danger() != null) {
            return new Decision(RECORDS, false, "danger", f.danger(), 1, null);
        }
        String what = kindOf(f);
        // 2. A member rule, most specific first.
        Rule rule = best(rules, f, what);
        if (rule != null && !"ask".equals(rule.effect())) {
            String effect = rule.effect();
            if (NEEDS.equals(effect)) {
                // A rule that names no person (a kind, a domain, a source) can't vouch for a stranger: Maybe (DOC-L3).
                boolean stranger = rule.person() == null && ("other".equals(f.lane()) || f.personKey() != null && !f.senderKnown()
                        || "download".equals(f.kind()));
                return new Decision(NEEDS, stranger, "always", null, 2, todoDue(f));
            }
            return new Decision(effect, false, "rule", effect, 2, null);
        }
        // 3. A welcome rule: needs a known kind, so before a read it can reach Maybe only.
        Rule wr = best(welcome, f, what);
        if (wr != null && NEEDS.equals(wr.effect())) {
            boolean known = f.reader() != null && f.senderKnown();
            if (known) {
                return new Decision(NEEDS, false, "always", null, 3, readerDue(f));
            }
            return new Decision(NEEDS, true, f.senderKnown() ? "first_kind" : "new_sender", null, 3, readerDue(f));
        }
        // 4. Strong structure.
        if (f.todoDueAt() != null) {
            Long due = todoDue(f);
            return new Decision(NEEDS, false, due != null ? "due" : "todo", null, 4, due);
        }
        if (f.letThrough() && f.personKey() != null) {
            return new Decision(NEEDS, false, "from", who, 4, readerDue(f));
        }
        if (f.newVersionOfNeeds()) {
            return new Decision(NEEDS, false, "newver", who, 4, readerDue(f));
        }
        // 7 (early). The reader's facts, when they settle an unclear document; code applies them.
        Reader r = f.reader();
        if (r != null) {
            boolean acting = r.asks() != null && r.asks().stream().anyMatch(ACTING::contains);
            if (acting) {
                String ask = r.asks().stream().filter(ACTING::contains).findFirst().orElse("reply");
                String arg = "sign".equals(ask) && r.signPage() != null ? Integer.toString(r.signPage()) : null;
                if (f.senderKnown() || f.ownUpload() || "agent_output".equals(f.kind()) || "writeup".equals(f.kind())) {
                    return new Decision(NEEDS, false, ask, arg, 7, r.dueAt());
                }
                return new Decision(NEEDS, true, ask, arg, 7, r.dueAt());
            }
        }
        // 5. Weak structure: Maybe.
        if (f.signaturesEmpty() > 0 && !f.ownUpload()) {
            return new Decision(NEEDS, true, "fields", null, 5, null);
        }
        if (r == null && f.origName() != null && WELCOME_WORDS.matcher(f.origName()).find() && !f.ownUpload()
                && !"agent_output".equals(f.kind()) && !"writeup".equals(f.kind()) && !"download".equals(f.kind())
                && !"other".equals(f.lane()) && !f.bulk()) {
            return new Decision(NEEDS, true, f.firstOfSenderKind() ? "first_kind" : "from", who, 5, null);
        }
        if ("other".equals(f.lane()) && r == null) {
            return new Decision(NEEDS, true, "new_sender", null, 5, null);
        }
        if (f.firstOfSenderKind() && "people".equals(f.lane()) && r == null) {
            return new Decision(NEEDS, true, "first_kind", null, 5, null);
        }
        // 6. Low signals.
        if ("updates".equals(f.lane()) || f.bulk()) {
            return new Decision(READ, false, "updates", null, 6, null);
        }
        if (f.senderEarlierPlace() != null && ALL.contains(f.senderEarlierPlace()) && !NEEDS.equals(f.senderEarlierPlace())) {
            return new Decision(f.senderEarlierPlace(), false, "rule", f.senderEarlierPlace(), 6, null);
        }
        if ("download".equals(f.kind())) {
            boolean stale = !f.openedEver() && f.now() - f.arrivedAt() > 7L * 86_400_000L;
            return stale ? new Decision(RECORDS, false, "download", Long.toString(f.arrivedAt()), 6, null)
                    : new Decision(WORKING, false, "download", Long.toString(f.arrivedAt()), 6, null);
        }
        // 7. The reader's remaining facts.
        if (r != null) {
            if (r.what() != null && RECORD_KINDS.contains(r.what())) {
                return new Decision(RECORDS, false, "receipt", null, 7, null);
            }
            return new Decision(READ, false, "people".equals(f.lane()) ? "thread" : "default", who, 7, null);
        }
        // 8. Default.
        if ("agent_output".equals(f.kind()) || "writeup".equals(f.kind())) {
            return new Decision(READ, false, "made", f.agentName(), 8, null);
        }
        if ("people".equals(f.lane())) {
            return new Decision(READ, false, "thread", who, 8, null);
        }
        if (f.ownUpload() && f.now() - f.arrivedAt() < 7L * 86_400_000L) {
            return new Decision(READ, false, "own", null, 8, null);
        }
        return new Decision(RECORDS, false, "default", null, 8, null);
    }

    /** To-do's link: {@code -1} is an open to-do with no day. */
    private static Long todoDue(Facts f) {
        return f.todoDueAt() == null || f.todoDueAt() < 0 ? null : f.todoDueAt();
    }

    private static Long readerDue(Facts f) {
        return f.reader() == null ? null : f.reader().dueAt();
    }

    static Rule best(List<Rule> rules, Facts f, String what) {
        Rule best = null;
        if (rules == null) {
            return null;
        }
        for (Rule r : rules) {
            if (r.matches(f, what) && (best == null || r.rank() > best.rank())) {
                best = r;
            }
        }
        return best;
    }
}
