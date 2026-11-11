package com.minimalistalliance.desk.deskd;

import com.minimalistalliance.desk.deskd.admin.AdminServer;
import com.minimalistalliance.desk.deskd.agent.AgentModule;
import com.minimalistalliance.desk.deskd.apps.AppsModule;
import com.minimalistalliance.desk.deskd.browser.BrowserModule;
import com.minimalistalliance.desk.deskd.gateway.GatewayLink;
import com.minimalistalliance.desk.deskd.notebook.CommonsRelay;
import com.minimalistalliance.desk.deskd.notebook.NotebookModule;
import com.minimalistalliance.desk.deskd.platform.DataVolume;
import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * What GET /health reports. It fails only if deskd can't write its data directory. Links to desk-rtc
 * and Platform are informational, so a Platform outage during a rollout can't cause a rollback
 * (desk-runtime.md section 6). The browser, the stream, desk-agent and desk-notebook are too: none is a reason to roll
 * back.
 * When deskd gets databases, whether they're open goes here too.
 */
final class DeskdHealth implements AdminServer.Health {

    private final DataVolume volume;
    private final RtcClient rtc;
    private final GatewayLink link;
    private final BrowserModule browser;
    private final AgentModule agent;
    private final NotebookModule notebook;
    private final CommonsRelay commons;
    private final AppsModule apps;
    private final java.util.function.BooleanSupplier guildDesk;
    private final String version;

    DeskdHealth(
            DataVolume volume,
            RtcClient rtc,
            GatewayLink link,
            BrowserModule browser,
            AgentModule agent,
            NotebookModule notebook,
            CommonsRelay commons,
            AppsModule apps,
            java.util.function.BooleanSupplier guildDesk,
            String version) {
        this.volume = volume;
        this.rtc = rtc;
        this.link = link;
        this.browser = browser;
        this.agent = agent;
        this.notebook = notebook;
        this.commons = commons;
        this.apps = apps;
        this.guildDesk = guildDesk;
        this.version = version;
    }

    @Override
    public boolean healthy() {
        return volume.isWritable();
    }

    @Override
    public boolean rtcConnected() {
        return rtc.isConfigured();
    }

    @Override
    public boolean platformOk() {
        return link.isReady();
    }

    @Override
    public String version() {
        return version;
    }

    @Override
    public Map<String, Object> details() {
        Map<String, Object> details = new LinkedHashMap<>(browser.health());
        details.putAll(agent.health());
        details.putAll(notebook.health());
        if (guildDesk.getAsBoolean()) {
            details.putAll(commons.health());
        }
        details.putAll(apps.health());
        return details;
    }
}
