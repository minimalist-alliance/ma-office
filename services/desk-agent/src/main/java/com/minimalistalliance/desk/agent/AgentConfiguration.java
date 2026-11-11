package com.minimalistalliance.desk.agent;

import com.minimalistalliance.desk.agent.admin.AdminServer;
import com.minimalistalliance.desk.agent.attach.Parsers;
import com.minimalistalliance.desk.agent.attach.Preparer;
import com.minimalistalliance.desk.agent.attach.Staging;
import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.key.KeyRing;
import com.minimalistalliance.desk.agent.key.KeyVault;
import com.minimalistalliance.desk.agent.limits.LimitSettings;
import com.minimalistalliance.desk.agent.limits.PriceTable;
import com.minimalistalliance.desk.agent.limits.Pricing;
import com.minimalistalliance.desk.agent.limits.UsageLedger;
import com.minimalistalliance.desk.agent.llm.LlmGateway;
import com.minimalistalliance.desk.agent.manager.ManagerAgent;
import com.minimalistalliance.desk.agent.provider.ProviderRegistry;
import com.minimalistalliance.desk.agent.provider.anthropic.AnthropicProvider;
import com.minimalistalliance.desk.agent.provider.http.HttpTransport;
import com.minimalistalliance.desk.agent.provider.openai.OpenAiResponsesProvider;
import com.minimalistalliance.desk.agent.provider.openrouter.OpenRouterProvider;
import com.minimalistalliance.desk.agent.service.AgentService;
import com.minimalistalliance.desk.agent.service.TopicHub;
import com.minimalistalliance.desk.agent.socket.AgentSocketServer;
import com.minimalistalliance.desk.agent.socket.PeerCheck;
import com.minimalistalliance.desk.agent.store.AgentStore;
import java.net.InetSocketAddress;
import java.nio.file.Path;
import java.time.Clock;
import com.minimalistalliance.desk.agent.store.TeamStore;
import com.minimalistalliance.desk.agent.team.Team;
import com.minimalistalliance.desk.agent.workspace.Workspaces;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;

/**
 * Wires desk-agent by hand. What varies is read from desk-agent.env (root-owned) when the beans are made: paths
 * (DESK_AGENT_DATA_DIR, DESK_AGENT_ADMIN_SOCKET, DESK_AGENT_SOCKET), deskd's uid (DESK_AGENT_PEER_UID), the
 * providers' base URLs (DESK_AGENT_ANTHROPIC_URL, DESK_AGENT_OPENAI_URL, DESK_AGENT_XAI_URL,
 * DESK_AGENT_OPENROUTER_URL; https, or http to loopback for a stand-in) and deskd's egress proxy (DESK_AGENT_EGRESS_PROXY). DESK_AGENT_VERSION comes from the
 * image. Beans that hold files or sockets are opened and closed by {@link DeskAgentLifecycle}.
 */
@Configuration(proxyBeanMethods = false)
class AgentConfiguration {

    static final String DEFAULT_DATA_DIR = "/data/agent";
    static final String DEFAULT_ADMIN_SOCKET = "/run/desk-agent/agent-admin.sock";
    static final String DEFAULT_AGENT_SOCKET = "/run/desk-agent/agent.sock";
    static final int DESKD_UID = 1100;

    @Bean
    Clock clock() {
        return Clock.systemUTC();
    }

    @Bean
    DataDirectory dataDirectory(Environment environment) {
        return new DataDirectory(Path.of(environment.getProperty("desk.agent.data.dir", DEFAULT_DATA_DIR)));
    }

    @Bean(destroyMethod = "")
    AuditLog auditLog(DataDirectory data, Clock clock) {
        return new AuditLog(data.resolve("audit.db"), clock);
    }

    @Bean(destroyMethod = "")
    UsageLedger usageLedger(DataDirectory data, Clock clock, LimitSettings limits) {
        return new UsageLedger(data.resolve("usage.db"), clock, limits::zone);
    }

    /** The bundled file, until deskd pushes the Platform's (ADR 0043). */
    @Bean
    PriceTable priceTable() {
        return new PriceTable(Pricing.bundled());
    }

    @Bean(destroyMethod = "")
    KeyRing keyRing(AuditLog audit) {
        // A key is added and deleted by the member; all are zeroed by the system on the way out.
        return new KeyRing((action, target, decision) -> audit.append(AuditLog.Entry.of(
                target.equals("keys:all") ? "system" : "user", action, target, decision)));
    }

    /** Touches nothing until {@link AgentService#restore} prepares it. */
    @Bean
    KeyVault keyVault(DataDirectory data) {
        return new KeyVault(data.resolve("keys"));
    }

    @Bean
    HttpTransport httpTransport(Environment environment) {
        String proxy = environment.getProperty("desk.agent.egress.proxy", "");
        InetSocketAddress address = null;
        if (!proxy.isBlank()) {
            int colon = proxy.lastIndexOf(':');
            if (colon < 1) {
                throw new IllegalArgumentException("DESK_AGENT_EGRESS_PROXY is host:port");
            }
            address = InetSocketAddress.createUnresolved(proxy.substring(0, colon),
                    Integer.parseInt(proxy.substring(colon + 1)));
        }
        return new HttpTransport(HttpTransport.Timeouts.DEFAULT, address);
    }

