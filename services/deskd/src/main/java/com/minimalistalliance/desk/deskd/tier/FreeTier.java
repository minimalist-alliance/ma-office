package com.minimalistalliance.desk.deskd.tier;

import com.minimalistalliance.desk.deskd.browser.BrowserModule;
import com.minimalistalliance.desk.deskd.platform.DeskState;
import com.minimalistalliance.desk.deskd.platform.TierLimits;
import java.nio.file.Path;
import java.time.Clock;
import java.util.Map;

/**
 * Wires the free tier's Browser time (ADR 0090) the one way both the desk's configuration and the test rig use: the tier's
 * limits kept on the data volume, the meter beside them, the Browser following it, and the meter following the limits.
 */
public final class FreeTier {

    private FreeTier() {}

    /**
     * Loads the limits and the day, and starts the meter. Once, before the lifecycle starts.
     *
     * @param dataDir deskd's data directory, {@code /data/desk}
     * @param runDir a directory a reboot clears and a restart of deskd doesn't: units.sock's, {@code /run/desk}
     * @return the meter, which the heartbeat reads and which is closed as deskd stops
     */
    public static BrowserTime follow(DeskState state, Path dataDir, Path runDir, BrowserModule browser, Clock clock) {
        TierLimits limits = state.tierLimits();
        limits.keepIn(dataDir.resolve(TierLimits.FILE));
        BrowserTime time = new BrowserTime(
                dataDir.resolve(BrowserTime.FILE), runDir.resolve(BrowserTime.LIVE_FILE), state.bootId(), clock, System::nanoTime,
                () -> accountZone(state), limits.current());
        limits.onChange(time::limitsChanged);
        browser.followBrowserTime(time::outUntil, time::live);
        time.onOut(browser::browserTimeUsed);
        time.start();
        return time;
    }

    /** The account's {@code agentDefaults.timeZone}, as the config last said, or null. */
    private static String accountZone(DeskState state) {
        Map<String, Object> defaults = state.accountDefaults().current();
        return defaults != null && defaults.get("timeZone") instanceof String zone ? zone : null;
    }
}
