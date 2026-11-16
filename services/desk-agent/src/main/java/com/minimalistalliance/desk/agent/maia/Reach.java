package com.minimalistalliance.desk.agent.maia;

import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.team.TextChecks;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.ToIntFunction;

/**
 * What reaches the member (the shield concept §3, §4, §9): the shield's item, the member's settings and let-through
 * list, and the <b>context-distance score</b>. Each item gets a distance from now, 0 to 100, from four parts: closeness
 * to what the member is doing (C, structural matches only), urgency by fixed rules (U), the sender's or topic's
 * standing (I) and a deadline code can check (D), plus what's learned, repeats and the day's budget. <b>Only U = 1
 * opens
 * the interrupt gate</b>: a code-rule Now (the list's own rule, {@link Attention}) or a let-through match with the
 * sender's identity checked. No weight, learning or score opens it, and nothing a desk wrote moves an item: a subject
 * saying "URGENT" is never read. Pure; code only, no model, no credits.
 */
public final class Reach {

    public static final double W_CLOSE = 0.45;
    public static final double W_URGENT = 0.20;
    public static final double W_IMPORTANT = 0.15;
    public static final double W_DEADLINE = 0.20;
    /** The let-through list, at most. */
    public static final int LIST_MAX = 5;
    static final int NAME_MAX = 60;
    static final int LABEL_MAX = 40;
    static final long HOUR = 3_600_000L;

    private Reach() {}

    // ---------------------------------------------------------------- the item

    /** Where the item lives, for closeness: its app and the ids it's linked to. */
    public record Refs(String app, String channelId, String todoId, String docId, String agentId, String itemId,
            List<Focus.Person> people) {
        public Refs {
            people = people == null ? List.of() : List.copyOf(people);
        }

        static Refs of(String app) {
            return new Refs(app, null, null, null, null, null, List.of());
        }
    }

    /** Who it's from, as structure: standing and the identity check (an email's DMARC pass, a text's known channel). */
    public record Sender(Focus.Person person, String standing, boolean confirmed, int replyBand, Long wroteLastAt,
            boolean direct) {
        static final Sender NONE = new Sender(null, "own", true, 0, null, false);
    }

    /**
     * One thing that might reach the member. {@code need}: {@code you} (someone waits on the member), {@code action},
     * {@code info} or {@code record}. {@code tags}: {@code due_today}, {@code money}, {@code stuck}, {@code pinned},
     * {@code changed}. {@code title} and {@code source} are code's templates with a desk's text cut to 60 characters;
     * they live in memory only.
     */
    public record Item(String key, String kind, String deskId, String deskName, String scope, boolean codeNow,
            Refs refs, Sender sender, Long deadlineAt, boolean expires, String need, Set<String> tags, int count,
            long at, boolean dismissable, String title, String source, Map<String, Object> go, String goLabel) {
        public Item {
            tags = tags == null ? Set.of() : Set.copyOf(tags);
            refs = refs == null ? Refs.of(null) : refs;
            sender = sender == null ? Sender.NONE : sender;
        }

        public String id() {
            return Attention.id(key);
        }

        boolean record() {
            return "record".equals(need);
        }

        /** The learning class's source: a contact, an agent or a desk (concept §10; {@link Learn}). */
        public String from() {
            if (sender.person() != null) {
                return "contact:" + sender.person().deskId() + ":" + sender.person().contactId();
            }
            if (refs.agentId() != null) {
                return "agent:" + deskId + ":" + refs.agentId();
            }
            return "desk:" + (deskId == null ? "maia" : deskId);
        }
    }

    // ---------------------------------------------------------------- the member's settings

    /** One let-through entry (concept §9.2): a person, a group or a kind ({@code match}). */
    public record Rule(String ruleId, String kind, Focus.Person person, String pendingName, String group,
            String match, boolean anyTime, String source, long createdAt) {

        Map<String, Object> view() {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("ruleId", ruleId);
            v.put("kind", kind);
            if ("person".equals(kind)) {
                Map<String, Object> p = new LinkedHashMap<>();
                if (person != null) {
                    p.put("deskId", person.deskId());
                    p.put("contactId", person.contactId());
                } else {
                    p.put("pendingName", pendingName);
                }
                v.put("person", p);
            }
            if (group != null) {
                v.put("group", group);
            }
            if (match != null) {
                v.put("match", match);
            }
            v.put("anyTime", anyTime);
            v.put("source", source);
            v.put("createdAt", createdAt);
            return v;
        }
    }

