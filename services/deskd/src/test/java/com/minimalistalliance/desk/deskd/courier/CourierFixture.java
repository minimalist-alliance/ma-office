package com.minimalistalliance.desk.deskd.courier;

import com.minimalistalliance.desk.deskd.courier.parse.CourierParser;
import com.minimalistalliance.desk.deskd.courier.store.AgentView;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Courier's real store filled by fixture ingest, for tests outside this package (the agent tools' socket test, the soak):
 * mail goes in as a transport would hand it, raw RFC 5322 bytes through the sink and the stand-in for {@code desk-parse}
 * ({@link TestMime}), since no transport exists yet. Three accounts: this desk's address ({@code me@desk.example}), where a
 * stranger is a Request; a linked Gmail ({@code me@gmail.example}), where a stranger is Other; and the member address.
 */
public final class CourierFixture implements AutoCloseable {

    public static final String DESK = StoreRig.DESK;
    public static final String GMAIL = StoreRig.GMAIL;

    private final StoreRig rig;
    /** The agent tools' view, made again on each {@link #reopen}. */
    private final AtomicReference<CourierRead> view = new AtomicReference<>();
    private volatile boolean other = true;

    public CourierFixture(Path dir) throws Exception {
        this(dir, TestMime.PARSER);
    }

    public CourierFixture(Path dir, CourierParser parser) throws Exception {
        this.rig = new StoreRig(dir, parser);
        view.set(new AgentView(rig.store, () -> true, () -> other));
    }

    public CourierStore store() {
        return rig.store;
    }

    public MutableClock clock() {
        return rig.clock;
    }

    /** The agent tools' view of the store open now ({@code CourierModule.read()}'s), with Other seen. */
    public CourierRead read() {
        return view.get();
    }

    /** What the tools are given: always the view of the store open now. */
    public java.util.function.Supplier<CourierRead> reads() {
        return view::get;
    }

    /** deskd stopped and started: the store closed and opened again, and a new view on it. */
    public void reopen() throws Exception {
        rig.reopen();
        view.set(new AgentView(rig.store, () -> true, () -> other));
    }

    /** The member wrote to this address once, so its mail is People's. */
    public void known(String address) throws Exception {
        rig.store.accept(Mail.from("Me <me@desk.example>").to(address).subject("hi").id("k-" + address).inbound(DESK).asOutgoing());
    }

    public Email email(String from) {
        return new Email(from);
    }

    /** The channel a message is in, by the member's view. */
    public String channel(String messageId) throws Exception {
        Map<String, Object> m = message(messageId);
        return m == null ? null : (String) m.get("channelId");
    }

    /** A message's lane, or null for one the member's view doesn't show (waiting for the parser). */
    public String lane(String messageId) throws Exception {
        Map<String, Object> m = message(messageId);
        return m == null ? null : (String) m.get("lane");
    }

    /** The member's view of a message (its lane, text, everything), or null. */
    public Map<String, Object> message(String messageId) throws Exception {
        return rig.store.queries().message(messageId, 0);
    }

    @Override
    public void close() {
        rig.close();
    }

    /** One email, built and then delivered as a transport would. */
    public final class Email {
        private final Mail mail;
        private String account = DESK;
        private Courier.Origin origin = Courier.Origin.LIVE;
        private Courier.Verdicts verdicts;

        Email(String from) {
            this.mail = Mail.from(from);
        }

        public Email to(String... to) {
            mail.to(to);
            return this;
        }

        public Email id(String id) {
            mail.id(id);
            return this;
        }

        public Email subject(String s) {
            mail.subject(s);
            return this;
        }

        public Email text(String t) {
            mail.text(t);
            return this;
        }

        public Email sent(String iso) {
            mail.at(iso);
            return this;
        }

        /** {@code List-Unsubscribe}: bulk mail. */
        public Email bulk() {
            mail.bulk();
            return this;
        }

        public Email attach(String name, String type, String content) {
            mail.attach(name, type, content);
            return this;
        }

        public Email header(String line) {
            mail.header(line);
            return this;
        }

        /** Through the linked Gmail, where a stranger is Other. */
        public Email viaGmail() {
            this.account = GMAIL;
            mail.to("me@gmail.example");
            return this;
        }

        /** Caught up after a wake, rather than live. */
        public Email caughtUp() {
            this.origin = Courier.Origin.CATCHUP;
            return this;
        }

        /** The transport's own DMARC result, for the From's own domain (a result counts only for that: Security CP-L2). */
        public Email dmarc(String result) {
            this.dmarcResult = result;
            return this;
        }

        private String dmarcResult;

        public byte[] bytes() {
            return mail.bytes();
        }

        /** Delivered: the stored message's id, or null for a refusal or a duplicate's own. */
        public String deliver() throws Exception {
            Courier.Accepted a = accept();
            return a.messageId();
        }

        public Courier.Accepted accept() throws Exception {
            byte[] raw = mail.bytes();
            Courier.Inbound in = Courier.Inbound.email(account, com.minimalistalliance.desk.deskd.courier.store.ExternalIds.email(
                    account, mail.messageId == null ? null : "<" + mail.messageId + ">", raw), raw, origin);
            if (dmarcResult != null) {
                String domain = com.minimalistalliance.desk.deskd.courier.store.Norm.domain(
                        com.minimalistalliance.desk.deskd.courier.store.Norm.email(mail.fromAddress()));
                in = in.withVerdicts(new Courier.Verdicts(false, false, null, null, dmarcResult, domain, null));
            } else if (verdicts != null) {
                in = in.withVerdicts(verdicts);
            }
            return rig.store.accept(in);
        }
    }
}
