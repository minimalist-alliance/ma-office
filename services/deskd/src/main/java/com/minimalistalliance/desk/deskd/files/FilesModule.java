package com.minimalistalliance.desk.deskd.files;

import com.minimalistalliance.desk.deskd.auth.DeskTokenVerifier;
import com.minimalistalliance.desk.deskd.auth.JwksCache;
import com.minimalistalliance.desk.deskd.data.Transfers;
import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.platform.StreamingPause;
import com.minimalistalliance.desk.deskd.platform.TierLimits;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.session.SessionManager;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The Files app on the desk (ADR 0048, wire contract {@code services/deskd/docs/files.md}): a window onto
 * {@code /data/files}, a tree only deskd writes. It registers the {@code files.*} methods and the topic
 * {@code files.changes}, takes the client's CHUNK frames on {@code bulk} through the one transfer table, and sweeps the
 * trash (30 days) and the partials (24 hours) at start and every hour.
 *
 * <p>If the tree can't be used (wrong mode or owner, or no safe-open on the filesystem) every {@code files.*} call answers
 * {@code unavailable} with {@code reason: tree}, and nothing else here runs.
 */
public final class FilesModule {

    private static final Logger log = LoggerFactory.getLogger(FilesModule.class);

    /** Where the tree is on the desk. */
    public static final String DEFAULT_ROOT = "/data/files";

    /**
     * @param root usually {@link #DEFAULT_ROOT}
     * @param uid who must own the tree: -1 for the process's own user
     * @param floorBytes ADR 0035's floor, 2 GiB
     * @param imageGateStub true only for a test desk or a rig: {@code stub.<sha256>} is then a valid token
     * @param allowUnchecked whether a token whose {@code ma_state} is {@code unchecked} (the checker was offline) is taken
     * @param verdictKeysFile a JWKS file to verify tokens with instead of the desk's cached keys, or null
     */
    public record Settings(
            Path root,
            int uid,
            long floorBytes,
            Duration trashKeep,
            Duration partialKeep,
            Duration finishWait,
            Duration sweepEvery,
            boolean imageGateStub,
            boolean allowUnchecked,
            Path verdictKeysFile) {

        public static Settings defaults(Path root) {
            return new Settings(
                    root, -1, Quota.FLOOR_BYTES, Duration.ofDays(30), Duration.ofHours(24), Duration.ofSeconds(30), Duration.ofHours(1),
                    false, true, null);
        }
    }

    private final SafeTree tree;
    private final Uploads uploads;
    private final Trash trash;
    private final ChangeFeed feed;
    private final FilesMethods methods;
    private final ScheduledExecutorService timer;
    private final Clock clock;
    private final Quota quota;

    /**
     * @param jwks where Platform's keys come from, unless the settings name a file
     * @param trust this desk's identity, for the token's {@code aud} and {@code iss}
     * @param guildDesk a guild desk has no Files: every call is {@code forbidden} there
     */
    public FilesModule(
            SessionManager sessions,
            RpcDispatcher dispatcher,
            EventHub hub,
            Transfers transfers,
            Settings settings,
            JwksCache jwks,
            DeskTokenVerifier.Trust trust,
            BooleanSupplier guildDesk,
            Clock clock) {
        this(sessions, dispatcher, hub, transfers, settings, verifierFor(settings, jwks, trust, clock), null, guildDesk, clock);
    }

    private static VerdictVerifier verifierFor(Settings settings, JwksCache jwks, DeskTokenVerifier.Trust trust, Clock clock) {
        VerdictVerifier.Keys keys;
        if (settings.verdictKeysFile() != null) {
            Path file = settings.verdictKeysFile();
            keys = VerdictVerifier.keysFrom(() -> {
                try {
                    return Files.readString(file, StandardCharsets.UTF_8);
                } catch (java.io.IOException e) {
                    throw new IllegalStateException(e);
                }
            });
        } else {
            keys = jwks::verdictVerifierFor;
        }
        VerdictVerifier.Identity identity = new VerdictVerifier.Identity() {
            @Override
            public String deskId() {
                return trust.deskId();
            }

            @Override
            public String issuer() {
                return trust.issuer();
            }
        };
        return new VerdictVerifier(
                keys, identity, clock, settings.imageGateStub() ? VerdictVerifier.Mode.STUB : VerdictVerifier.Mode.REAL, settings.allowUnchecked());
    }

