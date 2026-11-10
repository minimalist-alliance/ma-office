package com.minimalistalliance.desk.agent;

import com.minimalistalliance.desk.agent.admin.AdminServer;
import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.key.KeyRing;
import com.minimalistalliance.desk.agent.limits.UsageLedger;
import com.minimalistalliance.desk.agent.service.AgentService;
import com.minimalistalliance.desk.agent.socket.AgentSocketServer;
import com.minimalistalliance.desk.agent.store.AgentStore;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.sql.SQLException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.SmartLifecycle;

/**
 * Starts everything once every bean exists, the admin socket first, so health answers while the rest comes up, and
 * says why it's failing if the data can't be opened. Nothing touches the filesystem before this, which is what
 * lets the AppCDS training stop at context refresh without a {@code /data}.
 *
 * <p>The agent socket opens last, once the records and the agents are back, so deskd's first call finds them.
 *
 * <p>On SIGTERM it closes the agent socket, stops the runs (their replies end {@code stopped}), zeroes every key,
 * records the stop, and closes the databases, then the health socket.
 */
final class DeskAgentLifecycle implements SmartLifecycle {

    private static final Logger log = LoggerFactory.getLogger(DeskAgentLifecycle.class);

    private final AdminServer admin;
    private final DataDirectory data;
    private final AuditLog audit;
    private final UsageLedger ledger;
    private final AgentStore store;
    private final AgentService service;
    private final AgentSocketServer socket;
    private final KeyRing keys;
    private final String version;
    private volatile boolean running;

    DeskAgentLifecycle(
            AdminServer admin,
            DataDirectory data,
            AuditLog audit,
            UsageLedger ledger,
            AgentStore store,
            AgentService service,
            AgentSocketServer socket,
            KeyRing keys,
            String version) {
        this.admin = admin;
        this.data = data;
        this.audit = audit;
        this.ledger = ledger;
        this.store = store;
        this.service = service;
        this.socket = socket;
        this.keys = keys;
        this.version = version;
    }

    @Override
    public void start() {
        try {
            admin.start();
        } catch (IOException e) {
            throw new UncheckedIOException("can't open the admin socket", e);
        }
        if (!data.isWritable()) {
            log.error("data directory {} is missing or unwritable: no model calls until a restart", data.path());
        } else {
            openRecords();
        }
        try {
            socket.start();
        } catch (IOException e) {
            throw new UncheckedIOException("can't open the agent socket", e);
        }
        running = true;
    }

    private void openRecords() {
        try {
            audit.open();
            ledger.open();
            store.open();
            service.restore();
            if (ledger.orphansAtOpen() > 0) {
                audit.append(AuditLog.Entry.of("system", "usage.orphaned", "ledger", "kept:" + ledger.orphansAtOpen()));
            }
            if (store.interruptedAtOpen() > 0) {
                audit.append(AuditLog.Entry.of("system", "run.interrupted", "agents",
                        "failed:" + store.interruptedAtOpen()));
            }
            audit.append(AuditLog.Entry.of("system", "service.start", "desk-agent:" + version, "ok"));
        } catch (SQLException e) {
            // A failed open leaves its database closed, which is what fails health.
            log.error("can't open desk-agent's records: {}", e.getMessage());
        }
    }

    @Override
    public void stop() {
        socket.close();
        service.stopAll();
        keys.dropAll();
        if (audit.isOpen()) {
            try {
                audit.append(AuditLog.Entry.of("system", "service.stop", "desk-agent:" + version, "ok"));
            } catch (SQLException e) {
                log.warn("the stop wasn't recorded: {}", e.getMessage());
            }
        }
        store.close();
        ledger.close();
        audit.close();
        admin.close();
        running = false;
    }

    @Override
    public boolean isRunning() {
        return running;
    }
}