    /** The list's groups; {@code boss_clients} is the welcome's one entry "My boss or clients" (contacts tagged either). */
    public static final Set<String> GROUPS = Set.of("family", "boss", "clients", "team", "boss_clients");
    /** What a contact may be tagged. */
    public static final Set<String> TAGS = Set.of("family", "boss", "clients", "team");
    public static final Set<String> MATCHES = Set.of("due_today", "money", "waiting_reply");
    public static final Set<String> DETAILS = Set.of("line", "paragraph", "full");

    /** A span of the day, {@code HH:MM} to {@code HH:MM}, in the desk's zone. */
    public record Span(LocalTime from, LocalTime to) {
        boolean contains(LocalTime t) {
            return from.isBefore(to) ? !t.isBefore(from) && t.isBefore(to) : !t.isBefore(from) || t.isBefore(to);
        }

        Map<String, Object> view() {
            return Map.of("from", hhmm(from), "to", hhmm(to));
        }
    }

    /** The member's settings: What reaches you, and the welcome's Q4 to Q7. */
    public record Settings(List<Rule> letThrough, boolean holdAll, List<LocalTime> catchUps, List<Span> focusHours,
            Span quietHours, String evenings, String detail, boolean showAll) {
        public Settings {
            letThrough = List.copyOf(letThrough);
            catchUps = List.copyOf(catchUps);
            focusHours = List.copyOf(focusHours);
        }

        public static final List<LocalTime> DEFAULT_CATCHUPS = List.of(LocalTime.of(9, 0), LocalTime.of(13, 0),
                LocalTime.of(17, 0));

        /** Skip in the welcome: due today and money, catch-ups 9, 1 and 5, no focus hours, evenings hold. */
        public static Settings defaults(long now) {
            return new Settings(List.of(
                    new Rule("mr-due-today", "match", null, null, null, "due_today", false, "default", now),
                    new Rule("mr-money", "match", null, null, null, "money", false, "default", now)),
                    false, DEFAULT_CATCHUPS, List.of(), null, "hold", "paragraph", false);
        }

        public Map<String, Object> view() {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("letThrough", letThrough.stream().map(Rule::view).toList());
            v.put("holdAll", holdAll);
            v.put("catchUps", catchUps.stream().map(Reach::hhmm).toList());
            v.put("focusHours", focusHours.stream().map(Span::view).toList());
            v.put("quietHours", quietHours == null ? null : quietHours.view());
            v.put("evenings", evenings);
            v.put("detail", detail);
            v.put("showAll", showAll);
            return v;
        }

        Settings withList(List<Rule> list) {
            return new Settings(list, holdAll, catchUps, focusHours, quietHours, evenings, detail, showAll);
        }
    }

    static String hhmm(LocalTime t) {
        return String.format(Locale.ROOT, "%02d:%02d", t.getHour(), t.getMinute());
    }

