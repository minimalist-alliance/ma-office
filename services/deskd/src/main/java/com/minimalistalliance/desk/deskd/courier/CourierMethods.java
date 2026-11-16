package com.minimalistalliance.desk.deskd.courier;

import com.minimalistalliance.desk.courier.envelope.EnvelopeException;
import com.minimalistalliance.desk.courier.envelope.IdentityKey;
import com.minimalistalliance.desk.deskd.courier.keys.DeskKeys;
import com.minimalistalliance.desk.deskd.courier.store.Accounts;
import com.minimalistalliance.desk.deskd.courier.store.Actions;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import com.minimalistalliance.desk.deskd.courier.store.Lanes;
import com.minimalistalliance.desk.deskd.courier.store.Norm;
import com.minimalistalliance.desk.deskd.courier.store.SearchQuery;
import com.minimalistalliance.desk.deskd.courier.store.Ulid;
import com.minimalistalliance.desk.deskd.courier.vault.LinkedAccounts;
import com.minimalistalliance.desk.deskd.courier.vault.SignIn;
import com.minimalistalliance.desk.deskd.rpc.RpcContext;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcHandler;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import java.util.regex.Pattern;

/**
 * The {@code courier.*} RPCs (API.md §21), for the owner's sessions on an adult's personal desk. Every handler checks who
 * may call first ({@link CourierModule#refusal}), then its params, then calls the store. Errors carry short codes in
 * {@code details.reason}, never a name, an address or text.
 */
final class CourierMethods {

    private static final Pattern REASON = Pattern.compile("[a-z_]{1,32}");
    private static final Pattern ACCOUNT_ID = Pattern.compile("[A-Za-z0-9._-]{1,64}");

    private static final Pattern PART = Pattern.compile("[1-9][0-9]{0,3}(\\.[1-9][0-9]{0,3}){0,21}");

    private final Supplier<CourierStore> store;
    private final CourierModule module;
    private final CourierAttachments attachments;

    CourierMethods(CourierModule module, Supplier<CourierStore> store, CourierAttachments attachments) {
        this.module = module;
        this.store = store;
        this.attachments = attachments;
    }

    /** Reads every call may make even with Courier off: only the state. */
    private RpcHandler guarded(RpcHandler handler) {
        return (context, params) -> {
            RpcException no = module.refusal();
            if (no != null) {
                throw no;
            }
            try {
                return handler.handle(context, params);
            } catch (Actions.Refused r) {
                throw refused(r);
            } catch (IllegalArgumentException e) {
                throw bad(e.getMessage() != null && REASON.matcher(e.getMessage()).matches() ? e.getMessage() : "params");
            }
        };
    }

    void register(RpcDispatcher d) {
        d.register("courier.status", this::status);
        d.register("courier.list", guarded(this::list));
        d.register("courier.attention", guarded((c, p) -> store.get().queries().attention(System.currentTimeMillis())));
        d.register("courier.thread", guarded(this::thread));
        d.register("courier.message", guarded(this::message));
        d.register("courier.message.html", guarded(this::html));
        d.register("courier.search", guarded(this::search));
        d.register("courier.contacts.list", guarded(this::contacts));
        d.register("courier.contact.get", guarded(this::contact));
        d.register("courier.drafts.list", guarded((c, p) -> Map.of("drafts", store.get().queries().drafts())));
        d.register("courier.draft.get", guarded(this::draft));
        d.register("courier.outbound.list", guarded((c, p) -> Map.of("outbound", store.get().queries().outbound())));
        d.register("courier.accounts.list", guarded(this::accounts));
        d.register("courier.blocks.list", guarded(this::blocks));
        d.register("courier.keys", guarded(this::keys));
        d.registerMutation("courier.read.set", guarded(this::readSet));
        d.registerMutation("courier.move", guarded(this::move));
        d.registerMutation("courier.done", guarded(this::done));
        d.registerMutation("courier.request.decide", guarded(this::decide));
        d.registerMutation("courier.block", guarded(this::block));
        d.registerMutation("courier.unblock", guarded(this::unblock));
        d.registerMutation("courier.delete", guarded(this::delete));
        d.registerMutation("courier.trash.empty", guarded(this::emptyTrash));
        d.registerMutation("courier.draft.save", guarded(this::draftSave));
        d.registerMutation("courier.draft.discard", guarded(this::draftDiscard));
        d.registerMutation("courier.send", guarded(this::send));
        d.registerMutation("courier.send.undo", guarded(this::undo));
        d.registerMutation("courier.contact.rename", guarded(this::rename));
        d.registerMutation("courier.contact.merge", guarded(this::merge));
        d.registerMutation("courier.accounts.add", guarded(this::accountAdd));
        d.registerMutation("courier.accounts.remove", guarded(this::accountRemove));
        d.registerMutation("courier.accounts.signin", guarded(this::accountSignIn));
        d.register("courier.accounts.providers", guarded(this::providers));
        d.register("courier.accounts.check", guarded(this::accountCheck));
        // Spam and safety (Wave 3.2) and attachments (Wave 3.1).
        d.registerMutation("courier.report", guarded(this::report));
        d.registerMutation("courier.attachment.save", guarded(this::attachmentSave));
        d.register("courier.attachment.read", guarded(this::attachmentRead));
        d.register("courier.attachment.image", guarded(this::attachmentImage));
        d.register("courier.attachment.archive", guarded(this::attachmentArchive));
        d.register("courier.message.raw", guarded(this::messageRaw));
        d.register("courier.attachment.stop", guarded(this::attachmentStop));
        // One person across channels (flow 11): a link is only ever the member's press.
        d.register("courier.links.suggest", guarded(this::linksSuggest));
        d.register("courier.links.lookup", guarded(this::linksLookup));
        d.registerMutation("courier.links.link", guarded(this::linksLink));
        d.registerMutation("courier.links.undo", guarded(this::linksUndo));
        d.registerMutation("courier.links.unlink", guarded(this::linksUnlink));
        d.registerMutation("courier.links.dismiss", guarded(this::linksDismiss));
    }

    // ---- one person across channels

