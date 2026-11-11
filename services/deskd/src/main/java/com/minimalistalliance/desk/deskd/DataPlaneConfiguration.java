package com.minimalistalliance.desk.deskd;

import com.minimalistalliance.desk.deskd.admin.AdminServer;
import com.minimalistalliance.desk.deskd.agent.AgentModule;
import com.minimalistalliance.desk.deskd.apps.AppsModule;
import com.minimalistalliance.desk.deskd.apps.HelperAppHost;
import com.minimalistalliance.desk.deskd.auth.DeskTokenVerifier;
import com.minimalistalliance.desk.deskd.auth.Revocations;
import com.minimalistalliance.desk.deskd.boot.BootSequence;
import com.minimalistalliance.desk.deskd.browser.BrowserModule;
import com.minimalistalliance.desk.deskd.browser.UnitsClient;
import com.minimalistalliance.desk.deskd.data.DataModule;
import com.minimalistalliance.desk.deskd.files.FilesModule;
import com.minimalistalliance.desk.deskd.auth.JwksCache;
import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.TopicRegistry;
import com.minimalistalliance.desk.deskd.gateway.GatewayLink;
import com.minimalistalliance.desk.deskd.guild.GuildModule;
import com.minimalistalliance.desk.deskd.guild.GuildRoster;
import com.minimalistalliance.desk.deskd.notebook.CommonsRelay;
import com.minimalistalliance.desk.deskd.notebook.NotebookModule;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.tools.BrowserTools;
import com.minimalistalliance.desk.deskd.tools.FilesTools;
import com.minimalistalliance.desk.deskd.tools.HostedDecls;
import com.minimalistalliance.desk.deskd.tools.NotebookTools;
import com.minimalistalliance.desk.deskd.tools.ToolHost;
import com.minimalistalliance.desk.deskd.platform.AgentClient;
import com.minimalistalliance.desk.deskd.platform.AccountDefaults;
import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.platform.DataVolume;
import com.minimalistalliance.desk.deskd.platform.DeskState;
import com.minimalistalliance.desk.deskd.idle.IdleFile;
import com.minimalistalliance.desk.deskd.platform.HeartbeatLoop;
import com.minimalistalliance.desk.deskd.platform.PlatformConfig;
import com.minimalistalliance.desk.deskd.platform.ModelPrices;
import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import com.minimalistalliance.desk.deskd.session.SessionManager;
import com.minimalistalliance.desk.deskd.status.DeskContention;
import com.minimalistalliance.desk.deskd.status.StatusMethods;
import com.minimalistalliance.desk.deskd.tier.BrowserTime;
import com.minimalistalliance.desk.deskd.tier.FreeTier;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;

/**
 * Wires the client-to-desk data plane by hand. Socket paths come from the Environment when the beans
 * are made, so deskd.env (root-owned) can point them elsewhere: DESKD_RTC_SOCKET, DESKD_ADMIN_SOCKET,
 * DESKD_UNITS_SOCKET, DESKD_AGENT_SOCKET, DESKD_NOTEBOOK_SOCKET, DESKD_DATA_SOCKET, and DESKD_CDP_PORT for Chromium's
 * debugging port, with DESKD_CDP_UID for who has to hold it, DESKD_IDLE_FILE for the idle file, and DESKD_LINKS_SOCKET for
 * where the xdg-open stand-in hands deskd the links Chromium gives the OS. The apps' paths: DESKD_APPS_ROOT,
 * DESKD_APPS_SOCKET (the helper's), DESKD_APPS_RUN and DESKD_APPS_KEYS (comma-separated directories).
 */
@Configuration(proxyBeanMethods = false)
class DataPlaneConfiguration {