    /**
     * {@code agent.maia.reach.set}'s params over the settings before: each field checked, {@code bad_request}
     * otherwise. {@code newId} makes a rule id for an entry sent without one.
     */
    public static Settings set(Map<String, Object> p, Settings before, long now,
            java.util.function.Supplier<String> newId) throws RpcError {
        Set<String> known = Set.of("letThrough", "holdAll", "catchUps", "focusHours", "quietHours", "evenings",
                "detail", "showAll");
        for (String k : p.keySet()) {
            if (!known.contains(k)) {
                throw RpcError.of("bad_request", "detail", "reach." + k);
            }
        }
        List<Rule> list = before.letThrough();
        if (p.containsKey("letThrough")) {
            list = rules(p.get("letThrough"), before.letThrough(), now, newId);
        }
        boolean holdAll = before.holdAll();
        if (p.containsKey("holdAll")) {
            if (!(p.get("holdAll") instanceof Boolean b)) {
                throw RpcError.badRequest("reach.holdAll");
            }
            holdAll = b;
        }
        if (holdAll && !list.isEmpty()) {
            throw RpcError.of("bad_request", "reason", "hold_all", "detail", "reach.letThrough");
        }
        List<LocalTime> catchUps = before.catchUps();
        if (p.containsKey("catchUps")) {
            catchUps = catchUps(p.get("catchUps"));
        }
        List<Span> focus = before.focusHours();
        if (p.containsKey("focusHours")) {
            focus = spans(p.get("focusHours"), 3, "reach.focusHours");
        }
        Span quiet = before.quietHours();
        if (p.containsKey("quietHours")) {
            quiet = p.get("quietHours") == null ? null : span(p.get("quietHours"), "reach.quietHours");
        }
        String evenings = before.evenings();
        if (p.containsKey("evenings")) {
            if (!(p.get("evenings") instanceof String e) || !Set.of("hold", "let").contains(e)) {
                throw RpcError.badRequest("reach.evenings");
            }
            evenings = e;
        }
        String detail = before.detail();
        if (p.containsKey("detail")) {
            if (!(p.get("detail") instanceof String d) || !DETAILS.contains(d)) {
                throw RpcError.badRequest("reach.detail");
            }
            detail = d;
        }
        boolean showAll = before.showAll();
        if (p.containsKey("showAll")) {
            if (!(p.get("showAll") instanceof Boolean b)) {
                throw RpcError.badRequest("reach.showAll");
            }
            showAll = b;
        }
        return new Settings(list, holdAll, catchUps, focus, quiet, evenings, detail, showAll);
    }

    static List<Rule> rules(Object raw, List<Rule> before, long now, java.util.function.Supplier<String> newId)
            throws RpcError {
        if (!(raw instanceof List<?> given)) {
            throw RpcError.badRequest("reach.letThrough");
        }
        if (given.size() > LIST_MAX) {
            throw RpcError.of("bad_request", "reason", "too_many", "detail", "reach.letThrough");
        }
        List<Rule> out = new ArrayList<>();
        Set<String> ids = new java.util.HashSet<>();
        Set<String> same = new java.util.HashSet<>();
        for (Object o : given) {
            if (!(o instanceof Map<?, ?> r) || !(r.get("kind") instanceof String kind)) {
                throw RpcError.badRequest("reach.letThrough");
            }
            String ruleId = r.get("ruleId") instanceof String id && id.matches("mr-[a-z0-9-]{1,40}") ? id : null;
            if (r.get("ruleId") != null && ruleId == null) {
                throw RpcError.badRequest("reach.letThrough.ruleId");
            }
            Rule prior = ruleId == null ? null : before.stream().filter(x -> x.ruleId().equals(ruleId)).findFirst()
                    .orElse(null);
            String source = r.get("source") instanceof String s && Set.of("welcome", "settings", "correction",
                    "default").contains(s) ? s : prior != null ? prior.source() : "settings";
            Rule rule;
            switch (kind) {
                case "person" -> {
                    if (!(r.get("person") instanceof Map<?, ?> pm)) {
                        throw RpcError.badRequest("reach.letThrough.person");
                    }
                    Focus.Person person = Focus.person(pm);
                    String pending = null;
                    if (person == null) {
                        if (!(pm.get("pendingName") instanceof String n) || n.isBlank()
                                || n.strip().length() > NAME_MAX || TextChecks.hidden(n)) {
                            throw RpcError.badRequest("reach.letThrough.person");
                        }
                        pending = MaiaAgent.plain(n, NAME_MAX);
                    }
                    boolean anyTime = r.get("anyTime") instanceof Boolean b ? b : false;
                    rule = new Rule(ruleId == null ? newId.get() : ruleId, kind, person, pending, null, null, anyTime,
                            source, prior != null ? prior.createdAt() : now);
                }
                case "group" -> {
                    if (!(r.get("group") instanceof String g) || !GROUPS.contains(g)) {
                        throw RpcError.badRequest("reach.letThrough.group");
                    }
                    boolean anyTime = r.get("anyTime") instanceof Boolean b ? b : "family".equals(g);
                    rule = new Rule(ruleId == null ? newId.get() : ruleId, kind, null, null, g, null, anyTime, source,
                            prior != null ? prior.createdAt() : now);
                }
                case "match" -> {
                    if (!(r.get("match") instanceof String m) || !MATCHES.contains(m)) {
                        throw RpcError.badRequest("reach.letThrough.match");
                    }
                    boolean anyTime = r.get("anyTime") instanceof Boolean b ? b : false;
                    rule = new Rule(ruleId == null ? newId.get() : ruleId, kind, null, null, null, m, anyTime, source,
                            prior != null ? prior.createdAt() : now);
                }
                default -> throw RpcError.badRequest("reach.letThrough.kind");
            }
            if (!ids.add(rule.ruleId())) {
                throw RpcError.badRequest("reach.letThrough.ruleId");
            }
            String sameKey = rule.kind() + "|" + rule.person() + "|" + rule.pendingName() + "|" + rule.group() + "|"
                    + rule.match();
            if (!same.add(sameKey)) {
                continue;
            }
            out.add(rule);
        }
        return out;
    }

