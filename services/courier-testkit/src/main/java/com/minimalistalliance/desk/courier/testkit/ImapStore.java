package com.minimalistalliance.desk.courier.testkit;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;

/**
 * {@link FakeImapServer}'s mailboxes: accounts, folders, messages, MODSEQs and tombstones, and who to tell of a change.
 * Everything here is guarded by {@link #lock}; every method expects it held.
 *
 * <p>A message's content, flags and Gmail labels are its {@link Core}; a folder holds {@link Entry}s, each a UID and a
 * MODSEQ for a core. Outside Gmail mode a core is in exactly one folder. In Gmail mode a core is in exactly one of All
 * Mail, Spam and Trash (its location), and in every label folder whose label it has while it's in All Mail; which folders
 * show it is worked out again after every change ({@link #place}).
 */
final class ImapStore {

    /** What a folder is. Outside Gmail mode every selectable folder is {@code PLAIN}. */
    enum Kind { PLAIN, NOSELECT, ALL_MAIL, SPAM, TRASH, VIEW }

    /** A session with a folder selected: told of each change to it, under the lock. */
    interface Listener {
        void exists(long uid);

        void changed(long uid);

        void expunged(long uid);

        /** The folder's UIDVALIDITY changed, or it was deleted: the session must go. */
        void reset();
    }

    static final List<String> SYSTEM_FLAGS = List.of("\\Answered", "\\Flagged", "\\Deleted", "\\Seen", "\\Draft");

    static final String INBOX = "INBOX";
    static final String GMAIL = "[Gmail]";
    static final String ALL_MAIL = "[Gmail]/All Mail";
    static final String SPAM = "[Gmail]/Spam";
    static final String TRASH = "[Gmail]/Trash";

    static final List<String> SYSTEM_LABELS = List.of("\\Inbox", "\\Sent", "\\Draft", "\\Important", "\\Starred");

    private static final AtomicLong UIDVALIDITY = new AtomicLong(System.currentTimeMillis() / 1000 % 2_000_000_000L + 1);

    final ReentrantLock lock = new ReentrantLock();
    final boolean gmail;
    private final List<FakeImapServer.FolderSpec> defaultFolders;
    private final Map<String, Account> accounts = new HashMap<>();
    private long nextGmMsgId = 1_790_000_000_000_000_001L;

    ImapStore(boolean gmail, List<FakeImapServer.FolderSpec> defaultFolders) {
        this.gmail = gmail;
        this.defaultFolders = List.copyOf(defaultFolders);
    }

    /** One user. */
    static final class Account {
        final String login;
        String password;
        final TreeMap<String, Mailbox> folders = new TreeMap<>(ImapStore::compareNames);
        final List<FakeImapServer.Appended> appended = new ArrayList<>();
        final Set<Object> sessions = new HashSet<>();

        Account(String login, String password) {
            this.login = login;
            this.password = password;
        }
    }

    /** One folder. Entries are in UID order. */
    static final class Mailbox {
        final Account account;
        final String name;
        Kind kind;
        final String label;
        final Set<String> specialUse = new LinkedHashSet<>();
        long uidValidity = UIDVALIDITY.incrementAndGet();
        long uidNext = 1;
        long highestModSeq = 1;
        final ArrayList<Entry> entries = new ArrayList<>();
        final TreeMap<Long, Long> tombstones = new TreeMap<>();
        final Set<Listener> selectedBy = new LinkedHashSet<>();

        Mailbox(Account account, String name, Kind kind, String label) {
            this.account = account;
            this.name = name;
            this.kind = kind;
            this.label = label;
        }

        boolean noselect() {
            return kind == Kind.NOSELECT;
        }

        int indexOf(long uid) {
            int lo = 0;
            int hi = entries.size() - 1;
            while (lo <= hi) {
                int mid = (lo + hi) >>> 1;
                long u = entries.get(mid).uid;
                if (u < uid) {
                    lo = mid + 1;
                } else if (u > uid) {
                    hi = mid - 1;
                } else {
                    return mid;
                }
            }
            return -1;
        }

        Entry get(long uid) {
            int i = indexOf(uid);
            return i < 0 ? null : entries.get(i);
        }

