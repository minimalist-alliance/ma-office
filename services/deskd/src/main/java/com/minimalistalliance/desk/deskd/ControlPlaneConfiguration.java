package com.minimalistalliance.desk.deskd;

import com.minimalistalliance.desk.deskd.agent.AgentModule;
import com.minimalistalliance.desk.deskd.auth.DeskTokenVerifier;
import com.minimalistalliance.desk.deskd.auth.JwksCache;
import com.minimalistalliance.desk.deskd.auth.Revocations;
import com.minimalistalliance.desk.deskd.aws.RoleCredentials;
import com.minimalistalliance.desk.deskd.boot.BootSequence;
import com.minimalistalliance.desk.deskd.browser.BrowserModule;
import com.minimalistalliance.desk.deskd.data.DataModule;
import com.minimalistalliance.desk.deskd.gateway.GatewayLink;
import com.minimalistalliance.desk.deskd.imds.ImdsClient;
import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.platform.AgentClient;
import com.minimalistalliance.desk.deskd.platform.DataVolume;
import com.minimalistalliance.desk.deskd.platform.DeskState;
import com.minimalistalliance.desk.deskd.platform.HeartbeatLoop;
import com.minimalistalliance.desk.deskd.platform.ModelPrices;
import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import com.minimalistalliance.desk.deskd.session.SessionManager;
import java.nio.file.Path;
import java.time.Clock;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;

/**
 * Wires the desk-to-Platform control plane and the token verifier by hand. There's one auth path and
 * no switch to turn it off. Only endpoints vary by environment, read from deskd.env (root-owned) when
 * the beans are made, so a stand-in can take Platform's place: DESKD_IMDS_URL, DESKD_API_URL,
 * DESKD_JWKS_URL. DESKD_DATA_DIR and DESKD_IMAGE_VERSION are the other two settings.
 */
@Configuration(proxyBeanMethods = false)
class ControlPlaneConfiguration {

    private static final String DEFAULT_IMDS_URL = "http://169.254.169.254";
    /** Where the image's boot unit writes its one reading of the DeskKind tag (DESKD_DESK_KIND_FILE to move it). */
    private static final String DEFAULT_DESK_KIND_FILE = "/run/ma/desk-kind";
    private static final String DEFAULT_DATA_DIR = "/data/desk";

    @Bean
    Clock clock() {
        return Clock.systemUTC();
    }

    @Bean
    PlatformHttp platformHttp() {
        return new PlatformHttp();
    }

    @Bean
    DeskState deskState(Environment environment) {
        return new DeskState(
                DeskState.readBootId(),
                environment.getProperty("deskd.api.url"),
                environment.getProperty("deskd.jwks.url"));
    }

    @Bean
    DataVolume dataVolume(Environment environment) {
        return new DataVolume(Path.of(environment.getProperty("deskd.data.dir", DEFAULT_DATA_DIR)));
    }

    /** Beside deskd's other state, on the data volume: a root unit in the image reads it before Chromium starts. */
    @Bean
    AgeBand ageBand(DataVolume volume) {
        return new AgeBand(volume.directory().resolve(AgeBand.FILE));
    }

    @Bean
    ImdsClient imdsClient(PlatformHttp http, Environment environment) {
        return new ImdsClient(http, environment.getProperty("deskd.imds.url", DEFAULT_IMDS_URL),
                Path.of(environment.getProperty("deskd.desk-kind.file", DEFAULT_DESK_KIND_FILE)));
    }

    @Bean
    RoleCredentials roleCredentials(ImdsClient imds, Clock clock) {
        return new RoleCredentials(imds, clock);
    }

    @Bean
    JwksCache jwksCache(PlatformHttp http, DeskState state, Clock clock) {
        return new JwksCache(http, state::jwksUrl, clock);
    }

    @Bean
    Revocations revocations(Clock clock) {
        return new Revocations(clock);
    }

    @Bean
    DeskTokenVerifier deskTokenVerifier(DeskState state, JwksCache jwks, Revocations revocations, Clock clock) {
        return new DeskTokenVerifier(state, jwks, revocations, clock);
    }

    @Bean
    AgentClient agentClient(PlatformHttp http, RoleCredentials credentials, DeskState state, Clock clock) {
        return new AgentClient(http, credentials, state::apiBase, clock);
    }

    @Bean(destroyMethod = "")
    ModelPrices modelPrices(PlatformHttp http, DeskState state, DataVolume volume) {
        return new ModelPrices(http, state::apiBase, volume.directory(), ModelPrices.Timing.DEFAULT);
    }

    @Bean(destroyMethod = "")
    BootSequence bootSequence(
            ImdsClient imds,
            DeskState state,
            RtcClient rtc,
            SessionManager sessions,
            AgentClient agent,
            JwksCache jwks,
            DataVolume volume,
            AgeBand ageBand,
            Environment environment) {
        return new BootSequence(
                imds, state, rtc, sessions, agent, jwks, volume, ageBand,
                DataPlaneConfiguration.version(environment),
                environment.getProperty("deskd.image.version"),
                BootSequence.Timing.DEFAULT);
    }

    @Bean(destroyMethod = "")
    HeartbeatLoop heartbeatLoop(
            AgentClient agent,
            DeskState state,
            SessionManager sessions,
            RtcClient rtc,
            DataVolume volume,
            BrowserModule browser,
            AgentModule agentModule,
            DataModule data,
            Revocations revocations,
            BootSequence boot,
            Clock clock) {
        HeartbeatLoop heartbeat = new HeartbeatLoop(
                agent, state, sessions, rtc, volume, browser::chromiumRefused, agentModule::heartbeatFields, data::freeBytesSent,
                revocations, boot, clock, HeartbeatLoop.Timing.DEFAULT);
        heartbeat.browserFrozenFrom(browser::browserFrozen);
        return heartbeat;
    }

    @Bean(destroyMethod = "")
    GatewayLink gatewayLink(
            PlatformHttp http,
            RoleCredentials credentials,
            DeskState state,
            SessionManager sessions,
            Revocations revocations,
            BootSequence boot,
            Clock clock,
            Environment environment) {
        return new GatewayLink(
                http, credentials, state, sessions, revocations, boot,
                DataPlaneConfiguration.version(environment), clock, GatewayLink.Timing.DEFAULT);
    }
}
