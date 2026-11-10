package com.minimalistalliance.desk.deskd.data;

import com.minimalistalliance.desk.deskd.browser.BrowserModule;
import com.minimalistalliance.desk.deskd.platform.DataVolume;
import com.minimalistalliance.desk.deskd.platform.StreamingPause;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.session.SessionListener;
import com.minimalistalliance.desk.deskd.session.SessionManager;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.function.Supplier;

/**
 * Download all my data, and move a desk to the owner's own hardware (task 32's draft ADR, decisions 3 to 8, and API.md
 * section 12): the data.* RPCs, data.read's transfers on channel 5, the Browser's hold and its cookies' digests, and
 * the count of the bytes that cost nothing. deskd reads no file itself: the root helper behind data.sock does, and a
 * desk without it answers {@code unavailable} with {@code reason: helper}.
 *
 * <p>Wired once the session manager and the Browser module exist. Nothing here runs until a client asks: no thread,
 * no timer and no connection while no transfer, hold or count is under way. The one exception is a hold a move kept
 * ({@link BrowserHold}, Security's NE-2): its file is read here, and if it's there the Browser is held again at once.
 */
public final class DataModule implements SessionListener {

    /** The file desk-egress reads, beside rtc.sock: {@link FreeBytes}. */
    public static final String FREE_BYTES_FILE = FreeBytes.NAME;
    /** The file that keeps a move's hold of the Browser, in the data volume's directory: {@link BrowserHold}. */
    public static final String BROWSER_MOVED_FILE = BrowserHold.KEPT_FILE;

    /**
     * @param helperWait how long the helper gets to answer a request, a read's header included
     * @param holdFor how long a hold of the Browser lasts without a release
     * @param holdStopWait how long a hold waits for Chromium to stop: 100 s, past units.sock's 95 s for a stop of desk-browser
     * @param transferIdle how long a transfer waits for the reader's credit before it gives up
     * @param freeBytesEvery the least time between two writes of the free-bytes file
     */
    public record Timing(Duration helperWait, Duration holdFor, Duration holdStopWait, Duration transferIdle, Duration freeBytesEvery) {
        public static final Timing DEFAULT = new Timing(
                DataHelperClient.WAIT, Duration.ofMinutes(30), Duration.ofSeconds(100), Duration.ofMinutes(5), FreeBytes.EVERY);
    }

    private final Transfers transfers;
    private final BrowserHold hold;
    private final FreeBytes freeBytes;
    private final FreeBudget budget;
    private final DataMethods methods;

    /**
     * @param helperSocket usually /run/desk/data.sock
     * @param freeBytesFile usually /run/desk/free-bytes, or null for none
     * @param bootId for the free-bytes file's line
     * @param volume whose directory has the free budget's file and a move's kept hold, and whose size sets the budget
     */
    public DataModule(
            SessionManager sessions,
            RpcDispatcher dispatcher,
            BrowserModule browser,
            Path helperSocket,
            Path freeBytesFile,
            Supplier<String> bootId,
            DataVolume volume,
            Clock clock,
            Timing timing) {
        this(
                sessions, dispatcher, browser, helperSocket, freeBytesFile, bootId,
                new FreeBudget(volume.directory().resolve(FreeBudget.NAME), () -> sizeOf(volume), clock, FreeBudget.EVERY),
                volume.directory().resolve(BROWSER_MOVED_FILE),
                timing);
    }

    DataModule(
            SessionManager sessions,
            RpcDispatcher dispatcher,
            BrowserModule browser,
            Path helperSocket,
            Path freeBytesFile,
            Supplier<String> bootId,
            FreeBudget budget,
            Path browserMovedFile,
            Timing timing) {
        this.freeBytes = new FreeBytes(freeBytesFile, bootId, timing.freeBytesEvery());
        this.budget = budget;
        this.transfers = new Transfers(sessions, freeBytes, budget, timing.transferIdle());
        this.hold = new BrowserHold(
                new BrowserHold.Browser() {
                    @Override
                    public CompletableFuture<Void> hold() {
                        return browser.holdBrowser();
                    }

                    @Override
                    public void release() {
                        browser.releaseBrowser();
                    }
                },
                sessions::isLive,
                timing.holdFor(),
                timing.holdStopWait(),
                browserMovedFile);
        this.methods = new DataMethods(new DataHelperClient(helperSocket, timing.helperWait()), transfers, hold, browser::cookies);
        methods.register(dispatcher);
        sessions.registerChannelHandler(Channels.BULK, transfers);
        sessions.addSessionListener(this);
        browser.followMovedHold(hold::keptSince);
        hold.restoreKept();
    }

    private static long sizeOf(DataVolume volume) {
        DataVolume.Usage usage = volume.usage();
        return usage == null ? 0 : usage.totalBytes();
    }

    /** data.read hears the Platform's bandwidth pause from here. Called once, before anything can call. */
    public void followStreamingPause(StreamingPause pause) {
        methods.pauseFrom(pause::pausedUntil);
    }

    /**
     * {@code exports} of /run/desk/idle.json: the data.read transfers of {@code export} sessions and the sessions holding
     * the Browser for a copy, which is a move or an export in progress.
     */
    public int exportsGoing() {
        return transfers.exportCount() + hold.holders();
    }

    /** {@code action} runs when {@link #exportsGoing} may have changed. It must not block. Called once, before anything runs. */
    public void onExportsChange(Runnable action) {
        transfers.onExportsChange(action);
        hold.onHoldsChange(action);
    }

    /** Never blocks: a transfer's stop only flags and interrupts, and a hold's end only changes state. */
    @Override
    public void onSessionEnded(String sessionId) {
        transfers.sessionEnded(sessionId);
        hold.sessionEnded(sessionId);
    }

    /** {@code media.freeBytesSent}: frame bytes handed to desk-rtc for free exports since this process started. */
    public long freeBytesSent() {
        return freeBytes.total();
    }

    /** Writes the free-bytes file and the free budget's one last time, on the way out. */
    public void close() {
        freeBytes.close();
        budget.close();
    }

    FreeBytes freeBytes() {
        return freeBytes;
    }

    FreeBudget budget() {
        return budget;
    }

    /** The one table of transfers on this desk: data.read, files.read and the Files app's uploads. */
    public Transfers transfers() {
        return transfers;
    }

    BrowserHold hold() {
        return hold;
    }
}
