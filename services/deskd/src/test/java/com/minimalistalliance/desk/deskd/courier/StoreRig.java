package com.minimalistalliance.desk.deskd.courier;

import com.minimalistalliance.desk.deskd.courier.parse.CourierParser;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * A store in a temporary directory with a clock the test moves, and three accounts: this desk's address
 * ({@code me@desk.example}), a linked Gmail ({@code me@gmail.example}) and the member address for {@code ma}.
 */
final class StoreRig implements AutoCloseable {

    static final String DESK = "desk";
    static final String GMAIL = "gmail";
    static final String MA = "ma";
    static final String IMSG = "imsg";

    final Path dir;
    final MutableClock clock = new MutableClock(Instant.parse("2026-11-12T12:00:00Z"));
    CourierParser parser;
    CourierStore store;

    StoreRig(Path dir) throws Exception {
        this(dir, TestMime.PARSER);
    }

    StoreRig(Path dir, CourierParser parser) throws Exception {
        this.dir = dir;
        this.parser = parser;
        java.nio.file.Files.createDirectories(dir);
        open();
        store.putAccount(new Courier.Account(DESK, "desk", "This desk's address", "me@desk.example", "ok"),
                List.<String[]>of(new String[] {"email", "me@desk.example"}, new String[] {"ma", "me@desk.example"}));
        store.putAccount(new Courier.Account(GMAIL, "imap", "Gmail", "me@gmail.example", "ok"),
                List.<String[]>of(new String[] {"email", "me@gmail.example"}));
        store.putAccount(new Courier.Account(MA, "ma", "Member", "me@desk.example", "ok"), List.of());
        store.putAccount(new Courier.Account(IMSG, "imessage", "Messages", null, "ok"), List.<String[]>of(new String[] {"phone", "+15550000000"}));
    }

    void open() throws Exception {
        store = CourierStore.open(dir.resolve("courier"), parser, clock, CourierStore.Settings.DEFAULT);
    }

    void reopen() throws Exception {
        store.close();
        open();
    }

    Courier.Accepted accept(Mail m) throws Exception {
        return store.accept(m.inbound(DESK));
    }

    Courier.Accepted accept(Mail m, String account) throws Exception {
        return store.accept(m.inbound(account));
    }

    /** The routing facts of a message: channel, thread, lane, direction. */
    @SuppressWarnings("unchecked")
    Map<String, Object> facts(String messageId) throws Exception {
        Map<String, Object> m = store.queries().message(messageId, 0);
        return m;
    }

    String channel(String messageId) throws Exception {
        return (String) facts(messageId).get("channelId");
    }

    String thread(String messageId) throws Exception {
        return (String) facts(messageId).get("threadId");
    }

    String lane(String messageId) throws Exception {
        return (String) facts(messageId).get("lane");
    }

    @Override
    public void close() {
        if (store != null) {
            store.close();
        }
    }
}