    /** Anthropic, OpenAI, xAI and OpenRouter, in the order agent.providers lists them. */
    @Bean
    ProviderRegistry providerRegistry(HttpTransport http, Environment environment) {
        ProviderRegistry registry = new ProviderRegistry();
        registry.register(new AnthropicProvider(http, HttpTransport.baseUri(
                environment.getProperty("desk.agent.anthropic.url", "https://api.anthropic.com"))));
        registry.register(new OpenAiResponsesProvider(OpenAiResponsesProvider.OPENAI, http, HttpTransport.baseUri(
                environment.getProperty("desk.agent.openai.url", "https://api.openai.com"))));
        registry.register(new OpenAiResponsesProvider(OpenAiResponsesProvider.XAI, http, HttpTransport.baseUri(
                environment.getProperty("desk.agent.xai.url", "https://api.x.ai"))));
        registry.register(new OpenRouterProvider(http, HttpTransport.baseUri(
                environment.getProperty("desk.agent.openrouter.url", "https://openrouter.ai"))));
        return registry;
    }

    @Bean(destroyMethod = "")
    AgentStore agentStore(DataDirectory data, Clock clock) {
        return new AgentStore(data.resolve("agent.db"), clock);
    }

    @Bean
    TopicHub topicHub() {
        return new TopicHub();
    }

    /** Files being attached, in memory only (ADR 0049). Closing it zeroes them. */
    @Bean
    Staging attachStaging(Clock clock) {
        return new Staging(clock, AgentService.STAGING_BYTES);
    }

    /** Reads a file in a child JVM (ADR 0049). */
    @Bean
    Parsers attachParsers() {
        return new Parsers(AgentService.PARSE_SECONDS);
    }

    @Bean
    AgentService agentService(AgentStore store, ManagerAgent manager, KeyRing keys, KeyVault vault,
            ProviderRegistry providers, PriceTable prices, LimitSettings limits, UsageLedger ledger, AuditLog audit,
            TopicHub topics, Clock clock, Team team, Staging staging, Parsers parsers) {
        return new AgentService(store, manager, keys, vault, providers, prices, limits, ledger, audit, topics, clock,
                team, staging, new Preparer(parsers));
    }

    /** Task 49's agents (ADR 0047): their workspaces under {@code workspaces/}, uploaded icons under {@code icons/}. */
    @Bean(destroyMethod = "")
    Team team(AgentStore store, LimitSettings limits, AuditLog audit, DataDirectory data, Clock clock) {
        return new Team(store, new TeamStore(store), limits, audit,
                new Workspaces(data.resolve("workspaces"), Team.MIN_FREE_BYTES), data.resolve("icons"), clock);
    }

    /**
     * The agent socket, which is also the way to the tools deskd runs (the tools and approvals draft, section 11).
     * {@code desk.agent.tools.off} ({@code DESK_AGENT_TOOLS_OFF}) switches tools off by name: they're neither offered
     * nor run. It can do nothing else: no class, scope or approval is a setting.
     */
    @Bean(destroyMethod = "")
    AgentSocketServer agentSocketServer(AgentService service, TopicHub topics, Environment environment) {
        AgentSocketServer server = new AgentSocketServer(
                Path.of(environment.getProperty("desk.agent.socket", DEFAULT_AGENT_SOCKET)),
                new PeerCheck(environment.getProperty("desk.agent.peer.uid", Integer.class, DESKD_UID)),
                service, topics);
        service.agentTools().registry().switchOff(com.minimalistalliance.desk.agent.tool.ToolRegistry.parseOff(
                environment.getProperty("desk.agent.tools.off", "")));
        service.deskLink(server);
        return server;
    }

    @Bean
    LlmGateway llmGateway(
            ProviderRegistry providers, KeyRing keys, PriceTable prices, UsageLedger ledger, AuditLog audit) {
        return new LlmGateway(providers, keys, prices, ledger, audit);
    }

    @Bean
    LimitSettings limitSettings() {
        return new LimitSettings();
    }

    @Bean
    ManagerAgent managerAgent(LlmGateway gateway, KeyRing keys, LimitSettings limits, Clock clock) {
        return new ManagerAgent(gateway, keys, limits, clock);
    }

    @Bean
    DeskAgentHealth deskAgentHealth(
            DataDirectory data, AuditLog audit, UsageLedger ledger, AgentStore store, ManagerAgent manager,
            KeyRing keys, AgentSocketServer socket, Environment environment) {
        return new DeskAgentHealth(data, audit, ledger, store, manager, keys, socket, version(environment));
    }

    @Bean(destroyMethod = "")
    AdminServer adminServer(DeskAgentHealth health, Environment environment) {
        return new AdminServer(
                Path.of(environment.getProperty("desk.agent.admin.socket", DEFAULT_ADMIN_SOCKET)), health);
    }

    @Bean
    ReadinessReporter readinessReporter() {
        return new ReadinessReporter();
    }

    @Bean
    DeskAgentLifecycle deskAgentLifecycle(
            AdminServer admin, DataDirectory data, AuditLog audit, UsageLedger ledger, AgentStore store,
            AgentService service, AgentSocketServer socket, KeyRing keys, Environment environment) {
        return new DeskAgentLifecycle(admin, data, audit, ledger, store, service, socket, keys, version(environment));
    }

    static String version(Environment environment) {
        return environment.getProperty("desk.agent.version", "unknown");
    }
}