    private Object linksSuggest(RpcContext context, Map<String, Object> params) throws Exception {
        String[] ep = params.get("endpoint") == null ? null : endpoint(params);
        return Map.of("suggestions", store.get().links().suggest(ep == null ? null : ep[0], ep == null ? null : ep[1]));
    }

    private Object linksLookup(RpcContext context, Map<String, Object> params) throws Exception {
        String[] ep = endpoint(params);
        return store.get().links().lookup(ep[0], ep[1]);
    }

    private Object linksLink(RpcContext context, Map<String, Object> params) throws Exception {
        String into = id(params, "into");
        String from = params.get("from") == null ? null : id(params, "from");
        String[] ep = from == null ? endpoint(params) : null;
        if (from != null && params.get("endpoint") != null) {
            throw bad("endpoint");
        }
        context.beginEffect();
        var linked = store.get().links().link(into, from, ep == null ? null : ep[0], ep == null ? null : ep[1]);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("linkId", linked.linkId());
        out.put("channelId", linked.channelId());
        return out;
    }

    private Object linksUndo(RpcContext context, Map<String, Object> params) throws Exception {
        String linkId = id(params, "linkId");
        context.beginEffect();
        store.get().links().undo(linkId);
        return Map.of();
    }

    private Object linksUnlink(RpcContext context, Map<String, Object> params) throws Exception {
        String[] ep = endpoint(params);
        context.beginEffect();
        var unlinked = store.get().links().unlink(ep[0], ep[1]);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("contactId", unlinked.contactId());
        out.put("channelId", unlinked.channelId());
        return out;
    }

    private Object linksDismiss(RpcContext context, Map<String, Object> params) throws Exception {
        String[] ep = endpoint(params);
        String into = id(params, "into");
        context.beginEffect();
        store.get().links().dismiss(ep[0], ep[1], into);
        return Map.of();
    }

    /** {@code endpoint: {kind, value}}: an email, a member address, a number or an Apple ID, as the store keeps it. */
    private static String[] endpoint(Map<String, Object> params) throws RpcException {
        if (!(params.get("endpoint") instanceof Map<?, ?> m) || !(m.get("kind") instanceof String kind) || !(m.get("value") instanceof String value)
                || value.length() > 320 || !LINK_KINDS.contains(kind)) {
            throw bad("endpoint");
        }
        String v = Norm.endpoint(kind, value.strip());
        if (v == null) {
            throw bad("endpoint");
        }
        return new String[] {kind, v};
    }

    private static final java.util.Set<String> LINK_KINDS = java.util.Set.of("email", "ma", "phone", "apple");

    private Object attachmentStop(RpcContext context, Map<String, Object> params) throws Exception {
        if (!(params.get("transferId") instanceof Number n) || n.longValue() < 0 || n.longValue() > 0xFFFFFFFFL || n.doubleValue() != n.longValue()) {
            throw bad("transferId");
        }
        attachments.stop(context, n.longValue());
        return Map.of();
    }

    // ---- spam and safety, attachments

    /** {@code courier.report}: "Report spam", with {@code block} to block each sender's address too. */
    private Object report(RpcContext context, Map<String, Object> params) throws Exception {
        List<String> ids = ids(params);
        if (ids == null) {
            throw bad("messageIds");
        }
        boolean block = bool(params, "block", false);
        context.beginEffect();
        return Map.of("reported", store.get().actions().report(ids, block));
    }

    private Object attachmentSave(RpcContext context, Map<String, Object> params) throws Exception {
        return attachments.save(context, id(params, "messageId"), part(params), bool(params, "allowDanger", false), zone(params));
    }

    private Object attachmentRead(RpcContext context, Map<String, Object> params) throws Exception {
        return attachments.read(context, id(params, "messageId"), part(params), bool(params, "allowDanger", false));
    }

    private Object attachmentImage(RpcContext context, Map<String, Object> params) throws Exception {
        return attachments.image(context, id(params, "messageId"), part(params));
    }

    private Object attachmentArchive(RpcContext context, Map<String, Object> params) throws Exception {
        return attachments.archive(id(params, "messageId"), part(params));
    }

    private Object messageRaw(RpcContext context, Map<String, Object> params) throws Exception {
        return attachments.raw(context, id(params, "messageId"), zone(params), bool(params, "allowDanger", false));
    }

    private static String part(Map<String, Object> params) throws RpcException {
        Object o = params.get("part");
        if (!(o instanceof String s) || !PART.matcher(s).matches()) {
            throw bad("part");
        }
        return s;
    }

    // ---- reads

    private Object status(RpcContext context, Map<String, Object> params) throws Exception {
        if (module.guildDesk()) {
            throw scope();
        }
        Map<String, Object> out = new LinkedHashMap<>();
        RpcException no = module.refusal();
        out.put("state", no == null ? "on" : "switched_off".equals(no.details().get("reason")) ? "off" : "unavailable");
        out.put("reason", no == null ? null : no.details().get("reason"));
        if (no == null) {
            CourierStore s = store.get();
            out.putAll(s.queries().counts());
            out.put("bytes", s.bytes());
            out.put("sending", module.sending());
        }
        return out;
    }

    /**
     * The desk's own Courier keys (public facts only), and with {@code peer} (a contact's identity key, base64url) the
     * safety number between them (draft ADR "Courier's envelopes").
     */
    private Object keys(RpcContext context, Map<String, Object> params) throws Exception {
        DeskKeys keys = module.keys();
        if (keys == null || !keys.available()) {
            throw new RpcException(RpcException.UNAVAILABLE, "This desk's keys can't be used", Map.of("reason", "keys"));
        }
        Map<String, Object> out = new LinkedHashMap<>(keys.status());
        Object peer = params.get("peer");
        if (peer != null) {
            IdentityKey key;
            try {
                key = IdentityKey.parse(peer);
            } catch (EnvelopeException e) {
                throw bad("peer");
            }
            out.put("safetyNumber", keys.safetyNumber(key));
        }
        return out;
    }

    private Object list(RpcContext context, Map<String, Object> params) throws Exception {
        String lane = lane(params, "lane", true);
        String accountId = optional(params, "accountId", 64);
        if (accountId != null && !ACCOUNT_ID.matcher(accountId).matches()) {
            throw bad("accountId");
        }
        return store.get().queries().list(lane, accountId, params.get("before"), limit(params, 50), bool(params, "includeDone", false));
    }