    static List<LocalTime> catchUps(Object raw) throws RpcError {
        if (!(raw instanceof List<?> l) || l.size() > 8) {
            throw RpcError.badRequest("reach.catchUps");
        }
        List<LocalTime> out = new ArrayList<>();
        for (Object o : l) {
            out.add(time(o, "reach.catchUps"));
        }
        out = out.stream().distinct().sorted().toList();
        for (int i = 1; i < out.size(); i++) {
            if (java.time.Duration.between(out.get(i - 1), out.get(i)).toMinutes() < 60) {
                throw RpcError.of("bad_request", "reason", "range", "detail", "reach.catchUps");
            }
        }
        return out;
    }

    static List<Span> spans(Object raw, int max, String field) throws RpcError {
        if (!(raw instanceof List<?> l) || l.size() > max) {
            throw RpcError.badRequest(field);
        }
        List<Span> out = new ArrayList<>();
        for (Object o : l) {
            out.add(span(o, field));
        }
        return out;
    }

    static Span span(Object raw, String field) throws RpcError {
        if (!(raw instanceof Map<?, ?> m)) {
            throw RpcError.badRequest(field);
        }
        LocalTime from = time(m.get("from"), field);
        LocalTime to = time(m.get("to"), field);
        long minutes = java.time.Duration.between(from, to).toMinutes();
        if (minutes < 0) {
            minutes += 24 * 60;
        }
        if (minutes < 30) {
            throw RpcError.of("bad_request", "reason", "range", "detail", field);
        }
        return new Span(from, to);
    }

    static LocalTime time(Object o, String field) throws RpcError {
        if (!(o instanceof String s) || !s.matches("([01]\\d|2[0-3]):[0-5]\\d")) {
            throw RpcError.badRequest(field);
        }
        return LocalTime.parse(s);
    }

    // ---------------------------------------------------------------- the stated task and the week's picks

    /** The member's stated task ({@code working_on}): their words, and the refs code picked. */
    public record Task(String label, List<Focus.Sphere> refs, long setAt) {}

    /** One "keep close this week" pick. */
    public record Pick(String pickId, Focus.Sphere ref, String label) {}

    // ---------------------------------------------------------------- the score

    /** What one score needs besides the item. */
    public record Context(long now, Focus.Now focus, Focus.Sphere sphere, Task task, List<Pick> week,
            Settings settings, Rhythm.Day day, Map<String, String> deskScope, Map<String, String> tags,
            ToIntFunction<Item> learned, ToIntFunction<Item> repeats, boolean budget, Set<String> exceptions,
            List<Focus.Person> people) {
        public Context(long now, Focus.Now focus, Focus.Sphere sphere, Task task, List<Pick> week,
                Settings settings, Rhythm.Day day, Map<String, String> deskScope, Map<String, String> tags,
                ToIntFunction<Item> learned, ToIntFunction<Item> repeats, boolean budget, Set<String> exceptions) {
            this(now, focus, sphere, task, week, settings, day, deskScope, tags, learned, repeats, budget,
                    exceptions, null);
        }

        public Context {
            people = people != null ? List.copyOf(people) : focus == null ? List.of() : focus.people();
            week = week == null ? List.of() : List.copyOf(week);
            deskScope = deskScope == null ? Map.of() : deskScope;
            tags = tags == null ? Map.of() : tags;
            exceptions = exceptions == null ? Set.of() : exceptions;
        }
    }