        Entry add(Core core) {
            Entry e = new Entry(uidNext++, ++highestModSeq, core);
            entries.add(e);
            for (Listener l : selectedBy) {
                l.exists(e.uid);
            }
            return e;
        }

        void remove(Entry e) {
            int i = indexOf(e.uid);
            if (i < 0) {
                return;
            }
            entries.remove(i);
            tombstones.put(e.uid, ++highestModSeq);
            for (Listener l : selectedBy) {
                l.expunged(e.uid);
            }
        }

        void touch(Entry e, Listener origin) {
            e.modSeq = ++highestModSeq;
            for (Listener l : selectedBy) {
                if (l != origin) {
                    l.changed(e.uid);
                }
            }
        }

        long unseen() {
            long n = 0;
            for (Entry e : entries) {
                if (!e.core.flags.contains("\\Seen")) {
                    n++;
                }
            }
            return n;
        }
    }

    /** A message as one folder shows it. */
    static final class Entry {
        long uid;
        long modSeq;
        final Core core;

        Entry(long uid, long modSeq, Core core) {
            this.uid = uid;
            this.modSeq = modSeq;
            this.core = core;
        }
    }

    /** A message: its bytes (or where to get them), date, flags and, in Gmail mode, labels, ids and location. */
    static final class Core {
        final byte[] raw;
        final Supplier<byte[]> source;
        final long size;
        final OffsetDateTime internalDate;
        Set<String> flags = Set.of();
        Set<String> labels = Set.of();
        final long gmMsgId;
        long gmThrId;
        Kind location;
        Map<Mailbox, Entry> placed;

        Core(byte[] raw, Supplier<byte[]> source, long size, OffsetDateTime internalDate, long gmMsgId) {
            this.raw = raw;
            this.source = source;
            this.size = size;
            this.internalDate = internalDate;
            this.gmMsgId = gmMsgId;
            this.gmThrId = gmMsgId;
        }

        byte[] bytes() {
            if (raw != null) {
                return raw;
            }
            byte[] b = source.get();
            if (b == null || b.length != size) {
                throw new IllegalStateException("a lazy message's source gave " + (b == null ? "null" : b.length + " bytes") + " where its size is " + size);
            }
            return b;
        }

        Supplier<byte[]> supplier() {
            return raw != null ? () -> raw : source;
        }
    }

    // ---- accounts and folders ----

    Account account(String login) {
        return accounts.get(login);
    }

    Account requireAccount(String login) {
        Account a = accounts.get(login);
        if (a == null) {
            throw new IllegalArgumentException("no user " + login);
        }
        return a;
    }

    Account addUser(String login, String password) {
        Account a = accounts.get(login);
        if (a != null) {
            a.password = password;
            return a;
        }
        a = new Account(login, password);
        accounts.put(login, a);
        if (gmail) {
            create(a, INBOX, Set.of());
            create(a, GMAIL, Set.of("\\Noselect"));
            create(a, ALL_MAIL, Set.of("\\All"));
            create(a, "[Gmail]/Drafts", Set.of("\\Drafts"));
            create(a, "[Gmail]/Important", Set.of("\\Important"));
            create(a, "[Gmail]/Sent Mail", Set.of("\\Sent"));
            create(a, SPAM, Set.of("\\Junk"));
            create(a, "[Gmail]/Starred", Set.of("\\Flagged"));
            create(a, TRASH, Set.of("\\Trash"));
        } else {
            create(a, INBOX, Set.of());
            for (FakeImapServer.FolderSpec f : defaultFolders) {
                create(a, f.name(), f.attributes());
            }
        }
        return a;
    }

    static String canonical(String name) {
        if (name.equalsIgnoreCase(INBOX)) {
            return INBOX;
        }
        if (name.length() > 6 && name.substring(0, 6).equalsIgnoreCase("INBOX/")) {
            return INBOX + name.substring(5);
        }
        return name;
    }

    static int compareNames(String a, String b) {
        boolean ia = a.equals(INBOX);
        boolean ib = b.equals(INBOX);
        if (ia || ib) {
            return ia && ib ? 0 : ia ? -1 : 1;
        }
        return a.compareTo(b);
    }

