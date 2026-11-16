package com.minimalistalliance.desk.deskd.courier.relay;

import com.minimalistalliance.desk.courier.envelope.PublishedKeys;
import com.minimalistalliance.desk.courier.testkit.FakeRelay;
import com.minimalistalliance.desk.deskd.courier.CourierModule;
import com.minimalistalliance.desk.deskd.courier.CourierSwitch;
import com.minimalistalliance.desk.deskd.courier.TestMime;
import com.minimalistalliance.desk.deskd.courier.keys.DeskKeys;
import com.minimalistalliance.desk.deskd.courier.keys.KeyPublisher;
import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import com.minimalistalliance.desk.deskd.courier.store.Invariants;
import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.TopicRegistry;
import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * One desk under test on the test kit's {@link FakeRelay}: Courier's module with its store and keys in a directory, the
 * relay's transport over {@link KitApi}, an address, and its keys published. {@link #restart} is the desk stopping and
 * waking (or deskd killed): everything on disk stays, everything in memory goes.
 */
final class DeskRig implements AutoCloseable {

    final FakeRelay relay;
    final Path dir;
    final String deskId;
    final String address;
    final Clock clock;
    final KitApi api;
    RpcDispatcher dispatcher;
    volatile CourierModule module;
    volatile RelayTransport transport;
    private final RelayTransport.Settings settings;

    DeskRig(FakeRelay relay, Path dir, String deskId, String name, Clock clock) throws Exception {
        this(relay, dir, deskId, name, clock, new RelayTransport.Settings(Duration.ofHours(1), Duration.ofMillis(50), Duration.ofSeconds(1)));
    }

    DeskRig(FakeRelay relay, Path dir, String deskId, String name, Clock clock, RelayTransport.Settings settings) throws Exception {
        this.relay = relay;
        this.dir = dir;
        this.deskId = deskId;
        this.clock = clock;
        this.settings = settings;
        relay.addDesk(deskId, "AKIA" + deskId.toUpperCase().replaceAll("[^A-Z0-9]", "") + "000000");
        this.address = relay.assignAddress(deskId, name, false);
        Files.createDirectories(dir.resolve("desk"));
        Path keys = dir.resolve("keys");
        if (!Files.exists(keys)) {
            Files.createDirectory(keys, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        }
        this.api = new KitApi(relay.baseUrl(), deskId);
        open();
    }

    private void open() throws Exception {
        dispatcher = new RpcDispatcher();
        EventHub hub = new EventHub(new TopicRegistry());
        CourierModule.Settings s = new CourierModule.Settings(dir.resolve("courier"), dir.resolve("desk"), true, Duration.ofDays(3650),
                CourierStore.Settings.DEFAULT);
        KeyPublisher publisher = keys -> {
            try {
                Map<String, Object> a = api.putKeys(keys.toJson());
                return new KeyPublisher.Result(KeyPublisher.Outcome.PUBLISHED, ((Number) a.get("keysVersion")).longValue(),
                        (String) a.get("fingerprint"), null, null);
            } catch (IOException e) {
                return new KeyPublisher.Result(KeyPublisher.Outcome.LATER, -1, null, null, "unreachable");
            }
        };
        module = new CourierModule(dispatcher, hub, s, TestMime.PARSER, new CourierSwitch(s.switchDirectory()), () -> false,
                () -> AgeBand.Band.ADULT, clock, DeskKeys.Settings.defaults(dir.resolve("keys")), publisher);
        module.keys().maintain();
        transport = new RelayTransport(module, api, api, clock, settings);
        transport.start(dispatcher);
        // The drain at start reads the addresses first; then the queue's senders are there.
        org.awaitility.Awaitility.await().atMost(Duration.ofSeconds(10))
                .until(() -> module.store().outbox().canSend("ma", RelayTransport.MA_ACCOUNT));
    }

    /** The desk stops and wakes: the transport and module closed, then opened again on the same directory. */
    void restart() throws Exception {
        if (!closed) {
            module.close();
        }
        open();
        closed = false;
    }

    CourierStore store() {
        return module.store();
    }

    PublishedKeys keys() {
        return module.keys().publicKeys();
    }

    void switchTo(String words) throws Exception {
        Path f = dir.resolve("desk").resolve(CourierSwitch.FILE);
        if (words == null) {
            Files.deleteIfExists(f);
        } else {
            Files.writeString(f, words);
        }
        Thread.sleep(1_100);
    }

    /** Drains until the relay holds nothing more this desk can take, as the poll would. */
    Map<String, Object> drain() throws Exception {
        return transport.drainNow();
    }

    /** Every stored message's text, subject and medium, in order of arrival. */
    List<String[]> messages() throws Exception {
        return Invariants.read(store(), c -> {
            List<String[]> out = new ArrayList<>();
            try (var ps = c.prepareStatement(
                    "SELECT medium, direction, lane, coalesce(subject, ''), coalesce(body_text, ''), external_id, status FROM messages ORDER BY seq")) {
                try (var r = ps.executeQuery()) {
                    while (r.next()) {
                        out.add(new String[] {r.getString(1), r.getString(2), r.getString(3), r.getString(4), r.getString(5), r.getString(6),
                                r.getString(7)});
                    }
                }
            }
            return out;
        });
    }

    /** How many stored messages carry each soak marker (in their text or subject). */
    Map<String, Integer> markers() throws Exception {
        Map<String, Integer> out = new HashMap<>();
        java.util.regex.Pattern p = java.util.regex.Pattern.compile("soak[0-9a-f]+x[0-9]+");
        for (String[] m : messages()) {
            java.util.Set<String> found = new java.util.HashSet<>();
            for (String field : new String[] {m[3], m[4]}) {
                java.util.regex.Matcher x = p.matcher(field);
                while (x.find()) {
                    found.add(x.group());
                }
            }
            for (String f : found) {
                out.merge(f, 1, Integer::sum);
            }
        }
        return out;
    }

    private boolean closed;

    @Override
    public void close() {
        if (!closed) {
            closed = true;
            module.close();
        }
    }
}
