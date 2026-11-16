package com.minimalistalliance.desk.deskd.courier.store;

import com.minimalistalliance.desk.deskd.sqlite.SqliteDatabase;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;

/**
 * {@code courier.db}'s schema (draft ADR "Courier's store", section 2). Version 1 is design §8.2's model under Courier's
 * id, with what the launch plan adds: lanes, the account a message came through, a stable desk-made id (a ULID) and the
 * desk's own {@code received_at}, which the agent tools' cursor needs.
 *
 * <p>Every table names its columns in every write. {@code messages.seq} is the FTS rowid and is never reused
 * ({@code AUTOINCREMENT}), so a deleted message's index row can't come back as another's. The index is external-content
 * FTS5 kept by triggers: an update of a column it doesn't index (read, lane) never touches it.
 */
final class Schema {

    private Schema() {}

    static final List<SqliteDatabase.Step> STEPS = List.of(Schema::v1, Schema::v2, Schema::v3, Schema::v4, Schema::v5, Schema::v6);

    private static void v1(Connection c) throws SQLException {
        try (Statement s = c.createStatement()) {
            // The ways in: this desk's address, linked mailboxes, the member address, iMessage. Never a secret: a linked
            // account's sign-in is sealed in /data/courier/keys (the vault), and this row is the commit point for it.
            s.execute("""
                    CREATE TABLE accounts (
                      id TEXT PRIMARY KEY,
                      kind TEXT NOT NULL,
                      label TEXT NOT NULL,
                      address TEXT,
                      state TEXT NOT NULL,
                      created_at INTEGER NOT NULL,
                      updated_at INTEGER NOT NULL)""");
            // The member's own addresses, for telling in from out and for the self channel.
            s.execute("""
                    CREATE TABLE own_addresses (
                      kind TEXT NOT NULL,
                      value TEXT NOT NULL,
                      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                      PRIMARY KEY (kind, value))""");
            s.execute("""
                    CREATE TABLE contacts (
                      id TEXT PRIMARY KEY,
                      name TEXT,
                      named INTEGER NOT NULL DEFAULT 0,
                      created_at INTEGER NOT NULL,
                      updated_at INTEGER NOT NULL)""");
            // standing: known, request, other, blocked. Who a sender is comes from here, never from a display name.
            s.execute("""
                    CREATE TABLE endpoints (
                      id TEXT PRIMARY KEY,
                      kind TEXT NOT NULL,
                      value TEXT NOT NULL,
                      display TEXT,
                      contact_id TEXT NOT NULL REFERENCES contacts(id),
                      standing TEXT NOT NULL,
                      written_to INTEGER NOT NULL DEFAULT 0,
                      first_seen_at INTEGER NOT NULL,
                      last_inbound_at INTEGER,
                      last_inbound_medium TEXT,
                      UNIQUE (kind, value))""");
            s.execute("CREATE INDEX endpoints_contact ON endpoints(contact_id)");
            s.execute("""
                    CREATE TABLE blocks (
                      kind TEXT NOT NULL,
                      value TEXT NOT NULL,
                      created_at INTEGER NOT NULL,
                      PRIMARY KEY (kind, value))""");
            // key: direct:<contactId>, group:<hash of the sorted endpoints>, list:<List-Id>, or self.
            s.execute("""
                    CREATE TABLE channels (
                      id TEXT PRIMARY KEY,
                      kind TEXT NOT NULL,
                      key TEXT NOT NULL UNIQUE,
                      title TEXT,
                      preferred_medium TEXT,
                      created_at INTEGER NOT NULL)""");
            s.execute("""
                    CREATE TABLE channel_members (
                      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
                      endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
                      PRIMARY KEY (channel_id, endpoint_id))""");
            s.execute("CREATE INDEX channel_members_endpoint ON channel_members(endpoint_id)");
            // An email conversation inside a channel: JWZ's containers, kept as a thread id per message.
            s.execute("""
                    CREATE TABLE threads (
                      id TEXT PRIMARY KEY,
                      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
                      subject_norm TEXT,
                      started_by_member INTEGER NOT NULL,
                      last_at INTEGER NOT NULL,
                      created_at INTEGER NOT NULL)""");
            s.execute("CREATE INDEX threads_subject ON threads(channel_id, subject_norm, last_at)");
            s.execute("""
                    CREATE TABLE messages (
                      seq INTEGER PRIMARY KEY AUTOINCREMENT,
                      id TEXT NOT NULL UNIQUE,
                      medium TEXT NOT NULL,
                      external_id TEXT NOT NULL,
                      account_id TEXT,
                      channel_id TEXT REFERENCES channels(id),
                      thread_id TEXT,
                      direction TEXT NOT NULL,
                      author_kind TEXT NOT NULL,
                      from_endpoint TEXT REFERENCES endpoints(id),
                      lane TEXT NOT NULL,
                      lane_before TEXT,
                      lane_at INTEGER NOT NULL,
                      bulk INTEGER NOT NULL,
                      sender_known INTEGER NOT NULL,
                      status TEXT NOT NULL,
                      read INTEGER NOT NULL,
                      sent_at INTEGER,
                      received_at INTEGER NOT NULL,
                      sort_at INTEGER NOT NULL,
                      sort_key INTEGER NOT NULL,
                      msgid TEXT,
                      subject TEXT,
                      subject_norm TEXT,
                      snippet TEXT,
                      body_text TEXT,
                      body_html TEXT,
                      text_truncated INTEGER NOT NULL DEFAULT 0,
                      search_from TEXT,
                      search_to TEXT,
                      search_attach TEXT,
                      attachment_count INTEGER NOT NULL DEFAULT 0,
                      parse_state TEXT NOT NULL,
                      parse_reason TEXT,
                      auth TEXT,
                      labels TEXT,
                      list_id TEXT,
                      blob TEXT,
                      raw_bytes INTEGER,
                      origin TEXT NOT NULL,
                      UNIQUE (medium, external_id))""");
            s.execute("CREATE INDEX messages_channel ON messages(channel_id, sort_at, seq)");
            // The search's order: sort_at to the millisecond, then arrival, unique (Ingest.sortKey, and the full-text
            // index's own rowid key). It is that index's rowid, so a search reads its matches newest first and stops at a
            // page; the other columns are what a search filters on, so a match that doesn't pass is never read whole.
            s.execute("CREATE INDEX messages_key ON messages(sort_key, lane, channel_id, attachment_count, read, direction)");
            s.execute("CREATE INDEX messages_channel_lane ON messages(channel_id, lane, sort_at)");
            s.execute("CREATE INDEX messages_lane ON messages(lane, sort_key)");
            s.execute("CREATE INDEX messages_lane_at ON messages(lane, lane_at)");
            s.execute("CREATE INDEX messages_received ON messages(received_at, id)");
            s.execute("CREATE INDEX messages_msgid ON messages(msgid) WHERE msgid IS NOT NULL");
            s.execute("CREATE INDEX messages_thread ON messages(thread_id) WHERE thread_id IS NOT NULL");
            s.execute("CREATE INDEX messages_blob ON messages(blob) WHERE blob IS NOT NULL");
            s.execute("CREATE INDEX messages_from ON messages(from_endpoint)");
            // What a message names as its parents (In-Reply-To and References), for joining threads in any order.
            s.execute("""
                    CREATE TABLE message_refs (
                      message_seq INTEGER NOT NULL REFERENCES messages(seq) ON DELETE CASCADE,
                      ref TEXT NOT NULL,
                      PRIMARY KEY (message_seq, ref))""");
            s.execute("CREATE INDEX message_refs_ref ON message_refs(ref)");
            s.execute("""
                    CREATE TABLE recipients (
                      message_seq INTEGER NOT NULL REFERENCES messages(seq) ON DELETE CASCADE,
                      endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
                      role TEXT NOT NULL,
                      status TEXT,
                      PRIMARY KEY (message_seq, endpoint_id, role))""");
            s.execute("CREATE INDEX recipients_endpoint ON recipients(endpoint_id)");
            s.execute("""
                    CREATE TABLE attachments (
                      message_seq INTEGER NOT NULL REFERENCES messages(seq) ON DELETE CASCADE,
                      part TEXT NOT NULL,
                      name TEXT,
                      type TEXT,
                      bytes INTEGER,
                      content_id TEXT,
                      inline INTEGER NOT NULL,
                      danger TEXT,
                      PRIMARY KEY (message_seq, part))""");
            // One row per channel and lane: what a lane's list shows, kept with each write.
            s.execute("""
                    CREATE TABLE channel_lanes (
                      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
                      lane TEXT NOT NULL,
                      last_at INTEGER NOT NULL,
                      last_seq INTEGER NOT NULL,
                      count INTEGER NOT NULL,
                      unread INTEGER NOT NULL,
                      done_at INTEGER,
                      PRIMARY KEY (channel_id, lane))""");
            s.execute("CREATE INDEX channel_lanes_list ON channel_lanes(lane, last_at, channel_id)");
            // A transport's place in its source, committed with the messages it brought.
            s.execute("""
                    CREATE TABLE cursors (
                      account_id TEXT NOT NULL,
                      stream TEXT NOT NULL,
                      value TEXT NOT NULL,
                      updated_at INTEGER NOT NULL,
                      PRIMARY KEY (account_id, stream))""");
            s.execute("""
                    CREATE TABLE drafts (
                      id TEXT PRIMARY KEY,
                      channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
                      medium TEXT,
                      account_id TEXT,
                      to_list TEXT,
                      subject TEXT,
                      text TEXT NOT NULL,
                      reply_to TEXT,
                      version INTEGER NOT NULL,
                      created_at INTEGER NOT NULL,
                      updated_at INTEGER NOT NULL)""");
            // held: inside the undo window. Courier never sends by itself: a row is made only by the member's send.
            s.execute("""
                    CREATE TABLE outbound (
                      id TEXT PRIMARY KEY,
                      message_seq INTEGER NOT NULL UNIQUE REFERENCES messages(seq) ON DELETE CASCADE,
                      draft_id TEXT NOT NULL,
                      state TEXT NOT NULL,
                      not_before INTEGER NOT NULL,
                      give_up_at INTEGER NOT NULL,
                      attempts INTEGER NOT NULL,
                      interrupted INTEGER NOT NULL DEFAULT 0,
                      last_error TEXT,
                      created_at INTEGER NOT NULL,
                      updated_at INTEGER NOT NULL)""");
            s.execute("CREATE INDEX outbound_due ON outbound(state, not_before)");
            // What courier.status counts, kept by triggers in each write's own transaction, as a sum over messages
            // would read every row.
            s.execute("CREATE TABLE totals (id INTEGER PRIMARY KEY CHECK (id = 1), raw_bytes INTEGER NOT NULL)");
            s.execute("INSERT INTO totals (id, raw_bytes) VALUES (1, 0)");
            s.execute("""
                    CREATE TRIGGER totals_ai AFTER INSERT ON messages WHEN new.blob IS NOT NULL BEGIN
                      UPDATE totals SET raw_bytes = raw_bytes + coalesce(new.raw_bytes, 0) WHERE id = 1;
                    END""");
            s.execute("""
                    CREATE TRIGGER totals_ad AFTER DELETE ON messages WHEN old.blob IS NOT NULL BEGIN
                      UPDATE totals SET raw_bytes = raw_bytes - coalesce(old.raw_bytes, 0) WHERE id = 1;
                    END""");
            s.execute("""
                    CREATE TRIGGER totals_au AFTER UPDATE OF blob, raw_bytes ON messages BEGIN
                      UPDATE totals SET raw_bytes = raw_bytes
                        - (CASE WHEN old.blob IS NOT NULL THEN coalesce(old.raw_bytes, 0) ELSE 0 END)
                        + (CASE WHEN new.blob IS NOT NULL THEN coalesce(new.raw_bytes, 0) ELSE 0 END) WHERE id = 1;
                    END""");
            // Small raw messages, gzip, written with their row; larger ones are files (BlobStore).
            s.execute("CREATE TABLE blob_data (sha TEXT PRIMARY KEY, data BLOB NOT NULL)");
            // Blobs whose last row went: removed after the commit, on the writer's thread (BlobStore).
            s.execute("CREATE TABLE blob_gc (sha TEXT PRIMARY KEY)");
            // The agent tools' cursor: one per agent, (received_at, id) of the last message given (draft ADR §12).
            s.execute("""
                    CREATE TABLE agent_cursors (
                      agent_id TEXT PRIMARY KEY,
                      received_at INTEGER NOT NULL,
                      message_id TEXT NOT NULL,
                      updated_at INTEGER NOT NULL)""");
            s.execute("""
                    CREATE VIRTUAL TABLE messages_fts USING fts5(
                      subject, search_from, search_to, body_text, search_attach,
                      content = 'messages', content_rowid = 'sort_key',
                      tokenize = "unicode61 remove_diacritics 2", prefix = '2 3')""");
            // A delete rewrites the index's pages at once rather than leaving the old tokens until a merge (FTS5's
            // secure-delete, SQLite 3.42 on), so a message deleted for good leaves no word of it in the index.
            s.execute("INSERT INTO messages_fts(messages_fts, rank) VALUES ('secure-delete', 1)");
            s.execute("""
                    CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
                      INSERT INTO messages_fts(rowid, subject, search_from, search_to, body_text, search_attach)
                      VALUES (new.sort_key, new.subject, new.search_from, new.search_to, new.body_text, new.search_attach);
                    END""");
            s.execute("""
                    CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
                      INSERT INTO messages_fts(messages_fts, rowid, subject, search_from, search_to, body_text, search_attach)
                      VALUES ('delete', old.sort_key, old.subject, old.search_from, old.search_to, old.body_text, old.search_attach);
                    END""");
            s.execute("""
                    CREATE TRIGGER messages_fts_au AFTER UPDATE OF subject, search_from, search_to, body_text, search_attach
                    ON messages BEGIN
                      INSERT INTO messages_fts(messages_fts, rowid, subject, search_from, search_to, body_text, search_attach)
                      VALUES ('delete', old.sort_key, old.subject, old.search_from, old.search_to, old.body_text, old.search_attach);
                      INSERT INTO messages_fts(rowid, subject, search_from, search_to, body_text, search_attach)
                      VALUES (new.sort_key, new.subject, new.search_from, new.search_to, new.body_text, new.search_attach);
                    END""");
        }
    }

