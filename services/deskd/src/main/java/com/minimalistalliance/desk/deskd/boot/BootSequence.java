package com.minimalistalliance.desk.deskd.boot;

import com.minimalistalliance.desk.deskd.auth.JwksCache;
import com.minimalistalliance.desk.deskd.gateway.GatewayLink;
import com.minimalistalliance.desk.deskd.imds.ImdsClient;
import com.minimalistalliance.desk.deskd.imds.InstanceIdentity;
import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.platform.AgentClient;
import com.minimalistalliance.desk.deskd.platform.DataVolume;
import com.minimalistalliance.desk.deskd.platform.DeskState;
import com.minimalistalliance.desk.deskd.platform.HeartbeatLoop;
import com.minimalistalliance.desk.deskd.platform.PlatformActions;
import com.minimalistalliance.desk.deskd.platform.PlatformConfig;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import com.minimalistalliance.desk.deskd.session.SessionManager;
import java.io.IOException;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * desk-runtime.md section 3 and desk-endpoint.md 5.3, in order: IMDS, then desk-rtc with the public
 * IPv4, then hello, config, the gateway link and the heartbeat. Each step retries until it works, on
 * its own virtual thread, so the admin socket answers throughout, and if a step can't finish, the
 * desk just refuses sessions. Afterwards the thread stays parked to serve what Platform asks for.
 *
 * <p>desk-rtc gets {@link Timing#rtcWait} to be configured. After that, hello goes with the identity desk-rtc reported on
 * an earlier boot ({@link KnownRtcIdentity}), so the Platform hears the desk and its heartbeat says {@code rtc: failing}
 * rather than nothing at all (audit D4); RtcClient keeps reconnecting, and sessions are refused {@code desk_not_ready}
 * until it's configured. With none kept, as on a first boot, hello waits for desk-rtc.
 *
 * <p>Every wait between tries is the step, or the Platform's {@code Retry-After}, plus a random 0 to 50 % of it, so desks
 * that failed together don't all try again together (audit D3).
 */
public final class BootSequence implements PlatformActions {

    private static final Logger log = LoggerFactory.getLogger(BootSequence.class);

    /**
     * @param quietRetry after a refusal that won't change soon (agent.md: "idle quietly")
     * @param readyWait how long the first heartbeat waits for the gateway link
     * @param rtcWait how long hello waits for desk-rtc's first configured before it goes with the identity kept from an
     *     earlier boot. desk-rtc answers in well under a second, and its first start on a new root takes a few
     */
    public record Timing(Duration firstBackoff, Duration maxBackoff, Duration quietRetry, Duration readyWait, Duration rtcWait) {
        public static final Timing DEFAULT = new Timing(
                Duration.ofSeconds(1), Duration.ofSeconds(30), Duration.ofSeconds(60), Duration.ofSeconds(10), Duration.ofSeconds(30));
    }

    private final ImdsClient imds;
    private final DeskState state;
    private final RtcClient rtc;
    private final SessionManager sessions;
    private final AgentClient agent;
    private final JwksCache jwks;
    private final DataVolume volume;
    private final AgeBand ageBand;
    private final String version;
    private final String imageVersion;
    private final Timing timing;
    /** Only the boot thread touches this. */
    private final KnownRtcIdentity knownIdentity;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition wake = lock.newCondition();
    private HeartbeatLoop heartbeat;
    private GatewayLink link;
    private Thread thread;
    private boolean stopped;
    private String helloWanted;
    private boolean configWanted;
    private boolean rtcConfigured;
    private List<String> helloFingerprints = List.of();
    /** A read of the config failed, or left the age band unsettled, so another comes at {@link #configRetryAt}. */
    private boolean configRetryArmed;
    private long configRetryAt;
    /** Only this class's thread touches this. */
    private Duration configBackoff;

    public BootSequence(
            ImdsClient imds,
            DeskState state,
            RtcClient rtc,
            SessionManager sessions,
            AgentClient agent,
            JwksCache jwks,
            DataVolume volume,
            AgeBand ageBand,
            String version,
            String imageVersion,
            Timing timing) {
        this.imds = imds;
        this.state = state;
        this.rtc = rtc;
        this.sessions = sessions;
        this.agent = agent;
        this.jwks = jwks;
        this.volume = volume;
        this.ageBand = ageBand;
        this.version = version;
        this.imageVersion = imageVersion;
        this.timing = timing;
        this.knownIdentity = new KnownRtcIdentity(volume.directory(), volume::volumeRecord);
    }

    /** These two call back into this class through {@link PlatformActions}, so they come after it. */
    public void attach(HeartbeatLoop heartbeatLoop, GatewayLink gatewayLink) {
        heartbeat = heartbeatLoop;
        link = gatewayLink;
    }

    public void start() {
        lock.lock();
        try {
            if (thread == null && !stopped) {
                thread = Thread.ofVirtual().name("deskd-boot").start(this::run);
            }
        } finally {
            lock.unlock();
        }
    }

    public void stop() {
        lock.lock();
        try {
            stopped = true;
            if (thread != null) {
                thread.interrupt();
            }
        } finally {
            lock.unlock();
        }
    }

    /** desk-rtc answered configure. From the rtc reader, so it only records that. */
    public void onRtcConfigured() {
        lock.lock();
        try {
            rtcConfigured = true;
            wake.signalAll();
        } finally {
            lock.unlock();
        }
    }

    @Override
    public void requestHello(String reason) {
        lock.lock();
        try {
            helloWanted = reason;
            wake.signalAll();
        } finally {
            lock.unlock();
        }
    }

    @Override
    public void requestConfig() {
        lock.lock();
        try {
            configWanted = true;
            wake.signalAll();
        } finally {
            lock.unlock();
        }
    }

    @Override
    public void requestHeartbeat() {
        heartbeat.requestSoon();
    }

    private void run() {
        try {
            readIdentity();
            rtc.start(sessions);
            if (!awaitRtcConfigured(timing.rtcWait().toNanos())) {
                if (knownIdentity.read() == null) {
                    log.warn("desk-rtc isn't configured after {} s, and no earlier boot left its identity: hello waits for it",
                            timing.rtcWait().toSeconds());
                    awaitRtcConfigured(Long.MAX_VALUE);
                } else {
                    log.warn("desk-rtc isn't configured after {} s: hello goes with the identity it had, and sessions stay refused until it is",
                            timing.rtcWait().toSeconds());
                }
            }
            hello("boot");
            link.awaitReady(timing.readyWait());
            heartbeat.start();
            serve();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (RuntimeException e) {
            // Nothing above should throw, but this thread stopping silently would be worse.
            log.error("boot thread failed: {}", e.getClass().getName());
        }
    }

    private void readIdentity() throws InterruptedException {
        Duration backoff = timing.firstBackoff();
        while (true) {
            try {
                InstanceIdentity identity = imds.readIdentity();
                state.setIdentity(identity);
                if (state.apiBase() != null) {
                    log.info("desk {} kind {} env {}", identity.deskId(), identity.deskKind(), identity.env());
                    return;
                }
                state.setIdentity(null);
                log.error("no API base for Env tag {}: every session stays refused", identity.env());
            } catch (IOException | RuntimeException e) {
                log.warn("can't read the instance's identity, so every session stays refused: {}", e.getClass().getSimpleName());
            }
            Thread.sleep(spread(backoff));
            backoff = doubled(backoff);
        }
    }

    /**
     * @param maxNanos {@link Long#MAX_VALUE} for no limit
     * @return true once desk-rtc has been configured, which it then keeps; false if the wait ran out first
     */
    private boolean awaitRtcConfigured(long maxNanos) throws InterruptedException {
        long deadline = System.nanoTime() + maxNanos;
        lock.lockInterruptibly();
        try {
            while (!rtcConfigured) {
                if (maxNanos == Long.MAX_VALUE) {
                    wake.await();
                    continue;
                }
                long left = deadline - System.nanoTime();
                if (left <= 0) {
                    return false;
                }
                wake.awaitNanos(left);
            }
            rtcConfigured = false;
        } finally {
            lock.unlock();
        }
        knownIdentity.remember(rtc.fingerprints(), rtc.fingerprintsNotAfter());
        return true;
    }

    /** The step plus a random 0 to 50 % of it: never sooner than asked, and desks that failed together drift apart. */
    static Duration spread(Duration step) {
        return step.plusNanos((long) (step.toNanos() * 0.5 * java.util.concurrent.ThreadLocalRandom.current().nextDouble()));
    }

    private void hello(String reason) throws InterruptedException {
        Duration backoff = timing.firstBackoff();
        while (true) {
            Duration wait = backoff;
            try {
                List<String> fingerprints = rtc.fingerprints();
                String notAfter = rtc.fingerprintsNotAfter();
                KnownRtcIdentity.Identity known = fingerprints.isEmpty() ? knownIdentity.read() : null;
                if (known != null) {
                    // desk-rtc hasn't been configured this boot: what it had before (see the class comment).
                    fingerprints = known.fingerprints();
                    notAfter = known.notAfter();
                }
                Map<String, Object> reply = agent.hello(helloBody(reason, fingerprints, notAfter));
                Map<String, Object> carried = Json.object(reply, "config");
                boolean bandSaid = true;
                if (carried != null) {
                    applyConfig(carried);
                    bandSaid = ageBand.fromHello(carried);
                } else {
                    Map<String, Object> config = agent.config();
                    applyConfig(config);
                    ageBand.fromConfig(config);
                }
                recordHello(fingerprints);
                log.info("hello accepted, reason {}", reason);
                jwks.loadInBackground(timing.firstBackoff(), timing.maxBackoff());
                link.enable();
                retryConfigIn(null);
                // Not here: a slow Platform mustn't hold up the gateway link or the heartbeat. A guild desk has no owner,
                // so no band to wait for (desks.md, "What a Guild Desk hears"): its members' come in their tokens.
                if (!state.guildDesk() && (!bandSaid || ageBand.wantsAnotherRead())) {
                    requestConfig();
                }
                return;
            } catch (AgentClient.ApiException e) {
                log.warn("hello refused: {}", e.getMessage());
                wait = waitAfter(e, wait);
            } catch (IOException | RuntimeException e) {
                log.warn("hello failed: {}", e.getClass().getSimpleName());
            }
            Thread.sleep(spread(wait));
            backoff = doubled(backoff);
        }
    }

    private void recordHello(List<String> fingerprints) {
        lock.lock();
        try {
            helloFingerprints = fingerprints;
        } finally {
            lock.unlock();
        }
    }

    private Map<String, Object> helloBody(String reason, List<String> fingerprints, String notAfter) {
        InstanceIdentity identity = state.identity();
        Map<String, Object> dtls = new LinkedHashMap<>();
        dtls.put("fingerprintsSha256", fingerprints);
        dtls.put("notAfter", notAfter);
        DataVolume.Usage usage = volume.usage();
        Map<String, Object> dataVolume = new LinkedHashMap<>();
        dataVolume.put("mounted", volume.looksWritable());
        dataVolume.put("formattedThisBoot", false);
        dataVolume.put("totalBytes", usage == null ? null : usage.totalBytes());
        dataVolume.put("usedBytes", usage == null ? null : usage.usedBytes());
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("instanceId", identity.instanceId());
        body.put("bootId", state.bootId());
        body.put("reason", reason);
        body.put("amiId", identity.amiId());
        body.put("runtimeVersion", version);
        body.put("imageVersion", imageVersion);
        body.put("dataSchema", 0);
        body.put("deskApi", SessionManager.DESK_API);
        body.put("dtls", dtls);
        body.put("dataVolume", dataVolume);
        body.put("capabilities", List.of());
        return body;
    }

    private void serve() throws InterruptedException {
        while (true) {
            String reason;
            boolean config;
            boolean configured;
            boolean fingerprintsChanged;
            lock.lockInterruptibly();
            try {
                while (helloWanted == null && !configWanted && !rtcConfigured) {
                    if (!configRetryArmed) {
                        wake.await();
                        continue;
                    }
                    long left = configRetryAt - System.nanoTime();
                    if (left <= 0) {
                        configWanted = true;
                    } else {
                        wake.awaitNanos(left);
                    }
                }
                reason = helloWanted;
                config = configWanted;
                configured = rtcConfigured;
                helloWanted = null;
                configWanted = false;
                fingerprintsChanged = rtcConfigured && !Objects.equals(helloFingerprints, rtc.fingerprints());
                rtcConfigured = false;
            } finally {
                lock.unlock();
            }
            if (configured) {
                knownIdentity.remember(rtc.fingerprints(), rtc.fingerprintsNotAfter());
            }
            if (fingerprintsChanged) {
                // desk-rtc came back with another certificate, so clients need the new fingerprint.
                hello("cert_rotated");
            } else if (reason != null) {
                hello(reason);
            } else if (config) {
                refreshConfig();
            }
        }
    }

    /**
     * A failure here is tried again with backoff, until a read works: the next heartbeat only asks if the version differs,
     * which it needn't. That includes a {@code 503} from a membership the Platform can't read, which age.md says the desk
     * retries, and a read that leaves the age band unsettled. This only runs after a failure or a change, so it's no poll.
     */
    private void refreshConfig() throws InterruptedException {
        try {
            Map<String, Object> config = agent.config();
            applyConfig(config);
            ageBand.fromConfig(config);
            retryConfigIn(!state.guildDesk() && ageBand.wantsAnotherRead() ? nextConfigBackoff() : null);
        } catch (AgentClient.ApiException e) {
            log.warn("config fetch refused: {}", e.getMessage());
            retryConfigIn(waitAfter(e, nextConfigBackoff()));
        } catch (IOException | RuntimeException e) {
            log.warn("config fetch failed: {}", e.getClass().getSimpleName());
            retryConfigIn(nextConfigBackoff());
        }
    }

    private Duration nextConfigBackoff() {
        configBackoff = configBackoff == null ? timing.firstBackoff() : doubled(configBackoff);
        return configBackoff;
    }

    /** @param wait when to read the config again, or null for not until something asks */
    private void retryConfigIn(Duration wait) {
        if (wait == null) {
            configBackoff = null;
        }
        lock.lock();
        try {
            configRetryArmed = wait != null;
            if (wait != null) {
                configRetryAt = System.nanoTime() + spread(wait).toNanos();
            }
        } finally {
            lock.unlock();
        }
    }

    /** How long to leave the Platform alone after it answered with this, which is at least the backoff. */
    private Duration waitAfter(AgentClient.ApiException e, Duration backoff) {
        if (e.code() != null && (e.status() == 403 || e.status() == 409 || e.status() == 410)) {
            return timing.quietRetry();
        }
        return e.retryAfter() != null && e.retryAfter().compareTo(backoff) > 0 ? e.retryAfter() : backoff;
    }

    /**
     * The config, its {@code streaming}, which says whether the Browser is paused at a bandwidth limit (ADR 0095), and
     * its {@code agentDefaults}, the account's values for the desk's spending limits (ADR 0043), and its
     * {@code tierLimits}, the free tier's limits, or none (ADR 0090). This throws for a body that isn't a config, so the age
     * band and the tier's limits can't take one for a missing field.
     */
    private void applyConfig(Map<String, Object> config) {
        state.setConfig(PlatformConfig.parse(config));
        state.streamingPause().apply(Json.object(config, "streaming"));
        state.accountDefaults().apply(Json.object(config, "agentDefaults"));
        state.tierLimits().fromConfig(config);
    }

    private Duration doubled(Duration backoff) {
        Duration next = backoff.multipliedBy(2);
        return next.compareTo(timing.maxBackoff()) > 0 ? timing.maxBackoff() : next;
    }
}
