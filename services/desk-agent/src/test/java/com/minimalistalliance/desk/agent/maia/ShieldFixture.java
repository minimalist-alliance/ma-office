package com.minimalistalliance.desk.agent.maia;

import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Builders for the focus shield's tests and evals: items, focus blocks and times on a fixed week. */
public final class ShieldFixture {

    public static final ZoneId ZONE = ZoneId.of("America/Denver");
    /** Monday 16 November 2026. */
    public static final LocalDate MONDAY = LocalDate.of(2026, 11, 16);
    public static final String WORK = "d-work";
    public static final String HOME = "d-personal";
    public static final long MIN = 60_000L;

    private ShieldFixture() {}

    public static long at(LocalDate day, int h, int m) {
        return day.atTime(LocalTime.of(h, m)).atZone(ZONE).toInstant().toEpochMilli();
    }

    public static long at(int h, int m) {
        return at(MONDAY, h, m);
    }

    /** A Courier contact id (a 26-character ULID) from a short name. */
    public static String contact(String name) {
        String alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
        StringBuilder b = new StringBuilder("01J");
        int h = name.hashCode();
        for (int i = 0; b.length() < 26; i++) {
            h = h * 31 + i + 7;
            b.append(alphabet.charAt(Math.floorMod(h, 32)));
        }
        return b.toString();
    }

    public static Focus.Person person(String desk, String name) {
        return new Focus.Person(desk, contact(name));
    }

    /** A focus block as the office sends it. */
    public static Map<String, Object> focus(String desk, String app, String itemKind, String itemId, boolean typing,
            String... people) {
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("surface", "desk");
        f.put("deskId", desk);
        f.put("scope", "all");
        f.put("app", app);
        if (itemKind != null) {
            f.put("item", Map.of("kind", itemKind, "id", itemId));
        }
        List<Map<String, Object>> ps = new ArrayList<>();
        for (String p : people) {
            ps.add(Map.of("deskId", desk, "contactId", contact(p)));
        }
        f.put("people", ps);
        Map<String, Object> in = new LinkedHashMap<>();
        in.put("typing", typing);
        in.put("idle", false);
        f.put("input", in);
        f.put("call", false);
        f.put("share", false);
        f.put("visible", true);
        f.put("device", "dv-office0001");
        return f;
    }

    public static Map<String, Object> with(Map<String, Object> f, String key, Object value) {
        Map<String, Object> m = new LinkedHashMap<>(f);
        m.put(key, value);
        return m;
    }

    public static Map<String, Object> event(Map<String, Object> f, String kind, long at) {
        return with(f, "events", List.of(Map.of("kind", kind, "at", at)));
    }

    public static Map<String, Object> idle(Map<String, Object> f, boolean idle) {
        Map<String, Object> in = new LinkedHashMap<>(cast(f.get("input")));
        in.put("idle", idle);
        in.put("typing", false);
        return with(f, "input", in);
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> cast(Object o) {
        return (Map<String, Object>) o;
    }

    /** An item builder: the shield's item with the fields a test names, the rest plain. */
    public static final class B {
        String key;
        String kind = "result";
        String desk = WORK;
        String deskName = "Work";
        String scope = "work";
        boolean codeNow;
        String app = "maia";
        String channel;
        String todo;
        String doc;
        String agent;
        List<Focus.Person> people = List.of();
        Focus.Person sender;
        String standing = "own";
        boolean confirmed = true;
        int replyBand;
        Long wroteLast;
        boolean direct;
        Long deadline;
        boolean expires;
        String need = "action";
        Set<String> tags = Set.of();
        int count = 1;
        long at;
        boolean dismissable = true;
        String title = "Something on Work";

        public static B of(String key, String kind) {
            B b = new B();
            b.key = key;
            b.kind = kind;
            return b;
        }

        public B desk(String d, String name, String sc) {
            desk = d;
            deskName = name;
            scope = sc;
            return this;
        }

        public B now() {
            codeNow = true;
            need = "you";
            dismissable = Attention.dismissable(kind);
            return this;
        }

        public B app(String a) {
            app = a;
            return this;
        }

        public B channel(String c) {
            channel = c;
            app = "courier";
            return this;
        }

        public B todo(String t) {
            todo = t;
            return this;
        }

        public B doc(String d) {
            doc = d;
            return this;
        }

        public B from(Focus.Person p, String st, boolean conf) {
            sender = p;
            standing = st;
            confirmed = conf;
            return this;
        }

        public B band(int b) {
            replyBand = b;
            return this;
        }

        public B direct(Long wrote) {
            direct = true;
            wroteLast = wrote;
            return this;
        }

        public B deadline(long d, boolean exp) {
            deadline = d;
            expires = exp;
            return this;
        }

        public B need(String n) {
            need = n;
            return this;
        }

        public B tags(String... t) {
            tags = Set.of(t);
            return this;
        }

        public B count(int n) {
            count = n;
            return this;
        }

        public B title(String t) {
            title = t;
            return this;
        }

        public B at(long t) {
            at = t;
            return this;
        }

        public Reach.Item build() {
            Map<String, Object> go = new LinkedHashMap<>();
            go.put("kind", "show");
            go.put("deskId", desk);
            go.put("app", app == null ? "agent" : app);
            go.put("ref", "");
            return new Reach.Item(key, kind, desk, deskName, scope, codeNow, new Reach.Refs(app, channel, todo, doc,
                    agent, null, people), new Reach.Sender(sender, standing, confirmed, replyBand, wroteLast, direct),
                    deadline, expires, need, tags, count, at, dismissable && Attention.dismissable(kind), title,
                    deskName + " · Scout", go, null);
        }
    }

    /** The shield with defaults, a memory store, the fixed zone. */
    public static Shield shield(Reach.Settings s) {
        return new Shield(new Shield.Memory(s), () -> ZONE);
    }

    public static Map<String, String> scopes() {
        return Map.of(WORK, "work", HOME, "personal");
    }

    public static Map<String, String> names() {
        return Map.of(WORK, "Work", HOME, "Personal");
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> card(Shield.Output o) {
        return (Map<String, Object>) o.view().get("card");
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> line(Shield.Output o) {
        return (Map<String, Object>) o.view().get("line");
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> catchup(Shield.Output o) {
        return (Map<String, Object>) o.view().get("catchup");
    }
}
