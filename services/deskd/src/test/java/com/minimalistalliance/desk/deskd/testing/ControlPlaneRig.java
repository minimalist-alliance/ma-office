package com.minimalistalliance.desk.deskd.testing;

import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.auth.DeskTokenVerifier;
import com.minimalistalliance.desk.deskd.auth.JwksCache;
import com.minimalistalliance.desk.deskd.auth.Revocations;
import com.minimalistalliance.desk.deskd.aws.RoleCredentials;
import com.minimalistalliance.desk.deskd.boot.BootSequence;
import com.minimalistalliance.desk.deskd.boot.ControlPlaneObserver;
import com.minimalistalliance.desk.deskd.browser.BrowserModule;
import com.minimalistalliance.desk.deskd.browser.UnitsClient;
import com.minimalistalliance.desk.deskd.data.DataModule;
import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.TopicRegistry;
import com.minimalistalliance.desk.deskd.gateway.GatewayLink;
import com.minimalistalliance.desk.deskd.imds.ImdsClient;
import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.platform.AgentClient;
import com.minimalistalliance.desk.deskd.platform.DataVolume;
import com.minimalistalliance.desk.deskd.platform.DeskState;
import com.minimalistalliance.desk.deskd.platform.HeartbeatLoop;
import com.minimalistalliance.desk.deskd.platform.ModelPrices;
import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import com.minimalistalliance.desk.deskd.session.SessionManager;
import com.minimalistalliance.desk.deskd.status.StatusMethods;
import com.minimalistalliance.desk.deskd.tier.BrowserTime;
import com.minimalistalliance.desk.deskd.tier.FreeTier;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;

/**
 * The control plane wired as ControlPlaneConfiguration wires it, against fakes on real sockets, with
 * short timings, so a test can watch hours of contract time go by in a moment.
 */
public final class ControlPlaneRig implements AutoCloseable {

    public static final BootSequence.Timing FAST_BOOT =
            new BootSequence.Timing(Duration.ofMillis(20), Duration.ofMillis(100), Duration.ofMillis(200), Duration.ofSeconds(5), Duration.ofMillis(500));
    public static final GatewayLink.Timing FAST_LINK = new GatewayLink.Timing(
            Duration.ofMillis(20),
            Duration.ofMillis(200),
            Duration.ofHours(1),
            Duration.ofSeconds(30),
            Duration.ofMillis(300),
            Duration.ofHours(1),
            Duration.ZERO,
            Duration.ofMillis(200));
    public static final HeartbeatLoop.Timing SLOW_BEATS =
            new HeartbeatLoop.Timing(Duration.ofHours(1), Duration.ofMillis(100), Duration.ofSeconds(5));

    public final FakePlatform platform;
    public final FakeGateway gateway;
    public final FakeDeskRtc rtc;
    public final PlatformHttp http = new PlatformHttp();
    public final DeskState state;
    public final RtcClient rtcClient;
    public final RoleCredentials credentials;
    public final JwksCache jwks;
    public final Revocations revocations;
    public final DeskTokenVerifier verifier;
    public final SessionManager sessions;
    public final RpcDispatcher dispatcher;
    public final EventHub hub;
    public final AgentClient agent;
    public final BootSequence boot;
    public final HeartbeatLoop heartbeat;
    public final GatewayLink link;
    public final DataVolume volume;
    /** The data volume's usable bytes, as statvfs would say; -1 (the start) for the real file system's. */
    public final java.util.concurrent.atomic.AtomicLong usableBytes = new java.util.concurrent.atomic.AtomicLong(-1);
    public final AgeBand ageBand;
    /** deskd's data directory, apart from the sockets, as on a desk. */
    public final Path dataDir;
    public final StubUnitsSocket units;
    public final BrowserModule browser;
    /** With no helper behind data.sock, and the free-bytes file beside rtc.sock, as on a desk. */
    public final DataModule data;
    /** Not started, as nothing else needs it: a test starts it to see what it does beside the rest. */
    public final ModelPrices prices;
    /** The free tier's Browser time, wired as on a desk, with its count since boot beside units.sock. */
    public final BrowserTime browserTime;

    public ControlPlaneRig(Path dir, GatewayLink.Timing linkTiming, HeartbeatLoop.Timing beatTiming) throws Exception {
        this(dir, linkTiming, beatTiming, Clock.systemUTC(), true);
    }

    /** With the API base left to the Env tag, for what happens when the tag makes no sense. */
    public static ControlPlaneRig withoutApiOverride(Path dir) throws Exception {
        return new ControlPlaneRig(dir, FAST_LINK, SLOW_BEATS, Clock.systemUTC(), false);
    }