    private static final String DEFAULT_RTC_SOCKET = "/run/desk/rtc.sock";
    private static final String DEFAULT_ADMIN_SOCKET = "/run/desk/deskd-admin.sock";
    private static final String DEFAULT_UNITS_SOCKET = "/run/desk/units.sock";
    /** desk-agent's, in its own directory: services/desk-agent/docs/proposals.md section 5. */
    private static final String DEFAULT_AGENT_SOCKET = "/run/desk-agent/agent.sock";
    /** desk-notebook's, in its own directory: API.md section 13. */
    private static final String DEFAULT_NOTEBOOK_SOCKET = "/run/desk-notebook/notebook.sock";
    /** desk-batch's, read as root (desk-runtime.md section 6.1). Its temporary file goes beside it. */
    private static final String DEFAULT_IDLE_FILE = "/run/desk/idle.json";
    private static final String DEFAULT_DATA_SOCKET = "/run/desk/data.sock";
    /** Commons', on a guild desk: docs/sub-status/deskd-guild-sessions.md, "Commons". */
    private static final String DEFAULT_COMMONS_SOCKET = "/run/desk-commons/commons.sock";
    private static final String DEFAULT_CDP_PORT = "9222";
    /** kiosk: desk-runtime.md section 1, and desk-browser.service's User. */
    private static final String DEFAULT_CDP_UID = "1102";
    /** deskd's, in a directory of its own that kiosk can enter: desk-runtime.md section 8.11. */
    private static final String DEFAULT_LINKS_SOCKET = "/run/desk-links/links.sock";

    @Bean(destroyMethod = "")
    RtcClient rtcClient(Environment environment, DeskState state) {
        Path socket = Path.of(environment.getProperty("deskd.rtc.socket", DEFAULT_RTC_SOCKET));
        // Read at each configure, after IMDS: a guild desk takes its members' sessions (API.md section 14).
        return new RtcClient(new RtcClient.Config(socket, () -> SessionManager.maxSessions(state.guildDesk()), state::publicIpv4,
                state::guildDesk, SessionManager.MAX_MEMBER_SESSIONS));
    }

    @Bean
    RpcDispatcher rpcDispatcher(DeskState state, RtcClient rtc, Environment environment) {
        RpcDispatcher dispatcher = new RpcDispatcher();
        new StatusMethods(state, rtc, version(environment), System.nanoTime()).register(dispatcher);
        return dispatcher;
    }

    @Bean
    TopicRegistry topicRegistry() {
        return new TopicRegistry();
    }

    @Bean
    EventHub eventHub(TopicRegistry topics) {
        return new EventHub(topics);
    }

    @Bean
    SessionManager sessionManager(
            RtcClient rtc,
            DeskTokenVerifier verifier,
            RpcDispatcher dispatcher,
            EventHub hub,
            DeskState state,
            Environment environment) {
        return new SessionManager(rtc, verifier, dispatcher, hub, state, version(environment), Instant.now());
    }

    /** Registers its methods and its topic. Made before the lifecycle starts, so no call can miss them. */
    @Bean(destroyMethod = "")
    BrowserModule browserModule(
            RtcClient rtc,
            SessionManager sessions,
            RpcDispatcher dispatcher,
            EventHub hub,
            PlatformHttp http,
            DeskState state,
            AgeBand ageBand,
            DataVolume volume,
            Environment environment) {
        Path unitsSocket = Path.of(environment.getProperty("deskd.units.socket", DEFAULT_UNITS_SOCKET));
        UnitsClient units = new UnitsClient(unitsSocket);
        int cdpPort = Integer.parseInt(environment.getProperty("deskd.cdp.port", DEFAULT_CDP_PORT));
        int cdpUid = Integer.parseInt(environment.getProperty("deskd.cdp.uid", DEFAULT_CDP_UID));
        // Beside units.sock, so in /run/desk, a tmpfs: it outlives a restart of deskd, and not a reboot.
        BrowserModule browser = new BrowserModule(
                rtc, sessions, dispatcher, hub, http, units::run, unitsSocket.resolveSibling(BrowserModule.REFUSAL_MARKER), cdpPort, cdpUid);
        browser.followStreamingPause(state.streamingPause());
        browser.followAgeBand(ageBand);
        // Per-site memory for the simplified view lives on the data volume, beside the desk's other state (task 47).
        // Off on every desk until /data/desk/minified-switch says on, read at run time (API.md section 14).
        browser.enableMinified(volume.directory());
        // Links Chromium hands the OS, from the image's xdg-open stand-in, which runs as Chromium's user (API.md section 10).
        // No directory, as on an image without the stand-in, and it's simply not served.
        browser.serveLinks(Path.of(environment.getProperty("deskd.links.socket", DEFAULT_LINKS_SOCKET)), cdpUid);
        // Finished features ship on: /data/desk/protected-media-switch can only turn the DRM note off (API.md section 10).
        browser.followProtectedMediaSwitch(volume.directory());
        // The Agent's Browser tools, on the view's walker and switch: one Agent tab on a free desk (draft ADR section 8).
        browser.enableAgentBrowsing(() -> state.tierLimits().current() != null);
        return browser;
    }

