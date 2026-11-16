package com.minimalistalliance.desk.deskd.courier.relay;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.courier.envelope.Envelope;
import com.minimalistalliance.desk.courier.envelope.IdentityKeyPair;
import com.minimalistalliance.desk.courier.envelope.PublishedKeys;
import com.minimalistalliance.desk.courier.envelope.SafetyNumber;
import com.minimalistalliance.desk.courier.envelope.Signed;
import com.minimalistalliance.desk.deskd.aws.RoleCredentials;
import com.minimalistalliance.desk.deskd.courier.CourierModule;
import com.minimalistalliance.desk.deskd.courier.CourierSwitch;
import com.minimalistalliance.desk.deskd.courier.TestMime;
import com.minimalistalliance.desk.deskd.courier.keys.DeskKeys;
import com.minimalistalliance.desk.deskd.courier.keys.PlatformKeyPublisher;
import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import com.minimalistalliance.desk.deskd.courier.store.Invariants;
import com.minimalistalliance.desk.deskd.courier.store.RelayState;
import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.TopicRegistry;
import com.minimalistalliance.desk.deskd.imds.ImdsClient;
import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.platform.AgentClient;
import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The relay transports end to end against the REAL staging relay (contract 0.4.0, behind its kill switch, on in staging),
 * as two staging test desks: deskd's own code (module, keys, store, transport, signed client) on this machine, signing as
 * two self-hosted test desks paired for the run on two staging test accounts. Skipped unless
 * {@code COURIER_STAGING_SESSION} names the session file the proof's driver writes (its two desks' addresses and session
 * credentials, 0600, deleted after). Prints PASS and FAIL lines; never a key, a credential or ciphertext.
 */
@SuppressWarnings("unchecked")
class RelayStagingIT {

    @TempDir
    Path dir;

    private final List<String> lines = new ArrayList<>();
    private int failed;

    private void rec(String name, boolean pass, Object detail) {
        if (!pass) {
            failed++;
        }
        String line = (pass ? "PASS  " : "FAIL  ") + name + (detail == null ? "" : "  " + detail);
        lines.add(line);
        System.out.println("PROOF " + line);
    }

    /** One staging desk: deskd's Courier and relay transport, signing with the self-hosted desk's session. */
    private final class Desk implements AutoCloseable {
        final String name;
        final String address;
        final PlatformHttp http = new PlatformHttp();
        final StaticImds imds;
        final AgentClient client;
        final PlatformRelayApi api;
        final CourierModule module;
        final RelayTransport transport;

        Desk(String name, Map<String, Object> s, String apiBase, Path root) throws Exception {
            this.name = name;
            this.address = (String) s.get("address");
            Map<String, Object> creds = (Map<String, Object>) s.get("credentials");
            String expiration = creds.get("expiration") instanceof String e ? e : Instant.now().plus(Duration.ofMinutes(50)).toString();
            imds = new StaticImds((String) creds.get("accessKeyId"), (String) creds.get("secretAccessKey"), (String) creds.get("sessionToken"),
                    expiration);
            client = new AgentClient(http, new RoleCredentials(new ImdsClient(http, imds.url()), Clock.systemUTC()), () -> apiBase, Clock.systemUTC());
            api = new PlatformRelayApi(client, http);
            Files.createDirectories(root.resolve("desk"));
            Files.createDirectory(root.resolve("keys"), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
            CourierStore.Settings store = new CourierStore.Settings(Duration.ofDays(30), Duration.ofDays(90), Duration.ofMillis(200), Duration.ofDays(4), 2);
            CourierModule.Settings settings = new CourierModule.Settings(root.resolve("courier"), root.resolve("desk"), true, Duration.ofDays(3650), store);
            RpcDispatcher dispatcher = new RpcDispatcher();
            module = new CourierModule(dispatcher, new EventHub(new TopicRegistry()), settings, TestMime.PARSER,
                    new CourierSwitch(settings.switchDirectory()), () -> false, () -> AgeBand.Band.ADULT, Clock.systemUTC(),
                    DeskKeys.Settings.defaults(root.resolve("keys")), new PlatformKeyPublisher(client));
            module.keys().maintain();
            transport = new RelayTransport(module, api, CourierSend.NONE, Clock.systemUTC(),
                    new RelayTransport.Settings(Duration.ofMinutes(10), Duration.ofSeconds(2), Duration.ofSeconds(20))).start(dispatcher);
        }

        CourierStore store() {
            return module.store();
        }

        String send(String to, String text) throws Exception {
            Object[] draft = store().actions().saveDraft(null, null, "ma", RelayTransport.MA_ACCOUNT, List.of(to), null, text, null, null);
            Object[] sent = store().outbox().send((String) draft[0]);
            Thread.sleep(400);
            store().outbox().runDue();
            waitFor(() -> outbound((String) sent[1]).get("state") != null && !"sending".equals(outbound((String) sent[1]).get("state")));
            return (String) sent[1];
        }

        Map<String, Object> outbound(String id) {
            try {
                for (Map<String, Object> r : store().queries().outbound()) {
                    if (id.equals(r.get("outboundId"))) {
                        return r;
                    }
                }
            } catch (Exception e) {
                return Map.of();
            }
            return Map.of();
        }

        List<String> inbound() throws Exception {
            return Invariants.read(store(), c -> {
                List<String> out = new ArrayList<>();
                try (var ps = c.prepareStatement("SELECT body_text FROM messages WHERE direction = 'in' ORDER BY seq"); var r = ps.executeQuery()) {
                    while (r.next()) {
                        out.add(r.getString(1));
                    }
                }
                return out;
            });
        }

        @Override
        public void close() {
            module.close();
            imds.close();
            http.close();
        }
    }