    Mailbox mailbox(Account a, String name) {
        return a.folders.get(canonical(name));
    }

    Mailbox requireMailbox(Account a, String name) {
        Mailbox m = mailbox(a, name);
        if (m == null || m.noselect()) {
            throw new IllegalArgumentException("no folder " + name + " for " + a.login);
        }
        return m;
    }

    /**
     * Makes a folder, and any parent it lacks as {@code \Noselect}. {@code attributes} may hold {@code \Noselect} and
     * special-use attributes. A {@code \Noselect} placeholder already there becomes selectable. Returns it.
     */
    Mailbox create(Account a, String name, Collection<String> attributes) {
        name = canonical(name);
        if (name.isEmpty() || name.startsWith("/") || name.endsWith("/") || name.contains("//")) {
            throw new IllegalArgumentException("bad folder name: " + name);
        }
        int slash = name.lastIndexOf('/');
        if (slash > 0 && !a.folders.containsKey(name.substring(0, slash))) {
            create(a, name.substring(0, slash), Set.of("\\Noselect"));
        }
        boolean noselect = attributes.stream().anyMatch(s -> s.equalsIgnoreCase("\\Noselect"));
        Kind kind = noselect ? Kind.NOSELECT : kindFor(name);
        Mailbox existing = a.folders.get(name);
        if (existing != null) {
            if (existing.noselect() && !noselect) {
                existing.kind = kind;
            }
            addSpecialUse(existing, attributes);
            return existing;
        }
        Mailbox m = new Mailbox(a, name, kind, kind == Kind.VIEW ? labelFor(name) : null);
        addSpecialUse(m, attributes);
        a.folders.put(name, m);
        return m;
    }

    private static void addSpecialUse(Mailbox m, Collection<String> attributes) {
        for (String s : attributes) {
            if (!s.equalsIgnoreCase("\\Noselect")) {
                m.specialUse.add(s);
            }
        }
    }

    private Kind kindFor(String name) {
        if (!gmail) {
            return Kind.PLAIN;
        }
        return switch (name) {
            case ALL_MAIL -> Kind.ALL_MAIL;
            case SPAM -> Kind.SPAM;
            case TRASH -> Kind.TRASH;
            default -> Kind.VIEW;
        };
    }

    /** A Gmail label folder's label. */
    static String labelFor(String folder) {
        return switch (folder) {
            case INBOX -> "\\Inbox";
            case "[Gmail]/Sent Mail" -> "\\Sent";
            case "[Gmail]/Drafts" -> "\\Draft";
            case "[Gmail]/Important" -> "\\Important";
            case "[Gmail]/Starred" -> "\\Starred";
            default -> folder;
        };
    }

    /** Removes a folder (or, with folders under it, empties it and makes it {@code \Noselect}). Gmail: drops its label. */
    void delete(Mailbox m) {
        Account a = m.account;
        if (gmail && m.kind == Kind.VIEW) {
            for (Entry e : List.copyOf(m.entries)) {
                Set<String> labels = new LinkedHashSet<>(e.core.labels);
                labels.remove(m.label);
                gmailApply(a, e.core, e.core.flags, labels, e.core.location, null);
            }
        } else {
            for (Entry e : List.copyOf(m.entries)) {
                if (gmail) {
                    gmailApply(a, e.core, e.core.flags, e.core.labels, null, null);
                } else {
                    m.remove(e);
                }
            }
        }
        for (Listener l : List.copyOf(m.selectedBy)) {
            l.reset();
        }
        m.selectedBy.clear();
        String prefix = m.name + "/";
        boolean children = a.folders.keySet().stream().anyMatch(n -> n.startsWith(prefix));
        if (children) {
            m.kind = Kind.NOSELECT;
        } else {
            a.folders.remove(m.name);
        }
    }

    // ---- messages ----