    /**
     * The free tier's Browser time (ADR 0090): the tier's limits and the day kept in the data volume, the count since boot
     * beside units.sock, and the Browser held to the day's minutes. Made before the lifecycle starts; closed after it stops,
     * which keeps what's been counted.
     */
    @Bean(destroyMethod = "close")
    BrowserTime browserTime(DeskState state, DataVolume volume, BrowserModule browser, Clock clock, Environment environment) {
        Path unitsSocket = Path.of(environment.getProperty("deskd.units.socket", DEFAULT_UNITS_SOCKET));
        return FreeTier.follow(state, volume.directory(), unitsSocket.getParent(), browser, clock);
    }

    /**
     * The topic desk.contention: whether the desk's whole cgroup is held back from the CPU on its shared host, from the
     * files the host gives deskd (DESKD_CONTENTION_DIR, {@code /run/desk-host/cgroup}). Refused where they aren't.
     */
    @Bean(destroyMethod = "close")
    DeskContention deskContention(EventHub hub, Environment environment) {
        DeskContention contention = new DeskContention(
                hub, Path.of(environment.getProperty("deskd.contention.dir", DeskContention.DEFAULT_DIR)), DeskContention.Timing.DEFAULT);
        contention.register();
        return contention;
    }

    /** The relay of agent.*: registers its methods and topics, and connects once the lifecycle starts. */
    @Bean(destroyMethod = "")
    AgentModule agentModule(
            RpcDispatcher dispatcher,
            EventHub hub,
            DeskState state,
            ModelPrices prices,
            Clock clock,
            AgeBand ageBand,
            DataVolume volume,
            Environment environment) {
        Path socket = Path.of(environment.getProperty("deskd.agent.socket", DEFAULT_AGENT_SOCKET));
        AgentModule agent = new AgentModule(socket, dispatcher, hub, state::deskId, clock, ageBand);
        state.accountDefaults().keepIn(volume.directory().resolve(AccountDefaults.FILE));
        agent.followPlatform(prices, state.accountDefaults());
        return agent;
    }

    /** The relay of notebook.*: registers its methods, its topic and collab. It connects at each session's first use. */
    @Bean(destroyMethod = "")
    NotebookModule notebookModule(SessionManager sessions, RpcDispatcher dispatcher, EventHub hub, Environment environment) {
        Path socket = Path.of(environment.getProperty("deskd.notebook.socket", DEFAULT_NOTEBOOK_SOCKET));
        return new NotebookModule(socket, sessions, dispatcher, hub, NotebookModule.Timing.DEFAULT);
    }

    /** A guild desk's room link, channel 4, relayed to Commons. Inert on any other desk. It connects at each session's first use. */
    @Bean(destroyMethod = "")
    CommonsRelay commonsRelay(SessionManager sessions, EventHub hub, DeskState state, Environment environment) {
        Path socket = Path.of(environment.getProperty("deskd.commons.socket", DEFAULT_COMMONS_SOCKET));
        return new CommonsRelay(socket, sessions, hub, state::guildDesk, NotebookModule.Timing.DEFAULT);
    }