    private static final SecureRandom RANDOM = new SecureRandom();

    /** A payload id: a ULID (the time, then randomness) in Crockford base32. */
    static String ulid() {
        String crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
        long ms = System.currentTimeMillis();
        StringBuilder s = new StringBuilder(26);
        for (int i = 9; i >= 0; i--) {
            s.append(crockford.charAt((int) ((ms >>> (5 * i)) & 31)));
        }
        for (int i = 0; i < 16; i++) {
            s.append(crockford.charAt(RANDOM.nextInt(32)));
        }
        return s.toString();
    }

    private static void waitFor(BooleanSupplier ok) throws InterruptedException {
        long until = System.nanoTime() + Duration.ofSeconds(30).toNanos();
        while (!ok.getAsBoolean() && System.nanoTime() < until) {
            Thread.sleep(200);
        }
    }

    /** Drains until the relay has nothing more for the desk (the push may land a moment after a send). */
    private static Map<String, Object> drainUntil(Desk d, int expectInbound) throws Exception {
        Map<String, Object> last = Map.of();
        long until = System.nanoTime() + Duration.ofSeconds(30).toNanos();
        do {
            last = d.transport.drainNow();
            if (d.inbound().size() >= expectInbound) {
                break;
            }
            Thread.sleep(1000);
        } while (System.nanoTime() < until);
        return last;
    }

    /**
     * The proof without JUnit, for a machine with a JRE and no build tools: {@code java -cp <test classpath>
     * ...RelayStagingIT} with {@code COURIER_STAGING_SESSION} set. Exits 1 on any FAIL.
     */
    public static void main(String[] args) throws Exception {
        RelayStagingIT it = new RelayStagingIT();
        it.dir = Files.createTempDirectory("courier-proof-desks-");
        try {
            it.theTransportsWorkEndToEndOnTheStagingRelay();
        } finally {
            try (var walk = Files.walk(it.dir)) {
                walk.sorted(java.util.Comparator.reverseOrder()).forEach(f -> f.toFile().delete());
            }
        }
        System.exit(it.failed == 0 ? 0 : 1);
    }

