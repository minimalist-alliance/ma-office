package com.minimalistalliance.desk.deskd.apps;

import java.nio.file.Path;

/**
 * What runs an app for deskd: the System Engineer's root helper, {@code desk-apps} (the desk app contract, section 9, and the
 * Desk Engineer's review, "deskd and the helper"). It makes an app's directories with its uid and disk quota, starts and stops
 * its sandboxed unit in {@code apps.slice}, says how it last ended, and removes it. deskd never runs a catalog app itself
 * (only the first-party apps in its own image, below), and the helper never parses a package: deskd has verified and placed
 * the release, and the helper reads only {@code /data/apps/<id>/current/ma-app.json} to build the unit, holding it to the
 * first-party ceilings and the uid range whatever it says.
 *
 * <p>{@link HelperAppHost} is the real one, over {@code /run/desk/apps.sock}. No image has the helper yet, so on a desk today
 * {@link #unavailable} says {@code no_sandbox} and no catalog app installs or starts. {@link BundledAppHost} runs the
 * first-party apps bundled in deskd's own image, as deskd's children, until the helper exists. Tests use a double that runs
 * a fake app in the test's own JVM.
 */
public interface AppHost {

    /** How a unit last ended, as far as the helper knows. */
    record Status(String state, String result) {
        public static final String RUNNING = "running";
        public static final String STOPPED = "stopped";
        public static final String FAILED = "failed";
        /** {@code result} when the kernel killed it at its memory limit. */
        public static final String OOM = "oom-kill";

        public boolean running() {
            return RUNNING.equals(state);
        }

        public boolean outOfMemory() {
            return OOM.equals(result);
        }
    }

    /** Null if apps can run on this desk now; otherwise the reason the client is told, such as {@code no_sandbox}. */
    String unavailable();

    /**
     * Makes {@code /data/apps/<id>/} (deskd's, {@code 0700}) under a project quota of {@code diskMaxBytes} with the uid as its
     * project id, its {@code data} and {@code cache} ({@code 0700}, the app's uid; existing ones re-owned to it, as after a
     * move), and {@code /run/ma-apps/<id>/} ({@code 2750}, the app's uid, group {@code desk}). Idempotent. A desk with no
     * project quota on {@code /data} refuses: an app with no disk cap could fill the volume and cost the Browser its session
     * (ADR 0035).
     */
    void prepare(String id, int uid, long diskMaxBytes) throws AppHostException, InterruptedException;

    /** Starts the app's unit from its current release, and returns once systemd has: the HELLO is deskd's to wait for. */
    void start(String id, int uid) throws AppHostException, InterruptedException;

    /** SIGTERM, then SIGKILL after the manifest's stop timeout; returns when it's gone. A stopped app answers at once. */
    void stop(String id) throws AppHostException, InterruptedException;

    Status status(String id) throws AppHostException, InterruptedException;

    /**
     * Stops it if it runs, drops its quota, firewall rule and socket directory, and with {@code deleteData} its {@code data}
     * and {@code cache} and then {@code /data/apps/<id>/} if nothing else is left in it. deskd has already removed the
     * releases.
     */
    void remove(String id, int uid, boolean deleteData) throws AppHostException, InterruptedException;

    /** Where the app listens: {@code /run/ma-apps/<id>/app.sock}. */
    Path socket(String id);

    /** The uid deskd must see at the app's socket ({@code SO_PEERCRED}): the app's own on a desk. */
    int peerUid(int appUid);

    /**
     * deskd is stopping. The helper's units run on, and the next deskd connects to them again, so this does nothing for it;
     * {@link BundledAppHost}'s apps are deskd's own children, and stop.
     */
    default void close() {}

    /** The helper said no, failed, or couldn't be reached. {@link #code} is a word the client may be told. */
    final class AppHostException extends Exception {
        private static final long serialVersionUID = 1L;

        private final String code;

        public AppHostException(String code) {
            super(code, null, false, false);
            this.code = code;
        }

        public String code() {
            return code;
        }
    }
}