    private Object thread(RpcContext context, Map<String, Object> params) throws Exception {
        String channelId = id(params, "channelId");
        Map<String, Object> out = store.get().queries().thread(channelId, lane(params, "lane", false), params.get("before"), limit(params, 50));
        if (out == null) {
            throw notFound();
        }
        return out;
    }

    private Object message(RpcContext context, Map<String, Object> params) throws Exception {
        Map<String, Object> out = store.get().queries().message(id(params, "messageId"), offset(params));
        if (out == null) {
            throw notFound();
        }
        return out;
    }

    private Object html(RpcContext context, Map<String, Object> params) throws Exception {
        Map<String, Object> out = store.get().queries().html(id(params, "messageId"), offset(params));
        if (out == null) {
            throw notFound();
        }
        return out;
    }

    private Object search(RpcContext context, Map<String, Object> params) throws Exception {
        Object q = params.get("q");
        if (!(q instanceof String text) || text.length() > SearchQuery.MAX_CHARS) {
            throw bad("q");
        }
        SearchQuery query = SearchQuery.parse(text);
        if (query.isEmpty()) {
            return Map.of("hits", List.of());
        }
        String lane = lane(params, "lane", false);
        List<String> lanes = lane != null ? List.of(lane) : queryLanes(text);
        String channelId = params.get("channelId") == null ? null : id(params, "channelId");
        return store.get().queries().search(query, lanes, channelId, params.get("before"), limit(params, 50), zone(params));
    }

    /** {@code in:spam} and {@code in:trash} reach those lanes; otherwise a member's search leaves them out. */
    private static List<String> queryLanes(String q) {
        String lower = q.toLowerCase(java.util.Locale.ROOT);
        if (lower.contains("in:spam") || lower.contains("in:trash") || lower.contains("in:all")) {
            return Lanes.ALL;
        }
        return Lanes.DEFAULT_VISIBLE;
    }

    private Object contacts(RpcContext context, Map<String, Object> params) throws Exception {
        return store.get().queries().contacts(optional(params, "q", 200), params.get("after"), limit(params, 50));
    }

    private Object contact(RpcContext context, Map<String, Object> params) throws Exception {
        Map<String, Object> out = store.get().queries().contactById(id(params, "contactId"));
        if (out == null) {
            throw notFound();
        }
        return out;
    }

    private Object draft(RpcContext context, Map<String, Object> params) throws Exception {
        Map<String, Object> out = store.get().queries().draft(id(params, "draftId"));
        if (out == null) {
            throw notFound();
        }
        return out;
    }

