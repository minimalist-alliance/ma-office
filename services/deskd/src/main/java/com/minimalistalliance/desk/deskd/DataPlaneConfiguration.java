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
import com.minimalistalliance.desk.deskd.courier.CourierModule;
import com.minimalistalliance.desk.deskd.courier.CourierSwitch;
import com.minimalistalliance.desk.deskd.courier.keys.DeskKeys;
import com.minimalistalliance.desk.deskd.courier.keys.PlatformKeyPublisher;
import com.minimalistalliance.desk.deskd.courier.imsg.ImsgSink;
import com.minimalistalliance.desk.deskd.courier.imsg.ImsgTransport;
import com.minimalistalliance.desk.deskd.courier.imsg.connector.ConnectorLinks;
import com.minimalistalliance.desk.deskd.courier.imsg.connector.ConnectorPath;
import com.minimalistalliance.desk.deskd.courier.imsg.bluebubbles.BlueBubblesPath;
import com.minimalistalliance.desk.deskd.courier.linked.LinkedMailboxes;
import com.minimalistalliance.desk.deskd.courier.relay.PlatformCourierSend;
import com.minimalistalliance.desk.deskd.courier.relay.PlatformRelayApi;
import com.minimalistalliance.desk.deskd.courier.relay.RelayTransport;
import com.minimalistalliance.desk.deskd.courier.linked.Net;
import com.minimalistalliance.desk.deskd.courier.parse.CourierParser;
import com.minimalistalliance.desk.deskd.courier.parse.CourierSandbox;
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
import com.minimalistalliance.desk.deskd.tools.CourierTools;
import com.minimalistalliance.desk.deskd.tools.TodoTools;
import com.minimalistalliance.desk.deskd.tools.ToolHost;
import com.minimalistalliance.desk.deskd.desks.DeskMessaging;
import com.minimalistalliance.desk.deskd.desks.DeskTools;
import com.minimalistalliance.desk.deskd.todo.TodoModule;
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
 * debugging port, with DESKD_CDP_UID for who has to hold it, DESKD_IDLE_FILE for the idle file, DESKD_LINKS_SOCKET for
 * where the xdg-open stand-in hands deskd the links Chromium gives the OS, and DESKD_PORTAL_URL for where a visit to the
 * office in the Browser goes. The apps' paths: DESKD_APPS_ROOT,
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
        browser.followAgeBand(ageBand, state.bootId());
        // The office's easter egg, on in every band and on every host: a visit to the office in the Browser lands on the portal,
        // by the Env tag, unless DESKD_PORTAL_URL says off. The image's policy still blocks the office (API.md section 10).
        browser.redirectOfficeTo(environment.getProperty("deskd.portal.url"), () -> {
            com.minimalistalliance.desk.deskd.imds.InstanceIdentity identity = state.identity();
            return identity == null ? null : identity.env();
        });
        // Per-site memory for the simplified view lives on the data volume, beside the desk's other state (task 47).
        // Off on every desk until /data/desk/minified-switch says on, read at run time (API.md section 14).
        browser.enableMinified(volume.directory());
        // Links Chromium hands the OS, from the image's xdg-open stand-in, which runs as Chromium's user (API.md section 10).
        // No directory, as on an image without the stand-in, and it's simply not served.
        browser.serveLinks(Path.of(environment.getProperty("deskd.links.socket", DEFAULT_LINKS_SOCKET)), cdpUid);
        // Finished features ship on: /data/desk/protected-media-switch can only turn the DRM note off (API.md section 10).
        browser.followProtectedMediaSwitch(volume.directory());
        // The Browser's zoom, kept beside the desk's other state and set as Chromium's own default zoom (API.md section 10).
        browser.enableZoom(volume.directory());
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
            PlatformHttp http,
            com.minimalistalliance.desk.deskd.aws.RoleCredentials credentials,
            Environment environment) {
        Path socket = Path.of(environment.getProperty("deskd.agent.socket", DEFAULT_AGENT_SOCKET));
        AgentModule agent = new AgentModule(socket, dispatcher, hub, state::deskId, clock, ageBand);
        // Maia Mode is never turned on on a free member's desk (API.md §23): the config's tierLimits say which.
        agent.freeDesk(() -> state.tierLimits().current() != null);
        // Desk Maia's model (API.md §23, "Her model"): every call relayed to her service on Minimalist Alliance's AI account,
        // as the desk role, while the config names it; refused by deskd's own facts first (Guild Desk, band, tier).
        agent.maiaModel(new com.minimalistalliance.desk.deskd.agent.MaiaModel(
                new com.minimalistalliance.desk.deskd.platform.DeskMaiaClient(http,
                        com.minimalistalliance.desk.deskd.platform.DeskMaiaClient.RoleKeys.of(credentials),
                        () -> com.minimalistalliance.desk.deskd.platform.DeskMaiaClient.Endpoint.of(state.config()), clock),
                state::guildDesk, () -> ageBand.band() == AgeBand.Band.ADULT, () -> state.tierLimits().current() != null));
        // Helpers on MA's credits (API.md §24): the same service and proof, other routes; refused by deskd's own facts first.
        agent.helperModel(new com.minimalistalliance.desk.deskd.agent.HelperModel(
                new com.minimalistalliance.desk.deskd.platform.DeskMaiaClient(http,
                        com.minimalistalliance.desk.deskd.platform.DeskMaiaClient.RoleKeys.of(credentials),
                        () -> com.minimalistalliance.desk.deskd.platform.DeskMaiaClient.Endpoint.of(state.config()), clock),
                state::guildDesk, () -> ageBand.band() == AgeBand.Band.ADULT));
        state.onConfig(config -> agent.maiaServiceChanged());
        state.accountDefaults().keepIn(volume.directory().resolve(AccountDefaults.FILE));
        // deskd's own copy of each agent's access, which the tools deskd runs check (API.md section 18).
        agent.keepAccessIn(volume.directory());
        // Messages between the member's desks (draft ADR section 14): this desk's keys and its own record of the
        // grants' halves, in /data/desk, and the client's agent.desks.*. Never on a Guild Desk.
        DeskMessaging desks = new DeskMessaging(clock, state::deskId, state::userId, state::guildDesk);
        desks.keepIn(volume.directory());
        agent.desks(desks, state::guildDesk);
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
            RtcClient rtc,
            AppsModule apps) {
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
        // A removed member's data goes from every app too, on the purges' own guard (API.md section 19, "Members leaving").
        apps.guildMembers(guild.roster().appMembers());
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
     * Courier (draft ADR "Courier's store", API.md section 21): the store in /data/courier (DESKD_COURIER_ROOT), the
     * courier.* methods, the topic courier.changed, the outbound queue and retention's sweep. On, with its kill switch in
     * deskd's directory on the volume (/data/desk/courier-switch). Refused on a guild desk and a teen's. With no
     * /data/courier on the image, every call answers unavailable with reason store. Mail is read by desk-parse's Courier
     * mode over its socket (DESKD_COURIER_PARSE_SOCKET, CourierSandbox; the launch plan's Wave 1.2): with no sandbox there
     * yet (an image before it), an email waits as pending, raw bytes kept, and is read once it answers. Linked mailboxes
     * over IMAP and SMTP (Wave 2.1, courier.linked) are attached here: their syncs, the sign-in check and their senders,
     * stopped before the store closes; switched off by imap-off (or email-off), their sending by imap-send-off. The desk's
     * own keys (Wave 1.4) are in /data/keys (DESKD_COURIER_KEYS), published to the platform's key directory at start and
     * after a rotation; with no /data/keys on the image, member messages and the mail door are unavailable. Attachments
     * (Wave 3.1) are cut out by the same sandbox and saved through Files' door (FilesModule) or sent on bulk (DataModule's
     * transfers), refused while the Platform pauses the member at a bandwidth limit. The learning filter (Wave 3.2) has its
     * kill switch as filter-off in the same file. The relay's
     * transports (Wave 2.5, courier.relay) collect the mail door's mail and members' sealed messages at start, on notify
     * relay and every 10 minutes, never waking a desk, and send members' messages sealed and the desk's address's mail
     * through courier-send; switched off by ma-off and door-off. iMessage and iPhone texts through the member's own Mac
     * (Wave 2.6, courier.imsg) sit behind one transport for every path to a Mac (the imsg seam): BlueBubbles Server here,
     * reached out from the desk at the address the member gave, its address and password sealed; MA's Mac connector
     * registers its own path. Switched off by imessage-off, its sending by imessage-send-off.
     */
    /**
     * The parse sandbox deskd reaches (ADR 0097, desk-parse's Courier mode on DESKD_COURIER_PARSE_SOCKET): one request at a
     * time, shared by Courier's mail and Documents' pages (the documents mode, API.md §25).
     */
    @Bean
    CourierSandbox courierSandbox(Environment environment) {
        return new CourierSandbox(CourierSandbox.Settings.defaults(
                Path.of(environment.getProperty("deskd.courier.parse-socket", CourierSandbox.DEFAULT_SOCKET))));
    }

    @Bean(destroyMethod = "close")
    CourierModule courierModule(
            RpcDispatcher dispatcher, EventHub hub, DeskState state, AgeBand ageBand, DataVolume volume, Clock clock, Environment environment,
            AgentClient platform, PlatformHttp http, GatewayLink link, FilesModule files, DataModule data, CourierSandbox sandbox) {
        CourierModule.Settings defaults = CourierModule.Settings.defaults(
                Path.of(environment.getProperty("deskd.courier.root", CourierModule.DEFAULT_ROOT)), volume.directory());
        CourierModule.Settings settings = new CourierModule.Settings(defaults.root(), defaults.switchDirectory(),
                Boolean.parseBoolean(environment.getProperty("deskd.courier.agents-see-other", "true")), defaults.sweepEvery(),
                defaults.store());
        CourierParser parser = sandbox;
        DeskKeys.Settings keys = DeskKeys.Settings.defaults(Path.of(environment.getProperty("deskd.courier.keys", DeskKeys.DEFAULT_DIRECTORY)));
        CourierModule courier = new CourierModule(dispatcher, hub, settings, parser, new CourierSwitch(settings.switchDirectory()),
                state::guildDesk, ageBand::band, clock, keys, new PlatformKeyPublisher(platform));
        new LinkedMailboxes(courier, Net.strict(), clock, LinkedMailboxes.Settings.DEFAULT).start();
        // iMessage through the member's Mac (Wave 2.6): the imsg seam, with BlueBubbles Server as one path and MA Connector
        // for Mac (a paired device, through the sealed relay; relay.md 0.4.3) as the other.
        PlatformRelayApi relayApi = new PlatformRelayApi(platform, http);
        ConnectorLinks macs = new ConnectorLinks(courier, relayApi, clock, ConnectorPath.Settings.DEFAULT);
        ImsgTransport imsg = new ImsgTransport(courier, clock, ImsgSink.Settings.DEFAULT, java.time.Duration.ofSeconds(30))
                .register(BlueBubblesPath.PATH, BlueBubblesPath.factory(Net.strict(), BlueBubblesPath.Settings.DEFAULT),
                        BlueBubblesPath.prober(Net.strict(), BlueBubblesPath.Settings.DEFAULT))
                .register(ConnectorPath.PATH, macs.factory(), null);
        macs.transport(imsg).registerMethods(dispatcher);
        imsg.start();
        // Attachments (Wave 3.1): Save to Files through Files' own door; Download, previews and the raw message on bulk.
        courier.attachmentsThrough(files.agentAccess(), data.transfers(), state.streamingPause()::pausedUntil);
        // The relay's transports (Wave 2.5): the desk's address through the mail door and courier-send, and members' sealed
        // messages; collected at start, on notify relay, and every 10 minutes. Never wakes a desk.
        // A message over 4 MiB goes up to the door first, through the relay's own drop uploader (contract 0.4.1).
        RelayTransport relay = new RelayTransport(courier, relayApi, new PlatformCourierSend(platform, relayApi::upload, () -> true),
                clock, RelayTransport.Settings.DEFAULT).devicesThrough(macs).start(dispatcher);
        macs.drainWith(relay::drainSoon);
        link.onRelay(relay::notify);
        return courier;
    }

    /**
     * Documents (API.md section 25, the draft ADR "Documents"): the index /data/desk/docs.db with its caches, the docs.*
     * methods, the topic docs, the intake from Files and Courier's accepted attachments (one file at a time through the
     * parse sandbox's documents mode, the first index only while the Browser isn't in use), pages on bulk, and what Desk
     * Maia's document tools read (DocsTools, in toolHost). On, with its kill switch beside it (/data/desk/docs-switch).
     * Refused on a guild desk. Dates are the member's, in the account's time zone, UTC until one is known.
     */
    @Bean(destroyMethod = "close")
    com.minimalistalliance.desk.deskd.docs.DocsModule docsModule(RpcDispatcher dispatcher, EventHub hub, DeskState state,
            DataVolume volume, DataModule data, FilesModule files, CourierModule courier, CourierSandbox sandbox,
            BrowserModule browser, TodoModule todo, AgentModule agent, AgeBand ageBand, NotebookModule notebook, Clock clock) {
        com.minimalistalliance.desk.deskd.docs.DocsModule docs = new com.minimalistalliance.desk.deskd.docs.DocsModule(dispatcher, hub,
                volume.directory(), files.docsAccess(), com.minimalistalliance.desk.deskd.docs.DocsModule.sandbox(sandbox),
                state::guildDesk, () -> !browser.browserFrozen() && !browser.chromiumRefused(), () -> {
                    java.util.Map<String, Object> defaults = state.accountDefaults().current();
                    if (defaults == null || !(defaults.get("timeZone") instanceof String zone)) {
                        return null;
                    }
                    try {
                        return java.time.ZoneId.of(zone);
                    } catch (java.time.DateTimeException e) {
                        return null;
                    }
                }, clock);
        docs.pagesThrough(data.transfers(), state.streamingPause()::pausedUntil);
        docs.courier(com.minimalistalliance.desk.deskd.docs.CourierDocs.of(courier, sandbox));
        if (courier.store() != null) {
            courier.store().onChange(change -> docs.courierChanged());
        }
        docs.todos(com.minimalistalliance.desk.deskd.docs.TodoDocs.of(todo));
        // Notebook's pages (deskd's own calls to desk-notebook, as the owner; reads only) and Desk Maia's write-ups kept on
        // this desk (desk-agent's, over deskd's own link): looked at every 5 minutes, and when Notebook's tree changes.
        docs.notebook(com.minimalistalliance.desk.deskd.docs.NotebookDocs.of(notebook.calls()));
        notebook.onTreeChanged(docs::sourcesChanged);
        docs.writeups(com.minimalistalliance.desk.deskd.docs.WriteupDocs.of(agent::docsWriteups));
        // The reader, through desk-agent, only where Desk Maia is on (deskd's own record) and never on a teen's desk.
        docs.readerThrough(agent::docsRead, () -> ageBand.band() == AgeBand.Band.ADULT && agent.maiaRecord() != null
                && agent.maiaRecord().on());
        docs.start();
        return docs;
    }

    /**
     * To-do (API.md section 22, the To-do VISION): the store /data/desk/todo.db, the todo.* methods, the topic todo, the
     * nightly tidy and the export on bulk, and the store the agent's todo_* tools use (TodoTools, in toolHost). On, with
     * its kill switch beside it (/data/desk/todo-switch). Refused on a guild desk; a teen's desk has it, with the Agent
     * off. Dates are the member's, in the account's time zone, UTC until one is known.
     */
    @Bean(destroyMethod = "close")
    TodoModule todoModule(RpcDispatcher dispatcher, EventHub hub, DeskState state, DataVolume volume, DataModule data,
            Clock clock) {
        TodoModule todo = new TodoModule(dispatcher, hub, volume.directory(), state::guildDesk, () -> {
            java.util.Map<String, Object> defaults = state.accountDefaults().current();
            if (defaults == null || !(defaults.get("timeZone") instanceof String zone)) {
                return null;
            }
            try {
                return java.time.ZoneId.of(zone);
            } catch (java.time.DateTimeException e) {
                return null;
            }
        }, clock);
        todo.exportsThrough(data.transfers());
        return todo;
    }

    /**
     * The desk app contract's base (API.md section 19): installs under /data/apps, the catalog, and the appApi relay to each
     * app's socket. Inert until an app is installed, and on a desk with no helper, no /data/apps or no review key no catalog
     * app can be; the first-party apps bundled in the image (/app/bundled-apps) install and run without them, kept in
     * /data/desk/apps. /data/desk/apps-switch turns it all off. Registers its methods and topics now; reads the registries
     * when the lifecycle starts it.
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
                Path.of(environment.getProperty("deskd.apps.run", HelperAppHost.DEFAULT_APPS_RUN)),
                Path.of(environment.getProperty("deskd.apps.bundled", AppsModule.DEFAULT_BUNDLED)),
                Path.of(environment.getProperty("deskd.apps.bundled.run", AppsModule.DEFAULT_BUNDLED_RUN)));
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
            BrowserModule browser, TodoModule todo, CourierModule courier, DataVolume volume,
            Clock clock, com.minimalistalliance.desk.deskd.docs.DocsModule docs) {
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
        // deskd's own record of each agent's access: nothing runs for an agent the member hasn't set up, or in an app
        // they switched off for it, whatever desk-agent says (draft ADR section 16).
        host.agentApps(agent.accessRecord());
        // The same record answers the auto-approve switches and their places (ToolHost.requireAuto; draft ADR §15): none
        // acts on a Guild Desk. deskd's own ledger of the calls done without asking (ids once, the counts, what each made
        // for its undo) is kept beside it on /data/desk, its day by the account's zone.
        agent.accessRecord().guildDesk(state::guildDesk);
        host.access(agent.accessRecord());
        host.autoLedger().zone(() -> {
            java.util.Map<String, Object> defaults = state.accountDefaults().current();
            try {
                return defaults != null && defaults.get("timeZone") instanceof String zone
                        ? java.time.ZoneId.of(zone) : java.time.ZoneOffset.UTC;
            } catch (java.time.DateTimeException e) {
                return java.time.ZoneOffset.UTC;
            }
        });
        host.autoLedger().keepIn(volume.directory());
        // deskd's own record of the member's yeses: nothing that asks runs without one, redeemed once.
        host.tickets((approvalId, sha256, agentId, runId, tool, context, args) -> {
            var redeemed = agent.approvalTickets().redeem(approvalId, sha256, agentId, runId, tool, context, args);
            return redeemed.ok() ? null : redeemed.refusal().code();
        });
        // An agent's write is heard by Documents, so its next version is that agent's ("Made for you by", API.md §25).
        host.area(HostedDecls.FILES, new FilesTools(files.agentAccess()).onWrite((path, agentId) -> docs.agentWrote(path, agentId,
                agent.agentName(agentId))));
        // As the member the agent works for, whom desk-notebook checks as it checks their own session.
        host.area(HostedDecls.NOTEBOOK, new NotebookTools(notebook.calls(), state::guildDesk));
        host.area(HostedDecls.BROWSER, new BrowserTools(browser.agentBrowser()));
        // desk_message and desk_answer: an envelope each, sealed here, on a grant deskd's own record holds.
        if (agent.deskMessaging() != null) {
            // Desk Maia's briefs also go by deskd's own record of her grants (Maia Mode, API.md §23).
            host.area(HostedDecls.DESKS, new DeskTools(agent.deskMessaging(), agent::agentName)
                    .maia(agent.maiaRecord()));
            // To-do's source kind desk: a message given to a run, by deskd's own record (API.md §22).
            agent.deskMessaging().sources().runs(host.ledger()::find);
            host.origins(agent.deskMessaging().sources()::origin);
        }
        // To-do, on the desk's own store; offered while it's there and switched on (API.md section 22).
        host.area(HostedDecls.TODO, new TodoTools(todo::store));
        // Documents: Desk Maia's index tools, hers alone and only while deskd's record has Maia Mode on (API.md section 25).
        host.area(HostedDecls.DOCS, new com.minimalistalliance.desk.deskd.tools.DocsTools(() -> docs, () -> agent.maiaRecord() != null
                && agent.maiaRecord().on() && ageBand.band() == AgeBand.Band.ADULT, state::deskId));
        // Courier, read only (the draft ADR's §12, API.md section 21): offered only while Courier's store is there and on,
        // in the member's zone. Its cursor for a deleted agent goes with the agent's record.
        host.area(HostedDecls.COURIER, new CourierTools(courier::read, () -> {
            java.util.Map<String, Object> defaults = state.accountDefaults().current();
            try {
                return defaults != null && defaults.get("timeZone") instanceof String zone ? java.time.ZoneId.of(zone) : null;
            } catch (java.time.DateTimeException e) {
                return null;
            }
        }, clock));
        agent.accessRecord().onForget(agentId -> {
            try {
                courier.read().forgetCursor(agentId);
            } catch (Exception e) {
                // A cursor left behind is an agent id and a message id, read by no one.
            }
        });
        // deskd's own record of the runs the member started with their own message: attended, for To-do's policy, and
        // the agent_chat source (the relayed agent.message.send and desk-agent's answer).
        agent.onMemberRun(host.ledger()::memberStarted);
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