    /**
     * Version 2 (Wave 2.1, linked mailboxes): where each message sits at its provider, so a change goes both ways and a
     * re-sync fetches nothing it has (draft ADR "Courier's store" §15). Folders, each message's places in them, messages that
     * lost their last place and may turn up again (a move, a UIDVALIDITY reset), and the member's changes owed to the
     * provider. Plus an index that keeps a first sync's old mail out of the agent tools' {@code courier_new}.
     */
    private static void v2(Connection c) throws SQLException {
        try (Statement s = c.createStatement()) {
            // A linked mailbox's folder as the provider names it. top_uid and low_uid bound the UIDs already handled: the
            // live path takes what's above top_uid, the first sync works down from low_uid until backfilled. modseq is the
            // highest CONDSTORE change already applied (0 when the server has none).
            s.execute("""
                    CREATE TABLE linked_folders (
                      id INTEGER PRIMARY KEY AUTOINCREMENT,
                      account_id TEXT NOT NULL,
                      name TEXT NOT NULL,
                      role TEXT NOT NULL,
                      uid_validity INTEGER NOT NULL,
                      uid_next INTEGER NOT NULL,
                      top_uid INTEGER NOT NULL,
                      low_uid INTEGER NOT NULL,
                      backfilled INTEGER NOT NULL,
                      recent_uid INTEGER,
                      modseq INTEGER NOT NULL,
                      oldest_at INTEGER,
                      synced_at INTEGER,
                      UNIQUE (account_id, name))""");
            // One message's place in one folder. message_id is null for what isn't kept (a draft); a message deleted on the
            // desk keeps its rows until the provider drops it, so a re-sync never brings it back.
            s.execute("""
                    CREATE TABLE linked_locations (
                      folder_id INTEGER NOT NULL REFERENCES linked_folders(id) ON DELETE CASCADE,
                      uid INTEGER NOT NULL,
                      account_id TEXT NOT NULL,
                      message_id TEXT,
                      seen INTEGER NOT NULL,
                      labels TEXT,
                      size INTEGER NOT NULL,
                      internal_at INTEGER,
                      msgid TEXT,
                      gm_id TEXT,
                      PRIMARY KEY (folder_id, uid))""");
            s.execute("CREATE INDEX linked_locations_message ON linked_locations(message_id) WHERE message_id IS NOT NULL");
            s.execute("CREATE INDEX linked_locations_gm ON linked_locations(account_id, gm_id) WHERE gm_id IS NOT NULL");
            // A message whose last place went: found again by its Gmail id or its Message-ID, size and date (a move, a
            // folder renumbered), or, once a whole pass hasn't found it, gone at the provider.
            s.execute("""
                    CREATE TABLE linked_orphans (
                      account_id TEXT NOT NULL,
                      message_id TEXT NOT NULL,
                      msgid TEXT,
                      size INTEGER NOT NULL,
                      internal_at INTEGER,
                      gm_id TEXT,
                      since INTEGER NOT NULL,
                      PRIMARY KEY (account_id, message_id))""");
            s.execute("CREATE INDEX linked_orphans_msgid ON linked_orphans(account_id, msgid, size)");
            s.execute("CREATE INDEX linked_orphans_gm ON linked_orphans(account_id, gm_id) WHERE gm_id IS NOT NULL");
            // The member's changes on the desk that the provider is owed: read, unread, trash, spam, restore, delete. Written
            // in the member's own transaction, applied by the transport, which never writes here itself.
            s.execute("""
                    CREATE TABLE linked_ops (
                      seq INTEGER PRIMARY KEY AUTOINCREMENT,
                      account_id TEXT NOT NULL,
                      message_id TEXT NOT NULL,
                      op TEXT NOT NULL,
                      attempts INTEGER NOT NULL DEFAULT 0,
                      created_at INTEGER NOT NULL)""");
            s.execute("CREATE INDEX linked_ops_account ON linked_ops(account_id, seq)");
            s.execute("CREATE INDEX linked_ops_message ON linked_ops(message_id)");
            // courier_new reads by this: a linked mailbox's years of old mail, brought in by its first sync, are never new.
            s.execute("CREATE INDEX messages_received_new ON messages(received_at, id) WHERE origin <> 'backfill'");
        }
    }