    /** A guild desk's roster, agent settings, guild.* methods and heartbeat block. Inert on any other desk. */
    @Bean(destroyMethod = "")
    GuildModule guildModule(
            DataVolume volume,
            DeskState state,
            SessionManager sessions,
            RpcDispatcher dispatcher,
            DeskTokenVerifier verifier,
            AgentClient platform,
            AgentModule agent,
            Clock clock,
            GatewayLink link,
            HeartbeatLoop heartbeat,
            CommonsRelay commons,
            NotebookModule notebook,
            RtcClient rtc) {
        GuildModule guild = new GuildModule(
                volume.directory(), state, sessions, dispatcher, verifier, platform, agent, clock, GuildRoster.Timing.DEFAULT,
                new com.minimalistalliance.desk.deskd.guild.GuildSessionLog.Commons() {
                    @Override
                    public long seconds(String sessionId) {
                        return commons.commonsSeconds(sessionId);
                    }

                    @Override
                    public long voiceBytes(String sessionId) {
                        return commons.voiceBytesSent(sessionId);
                    }

                    @Override
                    public void forget(String sessionId) {
                        commons.forget(sessionId);
                    }
                });
        guild.follow(link, heartbeat, rtc);
        notebook.editBudget(guild::effectiveEditBudget);
        guild.onEditBudgetChange(notebook::editBudgetChanged);
        return guild;
    }

    /**
     * Registers the data.* methods and serves bulk. The free-bytes file goes beside rtc.sock, so in /run/desk, where
     * desk-egress reads it, and the free budget's on the data volume, so a reboot can't refill it. Made before the
     * lifecycle starts, like the Browser's.
     */
    @Bean(destroyMethod = "")
    DataModule dataModule(
            SessionManager sessions,
            RpcDispatcher dispatcher,
            BrowserModule browser,
            DeskState state,
            DataVolume volume,
            Clock clock,
            Environment environment) {
        Path helperSocket = Path.of(environment.getProperty("deskd.data.socket", DEFAULT_DATA_SOCKET));
        Path rtcSocket = Path.of(environment.getProperty("deskd.rtc.socket", DEFAULT_RTC_SOCKET));
        DataModule data = new DataModule(
                sessions, dispatcher, browser, helperSocket, rtcSocket.resolveSibling(DataModule.FREE_BYTES_FILE),
                state::bootId, volume, clock, DataModule.Timing.DEFAULT);
        data.followStreamingPause(state.streamingPause());
        return data;
    }

    /**
     * The Files app: files.* over /data/files, which the image mounts into deskd's container (docs/decisions/0048-files-app.md,
     * decision 1). Settings: DESKD_FILES_ROOT; DESKD_FILES_IMAGE_GATE=stub on a rig or a test desk only (the stub token
     * {@code stub.<sha256>} then passes); DESKD_FILES_ALLOW_UNCHECKED (default true) for tokens whose state is
     * {@code unchecked}; DESKD_FILES_VERDICT_KEYS_FILE, a JWKS file to verify verdict tokens with instead of the desk's
     * cached keys, until the Platform serves them. Made before the lifecycle starts, like the data module.
     */
    @Bean
    FilesModule filesModule(
            SessionManager sessions,
            RpcDispatcher dispatcher,
            EventHub hub,
            DataModule data,
            JwksCache jwks,
            DeskState state,
            Clock clock,
            Environment environment) {
        String keys = environment.getProperty("deskd.files.verdict-keys-file");
        FilesModule.Settings defaults = FilesModule.Settings.defaults(Path.of(environment.getProperty("deskd.files.root", FilesModule.DEFAULT_ROOT)));
        FilesModule.Settings settings = new FilesModule.Settings(
                defaults.root(), defaults.uid(), defaults.floorBytes(), defaults.trashKeep(), defaults.partialKeep(), defaults.finishWait(),
                defaults.sweepEvery(),
                "stub".equalsIgnoreCase(environment.getProperty("deskd.files.image-gate", "")),
                Boolean.parseBoolean(environment.getProperty("deskd.files.allow-unchecked", "true")),
                keys == null || keys.isBlank() ? null : Path.of(keys));
        FilesModule files = new FilesModule(sessions, dispatcher, hub, data.transfers(), settings, jwks, state, state::guildDesk, clock);
        files.followStreamingPause(state.streamingPause());
        files.followTierLimits(state.tierLimits());
        return files;
    }

