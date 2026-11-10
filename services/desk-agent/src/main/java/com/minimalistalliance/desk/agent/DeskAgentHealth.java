package com.minimalistalliance.desk.agent;

import com.minimalistalliance.desk.agent.admin.AdminServer;
import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.key.KeyRing;
import com.minimalistalliance.desk.agent.limits.UsageLedger;
import com.minimalistalliance.desk.agent.manager.ManagerAgent;
import com.minimalistalliance.desk.agent.socket.AgentSocketServer;
import com.minimalistalliance.desk.agent.store.AgentStore;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * What GET /health reports. It fails only when desk-agent can't keep its records: the data directory, the ledger,
 * the audit log or the agent store. With those down it refuses every model call, so a rollout should roll it back.
 * The manager's state, the key count and whether deskd is connected are informational: a desk with no key bound, or
 * a deskd that hasn't connected yet, is healthy.
 */
final class DeskAgentHealth implements AdminServer.Health {

    private final DataDirectory data;
    private final AuditLog audit;
    private final UsageLedger ledger;
    private final AgentStore store;
    private final ManagerAgent manager;
    private final KeyRing keys;
    private final AgentSocketServer socket;
    private final String version;

    DeskAgentHealth(
            DataDirectory data,
            AuditLog audit,
            UsageLedger ledger,
            AgentStore store,
            ManagerAgent manager,
            KeyRing keys,
            AgentSocketServer socket,
            String version) {
        this.data = data;
        this.audit = audit;
        this.ledger = ledger;
        this.store = store;
        this.manager = manager;
        this.keys = keys;
        this.socket = socket;
        this.version = version;
    }

    @Override
    public boolean healthy() {
        return data.isWritable() && audit.isOpen() && ledger.isOpen() && store.isOpen();
    }

    @Override
    public String version() {
        return version;
    }

    @Override
    public Map<String, Object> details() {
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("data", data.isWritable() ? "ok" : "unwritable");
        details.put("audit", audit.isOpen() ? "open" : "closed");
        details.put("usage", ledger.isOpen() ? "open" : "closed");
        details.put("agents", store.isOpen() ? "open" : "closed");
        details.put("deskd", socket.connected() ? "connected" : "waiting");
        details.put("manager", manager.status().wireName());
        details.put("keys", keys.size());
        return details;
    }
}