    /**
     * Version 3 (Wave 3.2, spam and safety; draft ADR "Courier's store" §17): why the desk itself put a message in Spam
     * ({@code screen}: {@code filter} for the learning filter), the sender warnings made as it arrived ({@code warn}), the
     * keys lookalike checks match on ({@code contacts.name_key}, {@code endpoints.skel}), the learning filter's counts (by a
     * keyed hash of each token, never the word), what each message taught it, and spam reports owed to the mail door.
     */
    private static void v3(Connection c) throws SQLException {
        try (Statement s = c.createStatement()) {
            s.execute("ALTER TABLE messages ADD COLUMN screen TEXT");
            s.execute("ALTER TABLE messages ADD COLUMN warn TEXT");
            s.execute("ALTER TABLE contacts ADD COLUMN name_key TEXT");
            s.execute("ALTER TABLE endpoints ADD COLUMN skel TEXT");
            s.execute("CREATE INDEX contacts_name_key ON contacts(name_key) WHERE name_key IS NOT NULL");
            s.execute("CREATE INDEX endpoints_skel ON endpoints(skel) WHERE skel IS NOT NULL");
            // The learning filter (naive Bayes, per desk): how often each token was in mail the member called spam or wanted.
            // h is a 64-bit SipHash of the token under this desk's own salt, so the store keeps no word of anyone's mail here.
            s.execute("CREATE TABLE filter_tokens (h INTEGER PRIMARY KEY, spam INTEGER NOT NULL, ham INTEGER NOT NULL) WITHOUT ROWID");
            s.execute("""
                    CREATE TABLE filter_state (
                      id INTEGER PRIMARY KEY CHECK (id = 1),
                      salt BLOB NOT NULL,
                      spam INTEGER NOT NULL,
                      ham INTEGER NOT NULL,
                      updated_at INTEGER NOT NULL)""");
            s.execute("INSERT INTO filter_state (id, salt, spam, ham, updated_at) VALUES (1, randomblob(16), 0, 0, 0)");
            // What each message taught the filter, so a change of mind moves its counts across and never counts it twice.
            s.execute("""
                    CREATE TABLE filter_trained (
                      message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
                      class TEXT NOT NULL,
                      at INTEGER NOT NULL) WITHOUT ROWID""");
            // "Report spam" on mail to this desk's address: the sender, for the platform's suppression list, owed to the
            // mail door's transport (Wave 2.5), which marks each one sent. A linked mailbox's report is its move to Junk.
            s.execute("""
                    CREATE TABLE reports (
                      id TEXT PRIMARY KEY,
                      message_id TEXT NOT NULL,
                      account_id TEXT NOT NULL,
                      address TEXT NOT NULL,
                      state TEXT NOT NULL,
                      created_at INTEGER NOT NULL,
                      updated_at INTEGER NOT NULL)""");
            s.execute("CREATE INDEX reports_owed ON reports(state, created_at)");
        }
        // The keys for what's already here, made by the same code that makes them for new rows.
        try (java.sql.PreparedStatement read = c.prepareStatement("SELECT id, name FROM contacts WHERE name IS NOT NULL");
                java.sql.PreparedStatement write = c.prepareStatement("UPDATE contacts SET name_key = ? WHERE id = ?");
                java.sql.ResultSet r = read.executeQuery()) {
            while (r.next()) {
                write.setString(1, Senders.nameKey(r.getString(2)));
                write.setString(2, r.getString(1));
                write.executeUpdate();
            }
        }
        try (java.sql.PreparedStatement read = c.prepareStatement("SELECT id, kind, value FROM endpoints WHERE kind IN ('email', 'ma', 'apple')");
                java.sql.PreparedStatement write = c.prepareStatement("UPDATE endpoints SET skel = ? WHERE id = ?");
                java.sql.ResultSet r = read.executeQuery()) {
            while (r.next()) {
                write.setString(1, Senders.endpointSkel(r.getString(2), r.getString(3)));
                write.setString(2, r.getString(1));
                write.executeUpdate();
            }
        }
    }