    /**
     * The desk app contract's base (API.md section 19): installs under /data/apps, the catalog, and the appApi relay to each
     * app's socket. Inert until an app is installed, and on a desk with no helper, no /data/apps or no review key nothing
     * can be; /data/desk/apps-switch turns it off. Registers its methods and topics now; reads the registry when the
     * lifecycle starts it.
     */
    @Bean(destroyMethod = "")
    AppsModule appsModule(
            RpcDispatcher dispatcher, EventHub hub, DeskState state, DataVolume volume, PlatformHttp http, Clock clock, Environment environment) {
        String keys = environment.getProperty("deskd.apps.keys", String.join(",", AppsModule.DEFAULT_KEY_DIRS));
        AppsModule.Settings settings = new AppsModule.Settings(
                Path.of(environment.getProperty("deskd.apps.root", AppsModule.DEFAULT_ROOT)),
                volume.directory(),
                java.util.Arrays.stream(keys.split(",")).map(String::trim).filter(k -> !k.isEmpty()).map(Path::of).toList(),
                Path.of(environment.getProperty("deskd.apps.socket", HelperAppHost.DEFAULT_SOCKET)),
                Path.of(environment.getProperty("deskd.apps.run", HelperAppHost.DEFAULT_APPS_RUN)));
        return AppsModule.forDesk(settings, dispatcher, hub, state::guildDesk, () -> {
            java.util.Map<String, Object> defaults = state.accountDefaults().current();
            return defaults == null || !(defaults.get("timeZone") instanceof String zone) ? null : zone;
        }, http, state::apiBase, clock);
    }

    /**
     * Signing in that works on the desk: browser.import of bookmarks from Files, a passwords file over the session into
     * memory only (browser.import.begin, its bytes on bulk, finish), browser.bookmarks.list and the key button's
     * browser.extension* methods (API.md section 10, "Signing in"). After both modules, as the Browser's import reads
     * Files and Files is made after the Browser; the passwords file's bytes come through the data module's transfer table,
     * which bulk is registered to. Refused on a desk that isn't an adult's.
     */
    @Bean
    BrowserSignInsWiring browserSignIns(BrowserModule browser, FilesModule files, DataModule data, AgeBand ageBand) {
        browser.enableSignIns(files.importFiles(), data.transfers(), ageBand::band);
        return new BrowserSignInsWiring();
    }

    /** Only says the sign-ins' methods are registered: a bean, so the methods exist before the lifecycle starts. */
    static final class BrowserSignInsWiring {}

    /**
     * The tools deskd runs for desk-agent's agents (draft ADR "the Agent's tools and approvals", API.md section 18):
     * Files, the Browser and Notebook, over the agent socket, as the agent's owner. On a guild desk, a member's own agent
     * runs as that member, from the roster, and gets Notebook only. Made before the lifecycle starts, so the first
     * connection's hello lists them.
     */
    @Bean(destroyMethod = "")
    ToolHost toolHost(
            AgentModule agent, DeskState state, GuildModule guild, AgeBand ageBand, FilesModule files, NotebookModule notebook,
            BrowserModule browser,
            Clock clock) {
        ToolHost host = new ToolHost(clock, agentId -> {
            if (!state.guildDesk()) {
                return Caller.THE_OWNER;
            }
            GuildRoster.Member member = agentId.startsWith("gm-") ? guild.roster().member(agentId) : null;
            if (member == null) {
                return agentId.startsWith("gm-") ? null : Caller.THE_OWNER;
            }
            return new Caller(Caller.GUILD_MEMBER, member.memberId(), member.role(),
                    Caller.effectiveGrants(member.role(), member.grants()), member.name(), member.badge(), member.teen());
        }, state::guildDesk, () -> ageBand.band() == AgeBand.Band.ADULT);
        // deskd's own record of the member's yeses: nothing that asks runs without one, redeemed once.
        host.tickets((approvalId, sha256, agentId, runId, tool, context, args) -> {
            var redeemed = agent.approvalTickets().redeem(approvalId, sha256, agentId, runId, tool, context, args);
            return redeemed.ok() ? null : redeemed.refusal().code();
        });
        host.area(HostedDecls.FILES, new FilesTools(files.agentAccess()));
        // As the member the agent works for, whom desk-notebook checks as it checks their own session.
        host.area(HostedDecls.NOTEBOOK, new NotebookTools(notebook.calls(), state::guildDesk));
        host.area(HostedDecls.BROWSER, new BrowserTools(browser.agentBrowser()));
        agent.hostTools(host);
        return host;
    }

