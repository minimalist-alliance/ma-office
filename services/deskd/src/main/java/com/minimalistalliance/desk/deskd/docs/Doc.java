package com.minimalistalliance.desk.deskd.docs;

import java.sql.ResultSet;
import java.sql.SQLException;

/** One row of {@code docs}: a logical document on this desk (deskd {@code API.md} §25 "A document"). Mutable, local. */
final class Doc {
    String id;
    long rev;
    String kind;
    String type;
    String title;
    String origName;
    String what;
    long size;
    String sha256;
    Long simhash;
    long arrivedAt;
    long changedAt;
    String changedBy = "member";
    String changedByName;
    String place = Places.RECORDS;
    boolean maybe;
    String reason = "default";
    String reasonArg;
    int basis;
    Long dueAt;
    String danger;
    boolean untrusted;
    boolean sensitive;
    String state = "new";
    Long heldUntil;
    Long lastSeenAt;
    String lastSeenSha;
    Integer lastPage;
    long seenMs;
    String fromKey;
    String fromName;
    String fromDomain;
    String threadRef;
    String lane;
    boolean bulk;
    boolean senderKnown;
    Integer pageCount;
    int signEmpty;
    int formEmpty;
    String parseState = "pending";
    boolean renamed;
    boolean gone;
    String agentName;
    String sourceKind;
    String sourceLabel;
    String welcomeKind;
    /** Courier's contact and channel ids of an attachment, the agent's id of its output or write-up (ids, S0). */
    String contactId;
    String channelId;
    String agentId;
    /** Never for the reader: a write-up that holds this desk's private data (its answer needed a card). */
    boolean noReader;
    /** Before its first copy is written (a new document): the copy's kind and ref, for To-do's link. Not stored. */
    transient String pendingSourceKind;
    transient String pendingRef;

    static final String COLUMNS = "id, rev, kind, type, title, orig_name, what, size, sha256, simhash, arrived_at, changed_at,"
            + " changed_by, changed_by_name, place, maybe, reason, reason_arg, basis, due_at, danger, untrusted, sensitive, state,"
            + " held_until, last_seen_at, last_seen_sha, last_page, seen_ms, from_key, from_name, from_domain, thread_ref, lane,"
            + " bulk, sender_known, page_count, sign_empty, form_empty, parse_state, renamed, gone, agent_name, source_kind,"
            + " source_label, contact_id, channel_id, agent_id, no_reader";

    Object[] values() {
        return new Object[] {id, rev, kind, type, title, origName, what, size, sha256, simhash, arrivedAt, changedAt, changedBy,
                changedByName, place, maybe, reason, reasonArg, basis, dueAt, danger, untrusted, sensitive, state, heldUntil,
                lastSeenAt, lastSeenSha, lastPage, seenMs, fromKey, fromName, fromDomain, threadRef, lane, bulk, senderKnown,
                pageCount, signEmpty, formEmpty, parseState, renamed, gone, agentName, sourceKind, sourceLabel, contactId, channelId, agentId,
                noReader};
    }

    static Doc of(ResultSet r) throws SQLException {
        Doc d = new Doc();
        d.id = r.getString("id");
        d.rev = r.getLong("rev");
        d.kind = r.getString("kind");
        d.type = r.getString("type");
        d.title = r.getString("title");
        d.origName = r.getString("orig_name");
        d.what = r.getString("what");
        d.size = r.getLong("size");
        d.sha256 = r.getString("sha256");
        d.simhash = Sql.nullableLong(r, "simhash");
        d.arrivedAt = r.getLong("arrived_at");
        d.changedAt = r.getLong("changed_at");
        d.changedBy = r.getString("changed_by");
        d.changedByName = r.getString("changed_by_name");
        d.place = r.getString("place");
        d.maybe = r.getInt("maybe") == 1;
        d.reason = r.getString("reason");
        d.reasonArg = r.getString("reason_arg");
        d.basis = r.getInt("basis");
        d.dueAt = Sql.nullableLong(r, "due_at");
        d.danger = r.getString("danger");
        d.untrusted = r.getInt("untrusted") == 1;
        d.sensitive = r.getInt("sensitive") == 1;
        d.state = r.getString("state");
        d.heldUntil = Sql.nullableLong(r, "held_until");
        d.lastSeenAt = Sql.nullableLong(r, "last_seen_at");
        d.lastSeenSha = r.getString("last_seen_sha");
        d.lastPage = Sql.nullableInt(r, "last_page");
        d.seenMs = r.getLong("seen_ms");
        d.fromKey = r.getString("from_key");
        d.fromName = r.getString("from_name");
        d.fromDomain = r.getString("from_domain");
        d.threadRef = r.getString("thread_ref");
        d.lane = r.getString("lane");
        d.bulk = r.getInt("bulk") == 1;
        d.senderKnown = r.getInt("sender_known") == 1;
        d.pageCount = Sql.nullableInt(r, "page_count");
        d.signEmpty = r.getInt("sign_empty");
        d.formEmpty = r.getInt("form_empty");
        d.parseState = r.getString("parse_state");
        d.renamed = r.getInt("renamed") == 1;
        d.gone = r.getInt("gone") == 1;
        d.agentName = r.getString("agent_name");
        d.sourceKind = r.getString("source_kind");
        d.sourceLabel = r.getString("source_label");
        d.contactId = r.getString("contact_id");
        d.channelId = r.getString("channel_id");
        d.agentId = r.getString("agent_id");
        d.noReader = r.getInt("no_reader") == 1;
        return d;
    }

    /** Who it's from, for titles and reasons: the person, else the agent, else "You" or "Browser". */
    String who() {
        if (fromName != null && !fromName.isBlank()) {
            return fromName;
        }
        if (agentName != null) {
            return agentName;
        }
        return switch (kind) {
            case "download" -> "Browser";
            case "writeup" -> "Maia";
            default -> "You";
        };
    }

    boolean viewable() {
        return danger == null && !"other".equals(type) && !gone;
    }
}