    private Object accounts(RpcContext context, Map<String, Object> params) throws Exception {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Courier.Account a : store.get().accounts()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("accountId", a.id());
            m.put("kind", a.kind());
            m.put("label", a.label());
            m.put("address", a.address());
            m.put("state", a.state());
            m.put("sending", store.get().outbox().canSend(mediumOf(a.kind()), a.id()));
            LinkedAccounts linked = module.linkedAccounts();
            // A linked mailbox's sync, for "Bringing in older mail" and "Needs you" (API.md §21); the Mac's, for iMessage.
            CourierModule.LinkedTransport t = module.transport();
            CourierModule.ImessageTransport im = module.imessage();
            Map<String, Object> sync = t != null && Accounts.LINKED.contains(a.kind()) ? t.status(a.id())
                    : im != null && Accounts.IMESSAGE.equals(a.kind()) ? im.status(a.id()) : null;
            // Signed in means a sign-in the desk can use: sealed, and not refused by the provider (or the Mac) since.
            m.put("signedIn", Accounts.SEALED.contains(a.kind()) && linked != null
                    ? linked.signedIn(a.id()) && !(sync != null && "needs_you".equals(sync.get("state"))) : null);
            m.put("sync", sync);
            out.add(m);
        }
        return Map.of("accounts", out);
    }

    // ---- linked mailboxes (the vault, Wave 1.3)

    private static final Pattern HOST = Pattern.compile("[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?");
    private static final java.security.SecureRandom IDS = new java.security.SecureRandom();

    /**
     * {@code courier.accounts.add}: a linked mailbox, write-only. The sign-in is checked with the provider by the
     * transport, sealed on the desk, and never sent back or logged; the row is the commit point. Until a transport for
     * the kind is there (Wave 2.1), it's {@code unavailable} {@code {reason: medium}} before anything is kept.
     */
    private Object accountAdd(RpcContext context, Map<String, Object> params) throws Exception {
        LinkedAccounts linked = module.linkedAccounts();
        String kind = required(params, "kind", 16);
        if (Accounts.IMESSAGE.equals(kind)) {
            return imessageAdd(context, params);
        }
        if (!Accounts.LINKED.contains(kind)) {
            throw bad("kind");
        }
        String address = Norm.email(required(params, "address", 320));
        if (address == null) {
            throw bad("address");
        }
        String label = optional(params, "label", 80);
        String username = optional(params, "username", 320);
        String auth = required(params, "auth", 16);
        if (!auth.equals(SignIn.PASSWORD) && !auth.equals(SignIn.APP_PASSWORD)) {
            throw bad("auth");
        }
        // A provider the setup screen offers fills in its own servers; "other" is the member's.
        String provider = optional(params, "provider", 16);
        if (provider == null && params.get("server") == null && Accounts.IMAP.equals(kind)) {
            // The office names no provider and sends servers only for "Other": the address says which it is.
            CourierModule.LinkedTransport t = module.transport();
            provider = t == null ? null : t.providerFor(address);
        }
        Map<String, Object> preset = provider == null ? null : preset(provider);
        if (provider != null && preset == null) {
            throw bad("provider");
        }
        if (preset != null && Boolean.FALSE.equals(preset.get("available"))) {
            // Outlook takes Microsoft sign-in only (Wave 2.2): nothing is kept.
            throw new RpcException(RpcException.UNAVAILABLE, "This mailbox needs its own sign-in, which isn't here yet",
                    Map.of("reason", "oauth"));
        }
        Object serverParam = params.get("server");
        if (serverParam == null && preset != null && preset.get("imapHost") != null) {
            Map<String, Object> filled = new LinkedHashMap<>();
            for (String k : new String[] {"imapHost", "imapPort", "smtpHost", "smtpPort", "security"}) {
                filled.put(k, preset.get(k));
            }
            serverParam = filled;
        }
        String server = server(serverParam);
        if (Accounts.IMAP.equals(kind) && (server == null || !server.contains("\"imapHost\"") || !server.contains("\"smtpHost\""))) {
            throw bad("server");
        }
        byte[] secret = secret(params.get("secret"));
        String accountId = kind + "-" + java.util.HexFormat.of().formatHex(randomBytes(10));
        String shown = label != null ? label : preset != null && !"other".equals(provider) ? (String) preset.get("label") : address;
        Courier.Account account = new Courier.Account(accountId, kind, shown, address, "ok");
        try (SignIn signIn = new SignIn(auth, username == null || username.isBlank() ? address : username, secret, null, 0, server)) {
            if (linked == null) {
                throw new RpcException(RpcException.UNAVAILABLE, "Courier's store can't be used", Map.of("reason", "store"));
            }
            Courier.Account same = linked.sameMailbox(account);
            if (same != null) {
                // The office's "Sign in again" is this form again: a mailbox already here that needs a sign-in takes the new one
                // (checked, sealed over its own); one that's fine is linked already.
                if (!needsSignIn(linked, same)) {
                    throw new RpcException(RpcException.CONFLICT, "This mailbox is linked already", Map.of("reason", "exists"));
                }
                signInAgain(context, linked, same, signIn, preset != null && !"other".equals(provider) ? preset : null);
                return Map.of("accountId", same.id());
            }
            try {
                linked.check(account, signIn);
                context.beginEffect();
                linked.keep(account, List.<String[]>of(new String[] {"email", address}), signIn);
                CourierModule.LinkedTransport t = module.transport();
                if (t != null) {
                    t.added(accountId);
                }
            } catch (LinkedAccounts.Refused r) {
                throw switch (r.reason()) {
                    case "no_transport" -> new RpcException(RpcException.UNAVAILABLE, "No transport can sign in to this kind of mailbox yet",
                            Map.of("reason", "medium"));
                    case "too_many", "exists" -> new RpcException(RpcException.CONFLICT, "Can't add another mailbox", Map.of("reason", r.reason()));
                    default -> new RpcException(RpcException.UNAVAILABLE, "The sign-in couldn't be kept", Map.of("reason", "storage"));
                };
            } catch (LinkedAccounts.Rejected r) {
                throw rejected(r, providerName(preset != null && !"other".equals(provider) ? preset : null, server));
            } catch (java.io.IOException e) {
                throw new RpcException(RpcException.UNAVAILABLE, "The mailbox couldn't be reached", Map.of("reason", "provider"));
            }
        }
        return Map.of("accountId", accountId);
    }

    /** {@code courier.accounts.remove}: the row (and its mail unless {@code keepMail}), then the sealed sign-in. */
    private Object accountRemove(RpcContext context, Map<String, Object> params) throws Exception {
        String accountId = required(params, "accountId", 64);
        LinkedAccounts linked = module.linkedAccounts();
        Courier.Account found = null;
        for (Courier.Account a : store.get().accounts()) {
            if (a.id().equals(accountId)) {
                found = a;
            }
        }
        if (found == null) {
            throw notFound();
        }
        if (!Accounts.SEALED.contains(found.kind())) {
            throw bad("accountId");
        }
        boolean keepMail = bool(params, "keepMail", false);
        context.beginEffect();
        // Its sync and sender stop first, so nothing writes for it once it's gone.
        CourierModule.LinkedTransport t = module.transport();
        CourierModule.ImessageTransport im = module.imessage();
        if (Accounts.IMESSAGE.equals(found.kind())) {
            if (im != null) {
                im.removing(accountId);
            }
        } else if (t != null) {
            t.removing(accountId);
        }
        if (!linked.remove(accountId, keepMail)) {
            throw notFound();
        }
        return Map.of();
    }

    /**
     * {@code courier.accounts.signin}: "Sign in again" for a linked mailbox whose provider stopped taking its sign-in (a new
     * app password, a revoked one replaced). Write-only like {@code add}: checked with the provider, sealed over the old one,
     * never sent back.
     */
    private Object accountSignIn(RpcContext context, Map<String, Object> params) throws Exception {
        String accountId = required(params, "accountId", 64);
        LinkedAccounts linked = module.linkedAccounts();
        Courier.Account found = null;
        for (Courier.Account a : store.get().accounts()) {
            if (a.id().equals(accountId)) {
                found = a;
            }
        }
        if (found == null || linked == null) {
            throw notFound();
        }
        if (Accounts.IMESSAGE.equals(found.kind())) {
            return imessageSignIn(context, params, linked, found);
        }
        if (!Accounts.LINKED.contains(found.kind())) {
            throw bad("accountId");
        }
        String username = optional(params, "username", 320);
        String server;
        String kind;
        String user;
        try (SignIn old = linked.open(accountId)) {
            server = old.server();
            kind = old.kind();
            user = old.username();
        } catch (java.io.IOException e) {
            // The sealed one is gone or won't open: the member gives the servers again.
            server = server(params.get("server"));
            kind = SignIn.APP_PASSWORD;
            user = found.address();
            if (server == null) {
                throw bad("server");
            }
        }
        byte[] secret = secret(params.get("secret"));
        try (SignIn fresh = new SignIn(kind, username == null || username.isBlank() ? user : username, secret, null, 0, server)) {
            signInAgain(context, linked, found, fresh, null);
        }
        return Map.of();
    }

    // ---- iMessage through the member's Mac (Wave 2.6, the imsg seam)

    /**
     * {@code courier.accounts.add {kind: imessage, path: bluebubbles, server, secret}}: the member's BlueBubbles Server,
     * write-only. The desk connects to the address over HTTPS and asks the server about itself with the password before
     * anything is kept; then the address and the password are sealed together (as a linked mailbox's sign-in is), and only
     * "Connected" ever goes back. One Mac a desk.
     */
    private Object imessageAdd(RpcContext context, Map<String, Object> params) throws Exception {
        LinkedAccounts linked = module.linkedAccounts();
        CourierModule.ImessageTransport im = module.imessage();
        if (linked == null) {
            throw new RpcException(RpcException.UNAVAILABLE, "Courier's store can't be used", Map.of("reason", "store"));
        }
        if (im == null) {
            throw new RpcException(RpcException.UNAVAILABLE, "iMessage isn't here yet", Map.of("reason", "medium"));
        }
        String path = optional(params, "path", 32);
        path = path == null ? "bluebubbles" : path;
        if (!path.equals("bluebubbles")) {
            // MA's Mac connector pairs through its own flow, not this form.
            throw bad("path");
        }
        String server = required(params, "server", 300);
        byte[] secret = secret(params.get("secret"));
        try {
            try {
                linked.room(Accounts.IMESSAGE);
            } catch (LinkedAccounts.Refused r) {
                throw new RpcException(RpcException.CONFLICT, "This desk has a Mac already", Map.of("reason", r.reason()));
            }
            CourierModule.ImessageTransport.Probe probe = imessageProbe(im, path, server, secret, null, null);
            String accountId = "imessage-" + java.util.HexFormat.of().formatHex(randomBytes(10));
            Courier.Account account = new Courier.Account(accountId, Accounts.IMESSAGE, probe.label(), ownHandle(probe.own()), "ok");
            try (SignIn signIn = new SignIn(SignIn.PASSWORD, probe.username(), secret, null, 0, probe.server())) {
                secret = null;
                context.beginEffect();
                linked.keep(account, probe.own(), signIn);
            } catch (LinkedAccounts.Refused r) {
                throw switch (r.reason()) {
                    case "too_many", "exists" -> new RpcException(RpcException.CONFLICT, "This desk has a Mac already", Map.of("reason", r.reason()));
                    default -> new RpcException(RpcException.UNAVAILABLE, "The sign-in couldn't be kept", Map.of("reason", "storage"));
                };
            }
            im.added(accountId);
            return Map.of("accountId", accountId);
        } finally {
            if (secret != null) {
                java.util.Arrays.fill(secret, (byte) 0);
            }
        }
    }

    /**
     * {@code courier.accounts.signin {accountId, secret, server?}} for the Mac: a new password, or a new address (a
     * Cloudflare tunnel's address changes when BlueBubbles restarts). Checked as {@code add} is, sealed over the old one.
     */
    private Object imessageSignIn(RpcContext context, Map<String, Object> params, LinkedAccounts linked, Courier.Account found)
            throws Exception {
        CourierModule.ImessageTransport im = module.imessage();
        if (im == null) {
            throw new RpcException(RpcException.UNAVAILABLE, "iMessage isn't here yet", Map.of("reason", "medium"));
        }
        String server = optional(params, "server", 300);
        String accept = optional(params, "acceptCertificate", 80);
        String prior = null;
        String oldUrl = null;
        String path = "bluebubbles";
        try (SignIn old = linked.open(found.id())) {
            prior = old.server();
            Map<String, Object> srv = com.minimalistalliance.desk.deskd.protocol.Json.parseObject(
                    prior.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            oldUrl = srv.get("url") instanceof String u ? u : null;
            path = srv.get("path") instanceof String pt ? pt : path;
        } catch (Exception e) {
            // The sealed one is gone or won't open: the member gives the address again, and it's checked as a new one.
        }
        if (!path.equals("bluebubbles")) {
            throw bad("path");
        }
        String address = server != null ? server : oldUrl;
        if (address == null) {
            throw bad("server");
        }
        byte[] secret = secret(params.get("secret"));
        try {
            // The path decides whether the address is the same Mac's, and keeps its pin only then (Security IM-M1).
            CourierModule.ImessageTransport.Probe probe = imessageProbe(im, path, address, secret, prior, accept);
            try (SignIn fresh = new SignIn(SignIn.PASSWORD, probe.username(), secret, null, 0, probe.server())) {
                secret = null;
                context.beginEffect();
                linked.change(found.id(), fresh);
            } catch (LinkedAccounts.Refused r) {
                throw "not_found".equals(r.reason()) ? notFound()
                        : new RpcException(RpcException.UNAVAILABLE, "The sign-in couldn't be kept", Map.of("reason", "storage"));
            }
            im.signedIn(found.id());
            return Map.of();
        } finally {
            if (secret != null) {
                java.util.Arrays.fill(secret, (byte) 0);
            }
        }
    }

    /** The Mac's check, as the office words its no (the Designer's flow 8: imErrHttps, imErrReach, imErrPassword, imErrMessages). */
    private static CourierModule.ImessageTransport.Probe imessageProbe(CourierModule.ImessageTransport im, String path, String address,
            byte[] secret, String prior, String accept) throws RpcException {
        try {
            return im.probe(path, address, secret, prior, accept);
        } catch (LinkedAccounts.Rejected r) {
            String word = REASON.matcher(r.reason()).matches() ? r.reason() : "address";
            if (word.equals("certificate_changed")) {
                // The Mac shows another certificate than the one pinned: nothing was sent to it. The office says so, with
                // the new fingerprint, and signs in again with acceptCertificate only on the member's word.
                Map<String, Object> d = new LinkedHashMap<>();
                d.put("reason", "certificate_changed");
                d.put("fingerprint", r.detail());
                throw new RpcException(RpcException.FORBIDDEN, "The Mac's certificate changed", d);
            }
            throw switch (word) {
                case "https" -> new RpcException(RpcException.BAD_REQUEST, "Courier only connects to a Mac over HTTPS", Map.of("reason", "https"));
                case "address", "host", "port" -> new RpcException(RpcException.BAD_REQUEST, "Check the Mac's address",
                        Map.of("reason", "server", "cause", word));
                case "password" -> new RpcException(RpcException.FORBIDDEN, "The Mac didn't accept that password",
                        Map.of("reason", "sign_in", "cause", "password"));
                case "messages" -> new RpcException(RpcException.FORBIDDEN, "The Mac isn't signed in to Messages", Map.of("reason", "messages"));
                case "path" -> bad("path");
                default -> new RpcException(RpcException.UNAVAILABLE, "The Mac didn't answer as BlueBubbles does",
                        Map.of("reason", "unreachable", "cause", word));
            };
        } catch (java.io.IOException e) {
            throw new RpcException(RpcException.UNAVAILABLE, "Couldn't reach the Mac at that address", Map.of("reason", "unreachable"));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RpcException(RpcException.UNAVAILABLE, "Couldn't reach the Mac at that address", Map.of("reason", "unreachable"));
        }
    }

    /** The member's own iMessage handle, as the account's address (an Apple ID or a number); null if the Mac named none. */
    private static String ownHandle(List<String[]> own) {
        return own.isEmpty() ? null : own.get(0)[1];
    }

    /** {@code courier.accounts.check {accountId}}: "Check again" for the Mac: it looks now. */
    private Object accountCheck(RpcContext context, Map<String, Object> params) throws Exception {
        String accountId = required(params, "accountId", 64);
        CourierModule.ImessageTransport im = module.imessage();
        CourierModule.LinkedTransport t = module.transport();
        for (Courier.Account a : store.get().accounts()) {
            if (a.id().equals(accountId)) {
                if (Accounts.IMESSAGE.equals(a.kind()) && im != null) {
                    im.poke(accountId);
                    return Map.of();
                }
                if (Accounts.LINKED.contains(a.kind()) && t != null) {
                    t.signedIn(accountId);
                    return Map.of();
                }
                throw bad("accountId");
            }
        }
        throw notFound();
    }

    /** A linked mailbox the transport can't sign in to: its sync stopped on the provider's no, or its sealed sign-in is gone. */
    private boolean needsSignIn(LinkedAccounts linked, Courier.Account a) {
        if (!linked.signedIn(a.id())) {
            return true;
        }
        CourierModule.LinkedTransport t = module.transport();
        Map<String, Object> st = t == null ? null : t.status(a.id());
        return st != null && "needs_you".equals(st.get("state"));
    }

    /** A new sign-in for an account here: checked with the provider, sealed over its own, and its sync told. */
    private void signInAgain(RpcContext context, LinkedAccounts linked, Courier.Account found, SignIn fresh, Map<String, Object> preset)
            throws RpcException {
        try {
            linked.recheck(found, fresh);
            context.beginEffect();
            linked.change(found.id(), fresh);
        } catch (LinkedAccounts.Refused r) {
            throw switch (r.reason()) {
                case "no_transport" -> new RpcException(RpcException.UNAVAILABLE, "No transport can sign in to this kind of mailbox yet",
                        Map.of("reason", "medium"));
                case "not_found" -> notFound();
                default -> new RpcException(RpcException.UNAVAILABLE, "The sign-in couldn't be kept", Map.of("reason", "storage"));
            };
        } catch (LinkedAccounts.Rejected r) {
            throw rejected(r, providerName(preset, fresh.server()));
        } catch (java.io.IOException e) {
            throw new RpcException(RpcException.UNAVAILABLE, "The mailbox couldn't be reached", Map.of("reason", "provider"));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RpcException(RpcException.UNAVAILABLE, "The mailbox couldn't be reached", Map.of("reason", "provider"));
        }
        CourierModule.LinkedTransport t = module.transport();
        if (t != null) {
            t.signedIn(found.id());
        }
    }

    /**
     * A sign-in the transport turned down, as the office words it: servers the desk won't connect to are the member's to
     * fix ({@code bad_request server}); a server that wouldn't talk is {@code unavailable provider}; only the provider
     * refusing the sign-in itself is {@code forbidden sign_in}, with {@code provider} the provider's name for the sentence
     * ("Gmail didn't accept that password") and {@code cause} the word for why.
     */
    static RpcException rejected(LinkedAccounts.Rejected r, String providerName) {
        String word = REASON.matcher(r.reason()).matches() ? r.reason() : "auth";
        return switch (word) {
            case "server", "host", "port", "address" -> new RpcException(RpcException.BAD_REQUEST, "Check the mailbox's servers",
                    Map.of("reason", "server", "cause", word));
            case "tls", "imap", "smtp" -> new RpcException(RpcException.UNAVAILABLE, "The mailbox's server didn't answer as one should",
                    Map.of("reason", "provider", "cause", word));
            case "oauth" -> new RpcException(RpcException.UNAVAILABLE, "This mailbox needs its own sign-in, which isn't here yet",
                    Map.of("reason", "oauth"));
            default -> {
                Map<String, Object> d = new LinkedHashMap<>();
                d.put("reason", "sign_in");
                d.put("cause", word);
                if (providerName != null) {
                    d.put("provider", providerName);
                }
                yield new RpcException(RpcException.FORBIDDEN, "The mailbox refused the sign-in", d);
            }
        };
    }

    /** The named provider's name for the office's sentence, from its preset or its servers; null for any other mailbox. */
    private String providerName(Map<String, Object> preset, String server) {
        if (preset != null) {
            return (String) preset.get("label");
        }
        CourierModule.LinkedTransport t = module.transport();
        if (t == null || server == null) {
            return null;
        }
        for (Map<String, Object> p : t.providers()) {
            Object host = p.get("imapHost");
            if (host != null && server.contains("\"imapHost\":\"" + host + "\"")) {
                return (String) p.get("label");
            }
        }
        return null;
    }

    /** {@code courier.accounts.providers}: what the setup screen offers, with where each makes an app password. */
    private Object providers(RpcContext context, Map<String, Object> params) {
        CourierModule.LinkedTransport t = module.transport();
        return Map.of("providers", t == null ? List.of() : t.providers());
    }

    private Map<String, Object> preset(String provider) {
        CourierModule.LinkedTransport t = module.transport();
        if (t == null) {
            return null;
        }
        for (Map<String, Object> p : t.providers()) {
            if (provider.equals(p.get("provider"))) {
                return p;
            }
        }
        return null;
    }

    /** The secret as bytes: 1 to 8,192 of UTF-8, no controls. The JSON string it came in can't be zeroed (ADR 0040). */
    static byte[] secret(Object value) throws RpcException {
        if (!(value instanceof String s) || s.isEmpty() || s.length() > 8192 || s.chars().anyMatch(c -> c < 0x20 || c == 0x7F)) {
            throw bad("secret");
        }
        byte[] bytes = s.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        if (bytes.length > 8192) {
            java.util.Arrays.fill(bytes, (byte) 0);
            throw bad("secret");
        }
        return bytes;
    }

    /** A linked mailbox's servers, as the transport keeps them: hosts, ports and the security, nothing else. */
    static String server(Object value) throws RpcException {
        if (value == null) {
            return null;
        }
        if (!(value instanceof Map<?, ?> m) || m.size() > 5) {
            throw bad("server");
        }
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<?, ?> e : m.entrySet()) {
            String k = String.valueOf(e.getKey());
            Object v = e.getValue();
            switch (k) {
                case "imapHost", "smtpHost" -> {
                    if (!(v instanceof String h) || !HOST.matcher(h).matches()) {
                        throw bad("server");
                    }
                    out.put(k, h.toLowerCase(java.util.Locale.ROOT));
                }
                case "imapPort", "smtpPort" -> {
                    // Which ports a desk may open (993; 465, 587) is the transport's to say, at the check: bad_request server.
                    if (!(v instanceof Number n) || n.doubleValue() != n.longValue() || n.longValue() < 1 || n.longValue() > 65535) {
                        throw bad("server");
                    }
                    out.put(k, n.intValue());
                }
                case "security" -> {
                    if (!"tls".equals(v) && !"starttls".equals(v)) {
                        throw bad("server");
                    }
                    out.put(k, v);
                }
                default -> throw bad("server");
            }
        }
        if (out.get("smtpPort") instanceof Integer port) {
            // The port says how submission starts its TLS, whatever the form's choice said.
            out.put("security", port == 587 ? "starttls" : "tls");
        }
        return new String(com.minimalistalliance.desk.deskd.protocol.Json.bytes(out), java.nio.charset.StandardCharsets.UTF_8);
    }

    private static byte[] randomBytes(int n) {
        byte[] b = new byte[n];
        IDS.nextBytes(b);
        return b;
    }

    static String mediumOf(String accountKind) {
        return switch (accountKind) {
            case "ma" -> "ma";
            case "imessage" -> "imessage";
            default -> "email";
        };
    }

    private Object blocks(RpcContext context, Map<String, Object> params) throws Exception {
        List<Map<String, Object>> out = new ArrayList<>();
        for (String[] b : store.get().actions().blocks()) {
            out.add(Map.of("kind", b[0], "value", b[1]));
        }
        return Map.of("blocks", out);
    }

    // ---- mutations

    private Object readSet(RpcContext context, Map<String, Object> params) throws Exception {
        Target t = target(params);
        boolean read = bool(params, "read", true);
        context.beginEffect();
        return Map.of("changed", store.get().actions().setRead(t.ids, t.channelId, t.lane, read));
    }

    private Object move(RpcContext context, Map<String, Object> params) throws Exception {
        Target t = target(params);
        String to = required(params, "to", 16);
        context.beginEffect();
        return Map.of("moved", store.get().actions().move(t.ids, t.channelId, t.lane, to));
    }

    private Object done(RpcContext context, Map<String, Object> params) throws Exception {
        String channelId = id(params, "channelId");
        String lane = lane(params, "lane", true);
        boolean done = bool(params, "done", true);
        context.beginEffect();
        if (!store.get().actions().done(channelId, lane, done)) {
            throw notFound();
        }
        return Map.of();
    }

    private Object decide(RpcContext context, Map<String, Object> params) throws Exception {
        String channelId = id(params, "channelId");
        String decision = required(params, "decision", 16);
        context.beginEffect();
        if (!store.get().actions().decide(channelId, decision)) {
            throw notFound();
        }
        return Map.of();
    }

    private Object block(RpcContext context, Map<String, Object> params) throws Exception {
        String kind = required(params, "kind", 16);
        String value = required(params, "value", 320);
        context.beginEffect();
        return Map.of("senders", store.get().actions().block(kind, value));
    }

    private Object unblock(RpcContext context, Map<String, Object> params) throws Exception {
        String kind = required(params, "kind", 16);
        String value = required(params, "value", 320);
        context.beginEffect();
        if (!store.get().actions().unblock(kind, value)) {
            throw notFound();
        }
        return Map.of();
    }

    private Object delete(RpcContext context, Map<String, Object> params) throws Exception {
        List<String> ids = ids(params);
        if (ids == null) {
            throw bad("messageIds");
        }
        boolean forever = bool(params, "forever", false);
        context.beginEffect();
        return Map.of("deleted", store.get().actions().delete(ids, forever));
    }

    private Object emptyTrash(RpcContext context, Map<String, Object> params) throws Exception {
        context.beginEffect();
        return Map.of("deleted", store.get().actions().emptyTrash());
    }

    private Object draftSave(RpcContext context, Map<String, Object> params) throws Exception {
        String draftId = params.get("draftId") == null ? null : id(params, "draftId");
        String channelId = params.get("channelId") == null ? null : id(params, "channelId");
        String medium = optional(params, "medium", 16);
        String accountId = optional(params, "accountId", 64);
        if (accountId != null && !ACCOUNT_ID.matcher(accountId).matches()) {
            throw bad("accountId");
        }
        List<String> to = null;
        if (params.get("to") != null) {
            if (!(params.get("to") instanceof List<?> list) || list.size() > 50) {
                throw bad("to");
            }
            to = new ArrayList<>();
            for (Object o : list) {
                if (!(o instanceof String s) || s.length() > 320) {
                    throw bad("to");
                }
                to.add(s);
            }
        }
        String subject = optional(params, "subject", 998);
        Object text = params.get("text");
        if (!(text instanceof String body)) {
            throw bad("text");
        }
        if (body.length() > Actions.MAX_DRAFT_TEXT) {
            throw new RpcException(RpcException.TOO_LARGE, "Too long", Map.of("reason", "text"));
        }
        String replyTo = params.get("replyTo") == null ? null : id(params, "replyTo");
        Long base = params.get("baseVersion") instanceof Number n ? n.longValue() : null;
        if (params.get("baseVersion") != null && base == null) {
            throw bad("baseVersion");
        }
        context.beginEffect();
        Object[] saved = store.get().actions().saveDraft(draftId, channelId, medium, accountId, to, subject, body, replyTo, base);
        return Map.of("draftId", saved[0], "version", saved[1]);
    }

    private Object draftDiscard(RpcContext context, Map<String, Object> params) throws Exception {
        String draftId = id(params, "draftId");
        context.beginEffect();
        if (!store.get().actions().discardDraft(draftId)) {
            throw notFound();
        }
        return Map.of();
    }

    private Object send(RpcContext context, Map<String, Object> params) throws Exception {
        String draftId = id(params, "draftId");
        if (!module.sending()) {
            throw new RpcException(RpcException.UNAVAILABLE, "Sending is switched off", Map.of("reason", "switched_off"));
        }
        // Before the effect, so a refusal for no transport says nothing was done (API.md §4).
        Map<String, Object> draft = store.get().queries().draft(draftId);
        if (draft == null) {
            throw notFound();
        }
        Object medium = draft.get("medium");
        Object accountId = draft.get("accountId");
        if (medium instanceof String m && accountId instanceof String a && !store.get().outbox().canSend(m, a)) {
            throw new RpcException(RpcException.UNAVAILABLE, "Nothing can send this now", Map.of("reason", "medium"));
        }
        context.beginEffect();
        Object[] sent = store.get().outbox().send(draftId);
        return Map.of("messageId", sent[0], "outboundId", sent[1], "undoUntil", sent[2]);
    }

    private Object undo(RpcContext context, Map<String, Object> params) throws Exception {
        String outboundId = id(params, "outboundId");
        context.beginEffect();
        return Map.of("draftId", store.get().outbox().undo(outboundId));
    }

    private Object rename(RpcContext context, Map<String, Object> params) throws Exception {
        String contactId = id(params, "contactId");
        String name = required(params, "name", 200);
        context.beginEffect();
        if (!store.get().actions().renameContact(contactId, name)) {
            throw notFound();
        }
        return Map.of();
    }

    private Object merge(RpcContext context, Map<String, Object> params) throws Exception {
        String into = id(params, "into");
        String from = id(params, "from");
        context.beginEffect();
        if (!store.get().actions().mergeContacts(into, from)) {
            throw notFound();
        }
        return Map.of();
    }

    // ---- params

    private record Target(List<String> ids, String channelId, String lane) {}

    /** {@code messageIds}, or {@code channelId} with an optional {@code lane}. */
    private static Target target(Map<String, Object> params) throws RpcException {
        List<String> ids = ids(params);
        if (ids != null) {
            return new Target(ids, null, null);
        }
        if (params.get("channelId") == null) {
            throw bad("messageIds");
        }
        return new Target(null, id(params, "channelId"), lane(params, "lane", false));
    }

    private static List<String> ids(Map<String, Object> params) throws RpcException {
        Object o = params.get("messageIds");
        if (o == null) {
            return null;
        }
        if (!(o instanceof List<?> list) || list.isEmpty() || list.size() > Actions.MAX_IDS) {
            throw bad("messageIds");
        }
        List<String> out = new ArrayList<>(list.size());
        for (Object item : list) {
            if (!(item instanceof String s) || !Ulid.valid(s)) {
                throw bad("messageIds");
            }
            out.add(s);
        }
        return out;
    }

    private static String id(Map<String, Object> params, String key) throws RpcException {
        Object o = params.get(key);
        if (!(o instanceof String s) || !Ulid.valid(s)) {
            throw bad(key);
        }
        return s;
    }

    private static String lane(Map<String, Object> params, String key, boolean required) throws RpcException {
        Object o = params.get(key);
        if (o == null && !required) {
            return null;
        }
        if (!(o instanceof String s) || !Lanes.valid(s)) {
            throw bad(key);
        }
        return s;
    }

    private static String required(Map<String, Object> params, String key, int max) throws RpcException {
        String s = optional(params, key, max);
        if (s == null || s.isEmpty()) {
            throw bad(key);
        }
        return s;
    }

    private static String optional(Map<String, Object> params, String key, int max) throws RpcException {
        Object o = params.get(key);
        if (o == null) {
            return null;
        }
        if (!(o instanceof String s) || s.length() > max) {
            throw bad(key);
        }
        return s;
    }

    private static boolean bool(Map<String, Object> params, String key, boolean otherwise) throws RpcException {
        Object o = params.get(key);
        if (o == null) {
            return otherwise;
        }
        if (!(o instanceof Boolean b)) {
            throw bad(key);
        }
        return b;
    }

    private static int limit(Map<String, Object> params, int otherwise) throws RpcException {
        Object o = params.get("limit");
        if (o == null) {
            return otherwise;
        }
        if (!(o instanceof Number n) || n.longValue() < 1 || n.longValue() > 100) {
            throw bad("limit");
        }
        return n.intValue();
    }

    private static int offset(Map<String, Object> params) throws RpcException {
        Object o = params.get("from");
        if (o == null) {
            return 0;
        }
        if (!(o instanceof Number n) || n.longValue() < 0 || n.longValue() > Integer.MAX_VALUE) {
            throw bad("from");
        }
        return n.intValue();
    }

    private static ZoneId zone(Map<String, Object> params) throws RpcException {
        Object o = params.get("zone");
        if (o == null) {
            return ZoneOffset.UTC;
        }
        if (!(o instanceof String s) || s.length() > 64) {
            throw bad("zone");
        }
        try {
            return ZoneId.of(s);
        } catch (RuntimeException e) {
            throw bad("zone");
        }
    }

    // ---- errors

    static RpcException bad(String reason) {
        return new RpcException(RpcException.BAD_REQUEST, "Not a valid request", Map.of("reason", reason));
    }

    static RpcException notFound() {
        return new RpcException(RpcException.NOT_FOUND, "No such item", Map.of());
    }

    static RpcException scope() {
        return new RpcException(RpcException.FORBIDDEN, "Courier is not available on this desk", Map.of("reason", "scope"));
    }

    private static RpcException refused(Actions.Refused r) {
        String code = switch (r.code()) {
            case "not_found" -> RpcException.NOT_FOUND;
            case "conflict" -> RpcException.CONFLICT;
            case "unavailable" -> RpcException.UNAVAILABLE;
            case "forbidden" -> RpcException.FORBIDDEN;
            case "too_large" -> RpcException.TOO_LARGE;
            default -> RpcException.BAD_REQUEST;
        };
        return new RpcException(code, "Not done", Map.of("reason", r.reason()));
    }
}