    /**
     * One item's score. {@code gate}: U = 1 (interrupt level). {@code rule}: the let-through rule id that matched,
     * {@code "code"} for a code-rule Now, {@code "stuck"} for the always-on desk-stuck entry, else null.
     * {@code seen}: the member is looking at it now (no event). {@code partitioned}: Work or Personal outside its
     * hours. {@code close}: the closeness match ({@code seen}, {@code sphere}, {@code person}, {@code task},
     * {@code week}, {@code desk_app}, {@code desk}, {@code scope}, {@code other}, {@code off_hours}).
     */
    public record Score(int distance, double c, double u, double i, double d, boolean gate, String rule,
            boolean anyTime, boolean seen, boolean partitioned, String close) {}

    public static Score score(Item item, Context ctx) {
        Rule listed = letThrough(item, ctx);
        boolean stuck = isStuck(item);
        String ruleId = item.codeNow() ? "code" : stuck ? "stuck" : listed != null ? listed.ruleId() : null;
        boolean gate = ruleId != null;
        boolean anyTime = item.codeNow() || stuck || (listed != null && listed.anyTime());

        // C: closeness, structural matches only; the first that holds wins.
        String close;
        double c;
        Focus.Now f = ctx.focus();
        String frontScope = f == null || f.deskId() == null ? null : ctx.deskScope().get(f.deskId());
        boolean offHours = offHours(item, ctx);
        if (seen(item, f)) {
            c = 1.0;
            close = "seen";
        } else if (ctx.sphere() != null && linked(item, ctx.sphere())) {
            c = 0.90;
            close = "sphere";
        } else if (withPeople(item, ctx.people())) {
            c = 0.80;
            close = "person";
        } else if (ctx.task() != null && ctx.task().refs().stream().anyMatch(r -> linked(item, r))) {
            c = 0.70;
            close = "task";
        } else if (ctx.week().stream().anyMatch(p -> linked(item, p.ref()))) {
            c = 0.70;
            close = "week";
        } else if (f != null && f.deskId() != null && f.deskId().equals(item.deskId())
                && appOf(f.app()).equals(item.refs().app())) {
            c = 0.55;
            close = "desk_app";
        } else if (f != null && f.deskId() != null && f.deskId().equals(item.deskId())) {
            c = 0.40;
            close = "desk";
        } else if (offHours) {
            c = 0;
            close = "off_hours";
        } else if (item.scope() == null || frontScope == null || frontScope.equals(item.scope())) {
            c = 0.25;
            close = "scope";
        } else {
            c = 0.10;
            close = "other";
        }

        // U: urgency by fixed rules. Agents' own scores never feed it.
        double u = gate ? 1.0 : switch (item.need()) {
            case "you" -> 0.6;
            case "action" -> 0.3;
            default -> 0;
        };

        // I: the sender's or topic's standing.
        double i;
        boolean picked = ctx.week().stream().anyMatch(p -> linked(item, p.ref()));
        if (listed != null && ("person".equals(listed.kind()) || "group".equals(listed.kind()))) {
            i = 1.0;
        } else if (picked || item.tags().contains("pinned") || item.sender().replyBand() >= 3) {
            i = 0.7;
        } else {
            i = switch (item.sender().standing()) {
                case "known_confirmed", "own" -> 0.5;
                case "known", "other_agent" -> 0.3;
                case "bulk", "platform" -> 0.1;
                default -> item.sender().confirmed() ? 0.5 : 0.3;
            };
            if (item.record()) {
                i = 0.1;
            }
        }

        double d = deadline(item.deadlineAt(), ctx.now());
        double reach = W_CLOSE * c + W_URGENT * u + W_IMPORTANT * i + W_DEADLINE * d;
        int distance = (int) Math.round(100 * (1 - reach));
        if (!gate) {
            distance += Math.max(-15, Math.min(15, ctx.learned().applyAsInt(item)));
        }
        distance += Math.min(30, 10 * Math.max(0, ctx.repeats().applyAsInt(item)));
        if (ctx.budget()) {
            distance += 10;
        }
        distance = Math.max(0, Math.min(100, distance));
        boolean partitioned = offHours && !gate;
        return new Score(distance, c, u, i, d, gate, ruleId, anyTime, c == 1.0, partitioned, close);
    }