    /** Flags as kept and served: system flags first in RFC 3501's order, then keywords as given; no duplicates or \\Recent. */
    static Set<String> flags(Collection<String> in) {
        if (in == null || in.isEmpty()) {
            return Set.of();
        }
        LinkedHashSet<String> out = new LinkedHashSet<>();
        List<String> canonical = new ArrayList<>();
        for (String f : in) {
            canonical.add(canonicalFlag(f));
        }
        for (String s : SYSTEM_FLAGS) {
            if (canonical.contains(s)) {
                out.add(s);
            }
        }
        for (String c : canonical) {
            if (c.startsWith("\\") && (SYSTEM_FLAGS.contains(c) || c.equals("\\Recent"))) {
                continue;
            }
            boolean dup = false;
            for (String have : out) {
                if (have.equalsIgnoreCase(c)) {
                    dup = true;
                    break;
                }
            }
            if (!dup) {
                out.add(c);
            }
        }
        return out.isEmpty() ? Set.of() : Collections.unmodifiableSet(out);
    }

    static String canonicalFlag(String f) {
        if (f.startsWith("\\")) {
            for (String s : SYSTEM_FLAGS) {
                if (s.equalsIgnoreCase(f)) {
                    return s;
                }
            }
            if (f.equalsIgnoreCase("\\Recent")) {
                return "\\Recent";
            }
        }
        return f;
    }

    static Set<String> labels(Collection<String> in) {
        if (in == null || in.isEmpty()) {
            return Set.of();
        }
        LinkedHashSet<String> out = new LinkedHashSet<>();
        for (String l : in) {
            String c = l;
            for (String s : SYSTEM_LABELS) {
                if (s.equalsIgnoreCase(l)) {
                    c = s;
                }
            }
            out.add(c);
        }
        return Collections.unmodifiableSet(out);
    }

    static boolean hasFlag(Set<String> flags, String flag) {
        for (String f : flags) {
            if (f.equalsIgnoreCase(flag)) {
                return true;
            }
        }
        return false;
    }

    /**
     * A new message in {@code m}. Returns its entry in {@code m}. In Gmail mode, a label folder adds its label and puts
     * the message in All Mail; All Mail, Spam and Trash set where it is; {@code labels} are added.
     */
    Entry append(Mailbox m, byte[] raw, Supplier<byte[]> source, long size, Instant date, Collection<String> flags, Collection<String> labels) {
        if (m.noselect()) {
            throw new IllegalArgumentException("folder " + m.name + " is \\Noselect");
        }
        OffsetDateTime when = (date == null ? Instant.now() : date).atOffset(java.time.ZoneOffset.UTC).withNano(0);
        return append(m, raw, source, size, when, flags, labels);
    }

    Entry append(Mailbox m, byte[] raw, Supplier<byte[]> source, long size, OffsetDateTime when, Collection<String> flags, Collection<String> labels) {
        Core c = new Core(raw, source, size, when.withNano(0), gmail ? nextGmMsgId++ : 0);
        Set<String> f = flags(flags);
        if (!gmail) {
            c.flags = f;
            return m.add(c);
        }
        c.placed = new LinkedHashMap<>(4);
        Set<String> l = new LinkedHashSet<>(labels(labels));
        Kind location = Kind.ALL_MAIL;
        switch (m.kind) {
            case ALL_MAIL, SPAM, TRASH -> location = m.kind;
            case VIEW -> l.add(m.label);
            default -> throw new IllegalArgumentException("folder " + m.name + " can't hold messages");
        }
        if (hasFlag(f, "\\Flagged")) {
            l.add("\\Starred");
        } else if (l.contains("\\Starred")) {
            Set<String> withFlag = new LinkedHashSet<>(f);
            withFlag.add("\\Flagged");
            f = flags(withFlag);
        }
        gmailApply(m.account, c, f, l, location, null);
        return c.placed.get(m);
    }

    /** Sets a message's flags; the change bumps the MODSEQ of every entry that shows it. Returns whether anything changed. */
    boolean setFlags(Mailbox m, Entry e, Collection<String> flags, Listener origin) {
        Set<String> f = flags(flags);
        if (f.equals(e.core.flags)) {
            return false;
        }
        if (gmail) {
            Set<String> labels = new LinkedHashSet<>(e.core.labels);
            if (hasFlag(f, "\\Flagged")) {
                labels.add("\\Starred");
            } else {
                labels.remove("\\Starred");
            }
            gmailApply(m.account, e.core, f, labels, e.core.location, origin);
        } else {
            e.core.flags = f;
            m.touch(e, origin);
        }
        return true;
    }