    private ControlPlaneRig(
            Path dir, GatewayLink.Timing linkTiming, HeartbeatLoop.Timing beatTiming, Clock clock, boolean apiOverride)
            throws Exception {
        platform = new FakePlatform();
        gateway = new FakeGateway(platform.timeline);
        platform.gatewayUrl = gateway.url();
        Path socket = dir.resolve("rtc.sock");
        rtc = new FakeDeskRtc(socket);
        rtc.autoStats(true);
        dataDir = Files.createDirectories(dir.resolve("data"));
        volume = new DataVolume(dataDir, directory -> {
            long stub = usableBytes.get();
            return stub >= 0 ? stub : Files.getFileStore(directory).getUsableSpace();
        });
        ageBand = new AgeBand(dataDir.resolve(AgeBand.FILE));
        state = new DeskState("00000000-0000-4000-8000-000000000099", apiOverride ? platform.url() : null, null);
        rtcClient = new RtcClient(new RtcClient.Config(socket, SessionManager.MAX_SESSIONS, state::publicIpv4));
        ImdsClient imds = new ImdsClient(http, platform.url());
        credentials = new RoleCredentials(imds, clock);
        jwks = new JwksCache(http, state::jwksUrl, clock);
        revocations = new Revocations(clock);
        verifier = new DeskTokenVerifier(state, jwks, revocations, clock);
        dispatcher = new RpcDispatcher();
        new StatusMethods(state, rtcClient, "test-version", System.nanoTime()).register(dispatcher);
        hub = new EventHub(new TopicRegistry());
        sessions = new SessionManager(rtcClient, verifier, dispatcher, hub, state, "test-version", Instant.now());
        units = new StubUnitsSocket(dir.resolve("units.sock"));
        // Nothing listens on port 9, so Chromium is simply down.
        int ownUid = (Integer) Files.getAttribute(Path.of("/proc/self"), "unix:uid");
        browser = new BrowserModule(
                rtcClient,
                sessions,
                dispatcher,
                hub,
                http,
                new UnitsClient(dir.resolve("units.sock"))::run,
                dir.resolve(BrowserModule.REFUSAL_MARKER),
                9,
                ownUid);
        units.forgetStartupThaw();
        browser.followStreamingPause(state.streamingPause());
        browser.followAgeBand(ageBand);
        browserTime = FreeTier.follow(state, dataDir, dir, browser, clock);
        data = new DataModule(
                sessions, dispatcher, browser, dir.resolve("data.sock"), dir.resolve(DataModule.FREE_BYTES_FILE), state::bootId,
                volume, clock, DataModule.Timing.DEFAULT);
        data.followStreamingPause(state.streamingPause());
        agent = new AgentClient(http, credentials, state::apiBase, clock);
        prices = new ModelPrices(http, state::apiBase, dataDir, new ModelPrices.Timing(
                Duration.ZERO, Duration.ofHours(1), Duration.ZERO, Duration.ofMillis(20), Duration.ofMillis(100), Duration.ofHours(1)));
        boot = new BootSequence(imds, state, rtcClient, sessions, agent, jwks, volume, ageBand, "test-version", "image-1", FAST_BOOT);
        heartbeat = new HeartbeatLoop(
                agent, state, sessions, rtcClient, volume, browser::chromiumRefused, data::freeBytesSent, revocations, boot, clock,
                beatTiming);
        heartbeat.browserFrozenFrom(browser::browserFrozen);
        heartbeat.browserLiveSecondsFrom(browserTime::liveSecondsSinceBoot);
        link = new GatewayLink(http, credentials, state, sessions, revocations, boot, "test-version", clock, linkTiming);
        revocations.closeSessionsThrough(sessions);
        sessions.setObserver(new ControlPlaneObserver(link, heartbeat, boot));
        boot.attach(heartbeat, link);
    }

    /** Boots and waits until the gateway has acknowledged ready. */
    public void bootToReady() throws Exception {
        boot.start();
        await().atMost(Duration.ofSeconds(10)).until(link::isReady);
    }

    @Override
    public void close() throws Exception {
        boot.stop();
        prices.close();
        link.close(Duration.ZERO);
        heartbeat.stopAndSendFinal(Duration.ofMillis(200));
        browserTime.close();
        browser.close();
        rtcClient.close();
        http.close();
        rtc.close();
        units.close();
        gateway.close();
        platform.close();
    }
}