    /**
     * /run/desk/idle.json for desk-batch: where each count comes from is in {@link IdleFile}. Made before the lifecycle
     * starts it, and told by the data module of the exports that begin and end.
     */
    @Bean(destroyMethod = "")
    IdleFile idleFile(
            SessionManager sessions, AgentModule agent, DataModule data, DeskState state, Clock clock, Environment environment) {
        Path file = Path.of(environment.getProperty("deskd.idle.file", DEFAULT_IDLE_FILE));
        IdleFile idle = new IdleFile(file, new IdleFile.Sources() {
            @Override
            public int sessions() {
                return sessions.connectedCount();
            }

            @Override
            public int agentTasks() {
                return agent.activeTasks();
            }

            @Override
            public int exports() {
                return data.exportsGoing();
            }

            @Override
            public int downloads() {
                // Only desk-units sees a Browser download, at the moment of a freeze (ADR 0045).
                return 0;
            }

            @Override
            public Long idleStopSeconds() {
                PlatformConfig config = state.config();
                return config == null || config.autoStopMinutes() == null ? null : config.autoStopMinutes() * 60L;
            }

            @Override
            public Instant lastInputAt() {
                return sessions.lastInputAt();
            }
        }, clock, IdleFile.EVERY);
        data.onExportsChange(idle::poke);
        return idle;
    }

    /** /health on the admin socket, and the heartbeat's {@code deskd} block, which says the same (ADR 0078, DE-2). */
    @Bean
    DeskdHealth deskdHealth(
            DataVolume volume,
            RtcClient rtc,
            GatewayLink link,
            BrowserModule browser,
            AgentModule agent,
            NotebookModule notebook,
            CommonsRelay commons,
            AppsModule apps,
            DeskState state,
            HeartbeatLoop heartbeat,
            Environment environment) {
        DeskdHealth health = new DeskdHealth(volume, rtc, link, browser, agent, notebook, commons, apps, state::guildDesk, version(environment));
        heartbeat.deskdFrom(health.version(), health::healthy);
        return health;
    }

    @Bean(destroyMethod = "")
    AdminServer adminServer(Environment environment, DeskdHealth health) {
        Path socket = Path.of(environment.getProperty("deskd.admin.socket", DEFAULT_ADMIN_SOCKET));
        return new AdminServer(socket, health);
    }

    @Bean
    DeskdLifecycle deskdLifecycle(
            AdminServer admin,
            RtcClient rtc,
            SessionManager sessions,
            Revocations revocations,
            BootSequence boot,
            HeartbeatLoop heartbeat,
            GatewayLink link,
            BrowserModule browser,
            AgentModule agent,
            ModelPrices prices,
            NotebookModule notebook,
            DataModule data,
            CommonsRelay commons,
            GuildModule guild,
            IdleFile idle,
            AppsModule apps) {
        return new DeskdLifecycle(
                admin, rtc, sessions, revocations, boot, heartbeat, link, browser, agent, prices, notebook, data, commons, guild, idle, apps);
    }

    static String version(Environment environment) {
        return environment.getProperty("deskd.version", "unknown");
    }
}