    /** Gmail mode: sets a message's labels. Returns whether anything changed. */
    boolean setLabels(Mailbox m, Entry e, Collection<String> labels, Listener origin) {
        Set<String> l = labels(labels);
        if (l.equals(e.core.labels)) {
            return false;
        }
        Set<String> f = new LinkedHashSet<>(e.core.flags);
        if (l.contains("\\Starred")) {
            f.add("\\Flagged");
        } else {
            f.removeIf(s -> s.equals("\\Flagged"));
        }
        gmailApply(m.account, e.core, flags(f), l, e.core.location, origin);
        return true;
    }

    /**
     * Gmail mode's one way to change a message: set its flags, labels and location, make any user label's folder, then
     * add it to and take it out of folders as their rules now say, and bump the MODSEQ where it stays and its flags or
     * labels changed. A null location deletes it for good.
     */
    private void gmailApply(Account a, Core c, Set<String> flags, Set<String> labels, Kind location, Listener origin) {
        Map<Mailbox, Entry> before = new LinkedHashMap<>(c.placed);
        boolean meta = !flags.equals(c.flags) || !labels.equals(c.labels);
        c.flags = flags.isEmpty() ? Set.of() : Collections.unmodifiableSet(new LinkedHashSet<>(flags));
        c.labels = labels.isEmpty() ? Set.of() : Collections.unmodifiableSet(new LinkedHashSet<>(labels));
        c.location = location;
        for (String l : c.labels) {
            if (!SYSTEM_LABELS.contains(l) && !a.folders.containsKey(canonical(l))) {
                create(a, l, Set.of());
            }
        }
        place(a, c);
        if (meta) {
            for (Map.Entry<Mailbox, Entry> b : before.entrySet()) {
                if (c.placed.get(b.getKey()) == b.getValue()) {
                    b.getKey().touch(b.getValue(), origin);
                }
            }
        }
    }

    /** Gmail mode: adds the message to each folder that should show it and doesn't, and the reverse. */
    private void place(Account a, Core c) {
        for (Mailbox f : a.folders.values()) {
            if (f.kind == Kind.NOSELECT || f.kind == Kind.PLAIN) {
                continue;
            }
            boolean should = belongs(f, c);
            Entry e = c.placed.get(f);
            if (should && e == null) {
                c.placed.put(f, f.add(c));
            } else if (!should && e != null) {
                f.remove(e);
                c.placed.remove(f);
            }
        }
    }

    private static boolean belongs(Mailbox f, Core c) {
        if (c.location == null) {
            return false;
        }
        return switch (f.kind) {
            case ALL_MAIL, SPAM, TRASH -> c.location == f.kind;
            case VIEW -> c.location == Kind.ALL_MAIL && c.labels.contains(f.label);
            default -> false;
        };
    }

    /**
     * IMAP's EXPUNGE (and CLOSE) of every {@code \Deleted} message in {@code m}, or only those in {@code only}. In Gmail
     * mode: from a label folder the label goes; from All Mail or Spam the message goes to Trash; from Trash it's deleted.
     */
    void expungeDeleted(Mailbox m, Set<Long> only, Listener origin) {
        for (Entry e : List.copyOf(m.entries)) {
            if (!hasFlag(e.core.flags, "\\Deleted") || (only != null && !only.contains(e.uid))) {
                continue;
            }
            if (!gmail) {
                m.remove(e);
                continue;
            }
            Core c = e.core;
            Set<String> f = new LinkedHashSet<>(c.flags);
            f.remove("\\Deleted");
            switch (m.kind) {
                case VIEW -> {
                    Set<String> l = new LinkedHashSet<>(c.labels);
                    l.remove(m.label);
                    gmailApply(m.account, c, f, l, c.location, origin);
                }
                case ALL_MAIL, SPAM -> gmailApply(m.account, c, f, c.labels, Kind.TRASH, origin);
                default -> gmailApply(m.account, c, c.flags, c.labels, null, origin);
            }
        }
    }

