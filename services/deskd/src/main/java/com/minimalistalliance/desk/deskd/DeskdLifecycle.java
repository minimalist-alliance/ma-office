package com.minimalistalliance.desk.deskd;

import com.minimalistalliance.desk.deskd.admin.AdminServer;
import com.minimalistalliance.desk.deskd.agent.AgentModule;
import com.minimalistalliance.desk.deskd.apps.AppsModule;
import com.minimalistalliance.desk.deskd.auth.Revocations;
import com.minimalistalliance.desk.deskd.boot.BootSequence;
import com.minimalistalliance.desk.deskd.boot.ControlPlaneObserver;
import com.minimalistalliance.desk.deskd.browser.BrowserModule;
import com.minimalistalliance.desk.deskd.data.DataModule;
import com.minimalistalliance.desk.deskd.gateway.GatewayLink;
import com.minimalistalliance.desk.deskd.guild.GuildModule;
import com.minimalistalliance.desk.deskd.idle.IdleFile;
import com.minimalistalliance.desk.deskd.notebook.CommonsRelay;
import com.minimalistalliance.desk.deskd.notebook.NotebookModule;
import com.minimalistalliance.desk.deskd.platform.HeartbeatLoop;
import com.minimalistalliance.desk.deskd.platform.ModelPrices;
import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import com.minimalistalliance.desk.deskd.session.SessionManager;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.time.Duration;
import org.springframework.context.SmartLifecycle;

/**
 * Starts everything once every bean exists, the admin socket first, so health answers while the rest
 * comes up. On SIGTERM it sends the last heartbeat within 5 s, closes sessions and stops the sockets.
 * Sessions close with 4503 if Platform has said the desk is stopping, and otherwise with 4002: most
 * SIGTERMs are a restart of deskd alone, and 4503 would tell clients not to come back.
 */
final class DeskdLifecycle implements SmartLifecycle {

    private static final Duration LAST_HEARTBEAT_BUDGET = Duration.ofSeconds(5);
    private static final Duration GATEWAY_FLUSH = Duration.ofMillis(500);

    private final AdminServer admin;
    private final RtcClient rtc;
    private final SessionManager sessions;
    private final Revocations revocations;
    private final BootSequence boot;
    private final HeartbeatLoop heartbeat;
    private final GatewayLink link;
    private final BrowserModule browser;
    private final AgentModule agent;
    private final ModelPrices prices;
    private final NotebookModule notebook;
    private final DataModule data;
    private final CommonsRelay commons;
    private final GuildModule guild;
    private final IdleFile idle;
    private final AppsModule apps;
    private volatile boolean running;

    DeskdLifecycle(
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
        this.admin = admin;
        this.rtc = rtc;
        this.sessions = sessions;
        this.revocations = revocations;
        this.boot = boot;
        this.heartbeat = heartbeat;
        this.link = link;
        this.browser = browser;
        this.agent = agent;
        this.prices = prices;
        this.notebook = notebook;
        this.data = data;
        this.commons = commons;
        this.guild = guild;
        this.idle = idle;
        this.apps = apps;
    }

    @Override
    public void start() {
        try {
            admin.start();
        } catch (IOException e) {
            throw new UncheckedIOException("can't open the admin socket", e);
        }
        revocations.closeSessionsThrough(sessions);
        sessions.setObserver(new ControlPlaneObserver(link, heartbeat, boot, idle::poke));
        boot.attach(heartbeat, link);
        boot.start();
        // desk-agent's link is independent of the rest: it waits for desk-agent's socket without holding anything up.
        agent.onStatusChange(() -> {
            heartbeat.requestSoon();
            idle.poke();
        });
        agent.start();
        // The apps' registry and links: a desk with none reads one missing directory and is done. The image's bundled apps
        // are checked on a thread of their own, which nothing here waits for.
        apps.start();
        idle.start();
        // On a thread of its own, and nothing waits for it. The API base comes once boot has read the instance's identity.
        prices.start();
        running = true;
    }

    @Override
    public void stop() {
        long deadline = System.nanoTime() + LAST_HEARTBEAT_BUDGET.toNanos();
        boot.stop();
        idle.close();
        Thread lastHeartbeat = heartbeat.stopAndSendFinal(LAST_HEARTBEAT_BUDGET);
        sessions.stop(heartbeat.prepareStopSeen());
        // The sessions' transfers have ended with them, so this is the count desk-egress keeps.
        data.close();
        browser.close();
        // deskd's links to apps close; catalog apps run on, and the next deskd connects to them again. Bundled apps, deskd's
        // own children, stop.
        apps.close();
        prices.close();
        agent.close();
        // The sessions' ends closed their links already. This waits for nothing, however stalled desk-notebook is.
        notebook.close();
        commons.close();
        guild.stop();
        link.close(GATEWAY_FLUSH);
        try {
            if (lastHeartbeat != null) {
                lastHeartbeat.join(Duration.ofNanos(Math.max(0, deadline - System.nanoTime())));
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        rtc.close();
        admin.close();
        running = false;
    }

    @Override
    public boolean isRunning() {
        return running;
    }
}