    /** D: 1 within the hour, then {@code 1 − ln(h)/ln(72)}: 0.51 at 8 h, 0.26 at 24 h, 0 at 72 h. */
    static double deadline(Long at, long now) {
        if (at == null) {
            return 0;
        }
        double hours = (at - now) / (double) HOUR;
        if (hours <= 1) {
            return 1;
        }
        return Math.max(0, 1 - Math.log(hours) / Math.log(72));
    }

    /** "A desk or agent stuck" is always on and isn't one of the five (concept §9.1). */
    static boolean isStuck(Item item) {
        return "desk_failed".equals(item.kind()) || item.tags().contains("stuck");
    }

    /** The let-through rule this item matches, with the sender's identity checked, or null. */
    static Rule letThrough(Item item, Context ctx) {
        if (ctx.settings().holdAll()) {
            return null;
        }
        for (Rule r : ctx.settings().letThrough()) {
            if (ctx.exceptions().contains(r.ruleId() + "|" + item.kind())) {
                continue;
            }
            boolean match = switch (r.kind()) {
                // A person entry opens the gate only when the sender is confirmed (concept §9.3).
                case "person" -> r.person() != null && r.person().equals(item.sender().person())
                        && item.sender().confirmed();
                // A group never matches an unknown sender: unknown senders stay in Requests.
                case "group" -> item.sender().person() != null && item.sender().confirmed()
                        && groupHas(r.group(), ctx.tags().get(personKey(item.sender().person())));
                case "match" -> switch (r.match()) {
                    case "due_today" -> item.tags().contains("due_today");
                    case "money" -> item.tags().contains("money");
                    case "waiting_reply" -> "message".equals(item.kind()) && item.sender().direct()
                            && item.sender().person() != null && item.sender().confirmed()
                            && item.sender().standing().startsWith("known")
                            && item.sender().wroteLastAt() != null
                            && ctx.now() - item.sender().wroteLastAt() >= 24 * HOUR && ctx.day().workday();
                    default -> false;
                };
                default -> false;
            };
            if (match) {
                return r;
            }
        }
        return null;
    }

    static boolean groupHas(String group, String tag) {
        return tag != null && (group.equals(tag) || "boss_clients".equals(group) && ("boss".equals(tag)
                || "clients".equals(tag)));
    }

    static String personKey(Focus.Person p) {
        return p.deskId() + ":" + p.contactId();
    }

    /** Work or Personal outside its hours (concept §5.5): Personal in work hours, Work in the evening and weekends. */
    static boolean offHours(Item item, Context ctx) {
        return offHours(item, ctx.day(), ctx.settings());
    }

    static boolean offHours(Item item, Rhythm.Day day, Settings settings) {
        if (item.scope() == null) {
            return false;
        }
        if ("personal".equals(item.scope())) {
            return day.workHours();
        }
        if ("work".equals(item.scope())) {
            return (day.weekend() || day.evening() || day.quiet() || day.holdWork())
                    && ("hold".equals(settings.evenings()) || day.holdWork());
        }
        return false;
    }

    /** The member is looking at this item now: the app already shows it, so the shield stays out of the way. */
    static boolean seen(Item item, Focus.Now f) {
        if (f == null || f.deskId() == null || !f.deskId().equals(item.deskId()) || f.item() == null
                || !"desk".equals(f.surface()) && !"room".equals(f.surface())) {
            return false;
        }
        Refs r = item.refs();
        String id = f.item().id();
        return switch (f.item().kind()) {
            case "thread", "channel" -> id.equals(r.channelId());
            case "todo" -> id.equals(r.todoId());
            case "page" -> id.equals(r.docId()) || id.equals(r.itemId());
            case "run" -> id.equals(r.itemId());
            default -> false;
        };
    }

    /** Same thread or channel, to-do, document or item as that place. */
    static boolean linked(Item item, Focus.Sphere s) {
        if (s == null || s.item() == null || s.deskId() == null || !s.deskId().equals(item.deskId())) {
            return false;
        }
        Refs r = item.refs();
        String id = s.item().id();
        return id.equals(r.channelId()) || id.equals(r.todoId()) || id.equals(r.docId()) || id.equals(r.itemId());
    }

