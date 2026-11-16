package com.minimalistalliance.desk.deskd.courier.linked;

import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Duration;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.function.BooleanSupplier;

/**
 * Paces a mailbox's first sync (the launch plan §2.2): under the provider's daily IMAP download (Gmail's is about 2.5 GB;
 * this keeps to 2 GB), counted per UTC day in the store with the messages it brought, so a restart doesn't forget it; and
 * under a bandwidth cap, so a first sync never takes the desk's whole link. New mail isn't held: it's counted, not paced.
 */
final class Pacer {

    static final String STREAM = "pace";

    private final String accountId;
    private final long dailyBytes;
    private final long rate;
    private final Clock clock;
    private LocalDate day;
    private long spentToday;
    private double tokens;
    private long refilledAt;

    Pacer(CourierStore store, String accountId, long dailyBytes, long bytesPerSecond, Clock clock) throws SQLException {
        this.accountId = accountId;
        this.dailyBytes = dailyBytes;
        this.rate = Math.max(1, bytesPerSecond);
        this.clock = clock;
        this.day = today();
        String kept = store.cursor(accountId, STREAM);
        if (kept != null) {
            String[] p = kept.split(" ");
            if (p.length == 2 && p[0].equals(day.toString())) {
                spentToday = Math.max(0, ImapReader.number(p[1]));
            }
        }
        this.tokens = rate;
        this.refilledAt = System.nanoTime();
    }

    private LocalDate today() {
        return LocalDate.ofInstant(clock.instant(), ZoneOffset.UTC);
    }

    /**
     * Before a first sync's download of {@code bytes}: past the day's allowance it waits for the next UTC day (as
     * {@link MailboxSync.Throttled}, {@code daily_limit}); otherwise it sleeps as long as the bandwidth cap needs.
     */
    void before(long bytes, BooleanSupplier stop) throws MailboxSync.Throttled, InterruptedException {
        LocalDate d = today();
        if (!d.equals(day)) {
            day = d;
            spentToday = 0;
        }
        if (spentToday + bytes > dailyBytes) {
            long untilMidnight = Duration.between(clock.instant(), d.plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant()).toMillis();
            throw new MailboxSync.Throttled(Duration.ofMillis(Math.max(60_000, untilMidnight)), "daily_limit");
        }
        long now = System.nanoTime();
        tokens = Math.min(rate * 2.0, tokens + (now - refilledAt) / 1e9 * rate);
        refilledAt = now;
        double need = Math.min(bytes, rate * 2.0);
        while (tokens < need && !stop.getAsBoolean()) {
            long sleep = (long) Math.min(250, Math.ceil((need - tokens) / rate * 1000));
            Thread.sleep(Math.max(1, sleep));
            now = System.nanoTime();
            tokens = Math.min(rate * 2.0, tokens + (now - refilledAt) / 1e9 * rate);
            refilledAt = now;
        }
        tokens -= need;
    }

    void spent(long bytes) {
        LocalDate d = today();
        if (!d.equals(day)) {
            day = d;
            spentToday = 0;
        }
        spentToday += bytes;
    }

    /** Today's count, to commit with the messages it paid for. */
    Courier.CursorUpdate cursor() {
        return new Courier.CursorUpdate(accountId, STREAM, day + " " + spentToday);
    }
}