    /**
     * Version 4 (Wave 2.5, the {@code ma} and mail-door transports; draft ADR "Courier's transports"): the identity keys
     * this desk pinned for other members' addresses, messages held back while a pinned key changed and the member hasn't
     * checked the new safety number, and the keys of envelopes already taken in, kept past the relay's wait so the relay
     * can't hand one back after the member deleted its message (Security CK-I6).
     */
    private static void v4(Connection c) throws SQLException {
        try (Statement s = c.createStatement()) {
            // One row per member address this desk has sealed to or heard from. state: unverified (trusted on first use),
            // verified (an invite's fingerprint or the safety number checked), changed (the directory or a message showed
            // another identity: new_* hold it until the member checks, and nothing is sealed to this address meanwhile).
            // old_box_keys: the last few box keys this identity had here, so an invite made before a rotation is known as
            // one (Security CT-M2).
            s.execute("""
                    CREATE TABLE ma_pins (
                      address TEXT PRIMARY KEY,
                      identity_key TEXT NOT NULL,
                      box_key TEXT NOT NULL,
                      binding TEXT NOT NULL,
                      keys_version INTEGER NOT NULL,
                      old_box_keys TEXT,
                      state TEXT NOT NULL,
                      source TEXT NOT NULL,
                      new_identity_key TEXT,
                      new_box_key TEXT,
                      new_binding TEXT,
                      new_keys_version INTEGER,
                      pinned_at INTEGER NOT NULL,
                      verified_at INTEGER,
                      changed_at INTEGER,
                      looked_up_at INTEGER)""");
            // A message whose signature verified under a new identity for a pinned address: kept out of the store until the
            // member accepts the new key (then it goes in as it came) or blocks the sender (then it's deleted).
            s.execute("""
                    CREATE TABLE ma_held (
                      seq INTEGER PRIMARY KEY AUTOINCREMENT,
                      address TEXT NOT NULL,
                      external_id TEXT NOT NULL UNIQUE,
                      identity_key TEXT NOT NULL,
                      payload TEXT NOT NULL,
                      body BLOB,
                      received_at INTEGER NOT NULL)""");
            s.execute("CREATE INDEX ma_held_address ON ma_held(address, seq)");
            // The sink's key of every envelope taken in, until a replay of it could no longer pass the age check.
            s.execute("""
                    CREATE TABLE relay_seen (
                      medium TEXT NOT NULL,
                      external_id TEXT NOT NULL,
                      until INTEGER NOT NULL,
                      PRIMARY KEY (medium, external_id))""");
            s.execute("CREATE INDEX relay_seen_until ON relay_seen(until)");
        }
    }