    /** The test API's expunge: gone from {@code m} (Gmail: from All Mail, Spam or Trash, gone for good; from a label folder, the label goes). */
    void expunge(Mailbox m, Entry e) {
        if (!gmail) {
            m.remove(e);
        } else if (m.kind == Kind.VIEW) {
            Set<String> l = new LinkedHashSet<>(e.core.labels);
            l.remove(m.label);
            gmailApply(m.account, e.core, e.core.flags, l, e.core.location, null);
        } else {
            gmailApply(m.account, e.core, e.core.flags, e.core.labels, null, null);
        }
    }

    /** COPY: pairs of (source UID, target UID), in the order given. */
    List<long[]> copy(Mailbox src, List<Entry> entries, Mailbox dst, Listener origin) {
        List<long[]> pairs = new ArrayList<>();
        for (Entry e : entries) {
            long srcUid = e.uid;
            Entry d;
            if (!gmail) {
                Core c = new Core(e.core.raw, e.core.source, e.core.size, e.core.internalDate, 0);
                c.flags = e.core.flags;
                d = dst.add(c);
            } else {
                d = gmailTo(src, e, dst, false, origin);
            }
            if (d != null) {
                pairs.add(new long[] {srcUid, d.uid});
            }
        }
        return pairs;
    }

    /** MOVE: COPY, then the sources go. In Gmail mode, labels and location change instead (X-GM-MSGID kept). */
    List<long[]> move(Mailbox src, List<Entry> entries, Mailbox dst, Listener origin) {
        if (!gmail) {
            List<long[]> pairs = copy(src, entries, dst, origin);
            for (Entry e : entries) {
                src.remove(e);
            }
            return pairs;
        }
        List<long[]> pairs = new ArrayList<>();
        for (Entry e : entries) {
            long srcUid = e.uid;
            Entry d = gmailTo(src, e, dst, true, origin);
            if (d != null) {
                pairs.add(new long[] {srcUid, d.uid});
            }
        }
        return pairs;
    }

    private Entry gmailTo(Mailbox src, Entry e, Mailbox dst, boolean move, Listener origin) {
        Core c = e.core;
        Set<String> labels = new LinkedHashSet<>(c.labels);
        Set<String> flags = new LinkedHashSet<>(c.flags);
        Kind location = c.location;
        switch (dst.kind) {
            case ALL_MAIL, SPAM, TRASH -> location = dst.kind;
            case VIEW -> {
                location = Kind.ALL_MAIL;
                labels.add(dst.label);
                if (dst.label.equals("\\Starred")) {
                    flags.add("\\Flagged");
                }
            }
            default -> throw new IllegalArgumentException("folder " + dst.name + " can't hold messages");
        }
        if (move && src.kind == Kind.VIEW && src != dst) {
            labels.remove(src.label);
            if (src.label.equals("\\Starred")) {
                flags.remove("\\Flagged");
            }
        }
        gmailApply(src.account, c, flags(flags), labels, location, origin);
        return c.placed.get(dst);
    }

    /** New UIDVALIDITY, every message renumbered from 1 in order; sessions with it selected are told to go. */
    long resetUidValidity(Mailbox m) {
        m.uidValidity = UIDVALIDITY.incrementAndGet();
        long uid = 1;
        for (Entry e : m.entries) {
            e.uid = uid++;
        }
        m.uidNext = uid;
        m.tombstones.clear();
        for (Listener l : List.copyOf(m.selectedBy)) {
            l.reset();
        }
        m.selectedBy.clear();
        return m.uidValidity;
    }

    // ---- snapshots ----

    FakeImapServer.Message snapshot(Entry e) {
        Core c = e.core;
        return new FakeImapServer.Message(e.uid, c.flags, c.labels, c.gmMsgId, c.gmThrId, e.modSeq, c.size, c.internalDate.toInstant(), c.supplier());
    }

    FakeImapServer.Folder snapshot(Mailbox m) {
        Set<String> attrs = new LinkedHashSet<>();
        if (m.noselect()) {
            attrs.add("\\Noselect");
        }
        attrs.addAll(m.specialUse);
        return new FakeImapServer.Folder(m.name, Collections.unmodifiableSet(attrs), m.uidValidity, m.uidNext, m.highestModSeq, m.entries.size());
    }

}