    @Test
    void theTransportsWorkEndToEndOnTheStagingRelay() throws Exception {
        String file = System.getenv("COURIER_STAGING_SESSION");
        Assumptions.assumeTrue(file != null && Files.isRegularFile(Path.of(file)), "no staging session: the proof's driver sets it");
        Map<String, Object> session = Json.parseObject(Files.readAllBytes(Path.of(file)));
        String apiBase = (String) session.get("api");
        try (Desk a = new Desk("A", (Map<String, Object>) session.get("a"), apiBase, dir.resolve("a"));
             Desk b = new Desk("B", (Map<String, Object>) session.get("b"), apiBase, dir.resolve("b"))) {
            // 1 keys and addresses
            Map<String, Object> ka = a.module.keys().status();
            Map<String, Object> kb = b.module.keys().status();
            rec("1.1 both desks published their keys to the staging key directory",
                    Boolean.TRUE.equals(((Map<String, Object>) ka.get("published")).get("current"))
                            && Boolean.TRUE.equals(((Map<String, Object>) kb.get("published")).get("current")),
                    Map.of("a", ((Map<String, Object>) ka.get("published")).get("problem") + "", "b", ((Map<String, Object>) kb.get("published")).get("problem") + ""));
            a.transport.drainNow();
            b.transport.drainNow();
            rec("1.2 each desk read its own address from the platform", a.address.equals(a.transport.address()) && b.address.equals(b.transport.address()),
                    null);
            Map<String, Object> lookedUp = a.api.lookup(b.address);
            rec("1.3 the directory's fingerprint for B is the one B computes", b.module.keys().publicKeys().fingerprint().equals(lookedUp.get("fingerprint")),
                    null);

            // 2 a member's message, A to B, and back
            String out1 = a.send(b.address, "hello B, from A's deskd");
            rec("2.1 A's queue sealed and sent it through the staging relay", "sent".equals(a.outbound(out1).get("state")), a.outbound(out1).get("error"));
            drainUntil(b, 1);
            rec("2.2 B collected it once, opened, verified and stored it", b.inbound().equals(List.of("hello B, from A's deskd")), b.inbound().size());
            RelayState.Pin bPinsA = b.store().relay().pin(a.address);
            rec("2.3 B pinned A's identity on first contact (unverified)", bPinsA != null && RelayState.UNVERIFIED.equals(bPinsA.state())
                    && bPinsA.identityKey().equals(a.module.keys().publicKeys().identityKey().text()), null);
            String lane = Invariants.text(b.store(), "SELECT lane FROM messages WHERE direction = 'in'");
            rec("2.4 a first message from someone new is a Request", "requests".equals(lane), lane);
            Map<String, Object> pending = b.api.pending();
            rec("2.5 nothing left waiting for B after the ack", Integer.valueOf(0).equals(pending.get("pending")), pending.get("pending"));
            String out2 = b.send(a.address, "and back to A");
            drainUntil(a, 1);
            rec("2.6 B's reply reached A", "sent".equals(b.outbound(out2).get("state")) && a.inbound().equals(List.of("and back to A")), null);
            String na = SafetyNumber.between(a.module.keys().publicKeys().identityKey(), b.module.keys().publicKeys().identityKey());
            String nb = SafetyNumber.between(b.module.keys().publicKeys().identityKey(), a.module.keys().publicKeys().identityKey());
            rec("2.7 both desks show the same safety number", na.equals(nb), null);

            // 3 an invite link verifies the pin
            String invite = Invite.link(a.address, a.module.keys().publicKeys().fingerprint());
            Invite parsed = Invite.parse(invite);
            PublishedKeys aKeys = PublishedKeys.fromJson(b.api.lookup(parsed.address()));
            rec("3.1 A's invite link matches the keys the staging directory gives for A", aKeys.matches(parsed.fingerprint()), null);

            // 4 a long message through the ciphertext drop
            String longText = "drop ".repeat(25_000);
            String out3 = a.send(b.address, longText);
            drainUntil(b, 2);
            rec("4.1 a 125 KB message went through a staging drop and arrived whole", "sent".equals(a.outbound(out3).get("state"))
                    && b.inbound().size() == 2 && longText.equals(b.inbound().get(1)), a.outbound(out3).get("error"));

            // 5 the same envelope twice, and again after the member deleted it
            IdentityKeyPair bId = b.module.keys().identity();
            PublishedKeys aPub = PublishedKeys.fromJson(b.api.lookup(a.address));
            Map<String, Object> p = new LinkedHashMap<>();
            p.put("v", 1);
            p.put("kind", "message");
            p.put("id", ulid());
            p.put("from", b.address);
            p.put("to", a.address);
            p.put("at", Payloads.at(System.currentTimeMillis()));
            p.put("text", "sent twice, stored once");
            Envelope.Sealed s = Signed.seal(bId, aPub, p);
            b.api.send(s.toJson(), "proof-replay-" + Long.toHexString(new SecureRandom().nextLong()) + "-1");
            b.api.send(s.toJson(), "proof-replay-" + Long.toHexString(new SecureRandom().nextLong()) + "-2");
            drainUntil(a, 2);
            Thread.sleep(2000);
            a.transport.drainNow();
            long copies = a.inbound().stream().filter("sent twice, stored once"::equals).count();
            rec("5.1 the same sealed message delivered twice by the relay is stored once", copies == 1, copies);
            String id = Invariants.text(a.store(), "SELECT id FROM messages WHERE body_text = 'sent twice, stored once'");
            a.store().actions().delete(List.of(id), false);
            a.store().actions().delete(List.of(id), true);
            b.api.send(s.toJson(), "proof-replay-" + Long.toHexString(new SecureRandom().nextLong()) + "-3");
            Thread.sleep(2000);
            a.transport.drainNow();
            copies = a.inbound().stream().filter("sent twice, stored once"::equals).count();
            rec("5.2 the relay handing it back after the member deleted it brings nothing back", copies == 0
                    && Integer.valueOf(0).equals(a.api.pending().get("pending")), copies);

            // 6 a forged sender
            IdentityKeyPair mallory = IdentityKeyPair.generate(new SecureRandom());
            Map<String, Object> f = new LinkedHashMap<>(p);
            f.put("id", ulid());
            f.put("text", "forged, claiming to be B");
            f.put("at", Payloads.at(System.currentTimeMillis()));
            b.api.send(Signed.seal(mallory, aPub, f).toJson(), "proof-forged-" + Long.toHexString(new SecureRandom().nextLong()));
            Thread.sleep(2000);
            a.transport.drainNow();
            Map<String, Object> refused = (Map<String, Object>) a.transport.counts().toMap().get("refused");
            rec("6.1 a message claiming B's address but signed by another key is refused and acked", a.inbound().stream().noneMatch(t -> t.startsWith("forged"))
                    && refused.containsKey("forged") && Integer.valueOf(0).equals(a.api.pending().get("pending")), refused);

            // 7 B's identity changes: A holds what B sends and won't send to B until the member checks the new number
            b.module.keys().resetIdentity();
            Map<String, Object> kb2 = b.module.keys().status();
            rec("7.1 B's new identity is published", Boolean.TRUE.equals(((Map<String, Object>) kb2.get("published")).get("current")),
                    ((Map<String, Object>) kb2.get("published")).get("problem"));
            int before = a.inbound().size();
            String out4 = b.send(a.address, "from my new key");
            Thread.sleep(2000);
            a.transport.drainNow();
            rec("7.2 A holds B's message under the new key, out of the store", a.inbound().size() == before
                    && a.store().relay().heldCount(b.address) == 1 && RelayState.CHANGED.equals(a.store().relay().pin(b.address).state()),
                    b.outbound(out4).get("state"));
            String out5 = a.send(b.address, "after I check your number");
            rec("7.3 A's message to B waits: key_changed", "retry".equals(a.outbound(out5).get("state")) && "key_changed".equals(a.outbound(out5).get("error")),
                    a.outbound(out5));
            String number = SafetyNumber.between(a.module.keys().publicKeys().identityKey(), b.module.keys().publicKeys().identityKey());
            java.lang.reflect.Method verify = RelayTransport.class.getDeclaredMethod("contactVerify",
                    com.minimalistalliance.desk.deskd.rpc.RpcContext.class, Map.class);
            verify.setAccessible(true);
            Map<String, Object> v = (Map<String, Object>) verify.invoke(a.transport, null, Map.of("address", b.address, "safetyNumber", number));
            rec("7.4 the member checked the new number: verified, the held message released", "verified".equals(v.get("state"))
                    && Integer.valueOf(1).equals(v.get("released")) && a.inbound().contains("from my new key"), v);
            // The retry waits its backoff; a try now, as the poke does.
            a.store().outbox().runDue();
            waitFor(() -> "sent".equals(a.outbound(out5).get("state")));
            int bBefore = b.inbound().size();
            drainUntil(b, bBefore + 1);
            rec("7.5 the waiting message went once the number was checked, and B opened it", b.inbound().contains("after I check your number"),
                    a.outbound(out5));
            Invariants.check(a.store());
            Invariants.check(b.store());
        }
        assertThat(failed).as(String.join("\n", lines)).isZero();
    }
}