    /**
     * Version 5 (one person across channels, the Designer's flow 11; draft ADR "Courier's store" §18): where an endpoint came
     * from, each link and unlink the member made (with what Undo needs to put it back exactly), and each "not them".
     */
    private static void v5(Connection c) throws SQLException {
        try (Statement s = c.createStatement()) {
            // added (the member typed it, or an invite's Add), card, mac, provider; null: it came with a message.
            s.execute("ALTER TABLE endpoints ADD COLUMN source TEXT");
            // kind: link or unlink. A link moved endpoints from from_contact onto into_contact; an unlink moved them from
            // from_contact to into_contact, a person of their own. The rest is what Undo restores: the person and conversation
            // a link emptied, the messages and drafts it moved, and what letting in changed (lanes: seq:lane:lane_before:screen).
            s.execute("""
                    CREATE TABLE links (
                      id TEXT PRIMARY KEY,
                      kind TEXT NOT NULL,
                      into_contact TEXT NOT NULL,
                      from_contact TEXT NOT NULL,
                      from_name TEXT,
                      from_named INTEGER NOT NULL DEFAULT 0,
                      from_name_key TEXT,
                      from_created_at INTEGER,
                      endpoints TEXT NOT NULL,
                      messages TEXT,
                      drafts TEXT,
                      from_channel TEXT,
                      from_channel_gone INTEGER NOT NULL DEFAULT 0,
                      from_channel_created_at INTEGER,
                      from_channel_medium TEXT,
                      into_channel_new INTEGER NOT NULL DEFAULT 0,
                      let_in TEXT,
                      lanes TEXT,
                      known TEXT,
                      created TEXT,
                      created_at INTEGER NOT NULL,
                      undone_at INTEGER)""");
            // "Not {first name}": this endpoint isn't that person. Never suggested again.
            s.execute("""
                    CREATE TABLE links_not (
                      endpoint_id TEXT NOT NULL,
                      contact_id TEXT NOT NULL,
                      created_at INTEGER NOT NULL,
                      PRIMARY KEY (endpoint_id, contact_id))""");
        }
    }