    /** For tests: the verifier and the drive's space are theirs. */
    FilesModule(
            SessionManager sessions,
            RpcDispatcher dispatcher,
            EventHub hub,
            Transfers transfers,
            Settings settings,
            VerdictVerifier verifier,
            Quota.Space space,
            BooleanSupplier guildDesk,
            Clock clock) {
        this.clock = clock;
        SafeTree opened = null;
        try {
            opened = SafeTree.open(settings.root(), settings.uid());
        } catch (SafeTree.Unusable e) {
            log.warn("the Files tree can't be used: {}", e.getMessage());
        }
        this.tree = opened;
        if (tree == null) {
            this.quota = null;
            this.uploads = null;
            this.trash = null;
            this.feed = null;
            this.methods = null;
            this.timer = null;
            FilesMethods.registerUnavailable(dispatcher, guildDesk);
            return;
        }
        this.timer = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "files-sweep");
            t.setDaemon(true);
            return t;
        });
        this.feed = new ChangeFeed(hub, timer);
        hub.topics().register(ChangeFeed.TOPIC, feed);
        this.trash = new Trash(tree, clock, settings.trashKeep());
        Uploads[] later = new Uploads[1];
        Quota quota = new Quota(
                tree, trash, space != null ? space : Quota.spaceOf(tree), settings.floorBytes(),
                () -> later[0] == null ? 0 : later[0].owedBytes(), () -> later[0] == null ? 0 : later[0].reservedBytes(), clock);
        this.quota = quota;
        this.uploads = new Uploads(tree, quota, trash, transfers, sessions, verifier, clock, feed, sessions::noteTransferActivity, settings.partialKeep(), settings.finishWait());
        later[0] = uploads;
        this.methods = new FilesMethods(tree, trash, quota, uploads, transfers, feed, sessions::noteTransferActivity, guildDesk, clock);
        methods.register(dispatcher);
        timer.scheduleWithFixedDelay(this::sweep, 0, Math.max(1, settings.sweepEvery().toMillis()), TimeUnit.MILLISECONDS);
    }

    /** The Platform's bandwidth pause refuses a new files.read, as it does data.read. Called once, before anything can call. */
    public void followStreamingPause(StreamingPause pause) {
        if (methods != null) {
            methods.pauseFrom(pause::pausedUntil);
        }
    }

    /**
     * Holds a free desk's Files to {@code filesGb} (ADR 0090, section 7), on top of the floor: a new upload past it gets
     * {@code no_space} with {@code reason: cap}, {@code files.usage} reports it, and nothing already there is touched. A
     * change applies at once and tells the Files app ({@code files.changes {usage: true}}). Called once, before anything
     * can call.
     */
    public void followTierLimits(TierLimits limits) {
        if (quota == null) {
            return;
        }
        quota.capFrom(() -> {
            TierLimits.Limits now = limits.current();
            return now == null ? -1 : now.filesCapBytes();
        });
        limits.onChange(now -> feed.usage());
    }

    /** True if the tree opened and the methods are live. */
    public boolean available() {
        return tree != null;
    }

    /**
     * The Browser's import's way to one file ({@link ImportFiles}): read it whole. While the tree can't be used, the read
     * says so with {@code unavailable}, {@code reason: tree}.
     */
    public ImportFiles importFiles() {
        if (tree == null) {
            return (path, maxBytes) -> {
                throw Errs.tree();
            };
        }
        return new TreeImports(tree);
    }

    /** Removes expired trash and stale partials. Also runs hourly. */
    public void sweep() {
        if (tree == null) {
            return;
        }
        try {
            tree.lock.lock();
            try {
                int purged = trash.purgeExpired();
                int stale = uploads.sweep();
                if (purged > 0) {
                    feed.trash();
                }
                if (stale > 0) {
                    feed.usage();
                }
            } finally {
                tree.lock.unlock();
            }
        } catch (RuntimeException e) {
            log.warn("files sweep failed: {}", e.getClass().getSimpleName());
        }
    }

    Uploads uploads() {
        return uploads;
    }

    Quota quota() {
        return quota;
    }

    SafeTree tree() {
        return tree;
    }

    Trash trash() {
        return trash;
    }

    ChangeFeed feed() {
        return feed;
    }

    /**
     * The Agent's Files tools' way in (draft ADR "the Agent's tools and approvals"): the same tree, trash, quota and
     * change feed, narrowed. Its {@code available()} is false when the tree can't be used.
     */
    public AgentFiles agentAccess() {
        return new AgentFiles(tree, trash, quota, feed, methods);
    }

    /** Ends running uploads (their partials stay) and stops the sweep. */
    public void close() {
        if (tree == null) {
            return;
        }
        timer.shutdownNow();
        feed.close();
        uploads.close();
        tree.close();
    }
}