    static boolean withPeople(Item item, List<Focus.Person> people) {
        if (people.isEmpty()) {
            return false;
        }
        if (item.sender().person() != null && people.contains(item.sender().person())) {
            return true;
        }
        for (Focus.Person p : item.refs().people()) {
            if (people.contains(p)) {
                return true;
            }
        }
        return false;
    }

    /** The app an item lives in, as the focus block names apps ({@code agent:<id>} is the Agent app). */
    static String appOf(String app) {
        if (app == null) {
            return "";
        }
        return app.startsWith("agent:") ? "agent" : app;
    }

    // ---------------------------------------------------------------- words

    /**
     * "Why now", under 10 words, from the score's reasons, in code's words. {@code {who}} is the browser's slot: it
     * fills the sender's name from that desk's Courier when it draws the card (the desk holds no names).
     */
    public static String why(Item item, Score s, Context ctx) {
        if ("code".equals(s.rule()) || "stuck".equals(s.rule())) {
            return dueWords(item, ctx);
        }
        if (s.rule() != null) {
            Rule r = ctx.settings().letThrough().stream().filter(x -> x.ruleId().equals(s.rule())).findFirst()
                    .orElse(null);
            if (r != null) {
                return ruleLine(r);
            }
        }
        return switch (s.close()) {
            case "sphere" -> "message".equals(item.kind()) ? "From the thread you’re in" : "Goes with what you’re on";
            case "person" -> "From {who}, who you’re working with";
            case "task" -> ctx.task() == null ? "For what you’re working on" : "For " + ctx.task().label();
            case "week" -> ctx.week().stream().filter(p -> linked(item, p.ref())).findFirst()
                    .map(p -> "Part of this week’s " + p.label()).orElse("Part of this week’s work");
            default -> {
                String due = item.deadlineAt() != null ? dueWords(item, ctx) : null;
                if (due != null) {
                    yield due;
                }
                if ("message".equals(item.kind()) && item.sender().wroteLastAt() != null) {
                    yield "Waiting on your reply since " + Rhythm.dayWords(item.sender().wroteLastAt(), ctx.now(),
                            ctx.day().zone());
                }
                if ("desk_app".equals(s.close()) || "desk".equals(s.close())) {
                    yield item.deskName() == null ? "Here on this desk" : "Here on " + item.deskName();
                }
                if (item.tags().contains("changed")) {
                    yield "Changed since you looked";
                }
                yield "you".equals(item.need()) ? "Waiting on you" : "When you have a moment";
            }
        };
    }

    /** The rule behind a let-through, in the member's words (the card's "Why?" and the first let-through line). */
    public static String ruleLine(Rule r) {
        return switch (r.kind()) {
            case "person" -> r.person() != null ? "{who} is on your list" : MaiaAgent.plain(r.pendingName(), NAME_MAX)
                    + " is on your list";
            case "group" -> switch (r.group()) {
                case "family" -> "Family is on your list";
                case "boss" -> "Your boss is on your list";
                case "clients" -> "Your clients are on your list";
                case "boss_clients" -> "Your boss and clients are on your list";
                default -> "Your team is on your list";
            };
            default -> switch (r.match()) {
                case "due_today" -> "You asked to hear about things due today";
                case "money" -> "You asked to hear about money right away";
                default -> "You asked to hear when someone’s waiting";
            };
        };
    }

    /** "Expires in 40 min", "Due at 3:00", "Due today", or the kind's own line. */
    static String dueWords(Item item, Context ctx) {
        Long at = item.deadlineAt();
        if (at != null) {
            long left = at - ctx.now();
            if (item.expires() && left > 0 && left < 6 * HOUR) {
                return "Expires in " + Attention.duration(left);
            }
            if (left <= 0) {
                return "Overdue";
            }
            if (left < 12 * HOUR) {
                return "Due at " + Rhythm.clock(at, ctx.day().zone());
            }
            return "Due " + Rhythm.dayWords(at, ctx.now(), ctx.day().zone());
        }
        return switch (item.kind()) {
            case "limit" -> "A task stopped at a limit";
            case "desk_failed" -> "This desk needs a look";
            case "cap" -> "About Maia’s allowance";
            case "result" -> "An agent is stuck";
            default -> "Needs you now";
        };
    }

    static boolean same(Object a, Object b) {
        return Objects.equals(a, b);
    }
}