    /**
     * Version 6 (iMessage through the member's own Mac, the launch plan's Wave 2.6; draft ADR "Courier's iMessage
     * transport"): each Mac chat's conversation here (a group's, so a reply finds its chat), the guid each message Courier
     * sent got on the Mac (so its echo isn't stored twice), and contact cards from the Mac's Contacts, which make names and
     * "Is this also...?" suggestions, never conversations (the Designer's flow 11).
     */
    private static void v6(Connection c) throws SQLException {
        try (Statement s = c.createStatement()) {
            s.execute("""
                    CREATE TABLE imessage_chats (
                      account_id TEXT NOT NULL,
                      chat_guid TEXT NOT NULL,
                      channel_id TEXT,
                      service TEXT NOT NULL,
                      updated_at INTEGER NOT NULL,
                      PRIMARY KEY (account_id, chat_guid))""");
            s.execute("CREATE INDEX imessage_chats_channel ON imessage_chats(channel_id)");
            s.execute("""
                    CREATE TABLE imessage_sent (
                      account_id TEXT NOT NULL,
                      guid TEXT NOT NULL,
                      message_id TEXT NOT NULL,
                      created_at INTEGER NOT NULL,
                      PRIMARY KEY (account_id, guid))""");
            s.execute("CREATE INDEX imessage_sent_message ON imessage_sent(message_id)");
            // source: mac:<accountId>. Replaced whole at each read of the Mac's Contacts.
            s.execute("""
                    CREATE TABLE cards (
                      seq INTEGER PRIMARY KEY AUTOINCREMENT,
                      source TEXT NOT NULL,
                      name TEXT,
                      updated_at INTEGER NOT NULL)""");
            s.execute("CREATE INDEX cards_source ON cards(source)");
            // match: p:<the number's last 10 digits> or e:<the address>, what an endpoint is compared by.
            s.execute("""
                    CREATE TABLE card_endpoints (
                      card_seq INTEGER NOT NULL REFERENCES cards(seq) ON DELETE CASCADE,
                      kind TEXT NOT NULL,
                      value TEXT NOT NULL,
                      match TEXT NOT NULL,
                      PRIMARY KEY (card_seq, kind, value))""");
            s.execute("CREATE INDEX card_endpoints_match ON card_endpoints(match)");
        }
    }
}
