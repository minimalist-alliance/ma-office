package com.minimalistalliance.desk.deskd.courier.relay;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.courier.testkit.FakeRelay;
import com.minimalistalliance.desk.courier.testkit.PeerDesk;
import com.minimalistalliance.desk.courier.testkit.soak.Channels;
import com.minimalistalliance.desk.courier.testkit.soak.Faults;
import com.minimalistalliance.desk.courier.testkit.soak.Ledger;
import com.minimalistalliance.desk.courier.testkit.soak.Runner;
import com.minimalistalliance.desk.courier.testkit.soak.Soak;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The test kit's soak harness against deskd's relay transport (the plan §7: 0 lost, 0 doubled): the mail door's mail and
 * members' messages into a real desk's store through the fake relay, collected by the push and the poll, through the
 * relay down, lost acks, duplicated pages, the desk stopped and deskd killed. The 7-day, 100,000-message run on staging
 * desks is CR-4.1's; this is the same harness, shorter.
 */
class RelaySoakTest {

    @TempDir
    Path dir;

    @Test
    void doorAndMembersMessagesThroughEveryRelayFaultLoseNothingAndDoubleNothing() throws Exception {
        try (FakeRelay relay = FakeRelay.start()) {
            relay.caps().sendsPerHour = 1_000_000;
            relay.caps().sendsPerDay = 1_000_000;
            relay.caps().lookupsPerHour = 1_000_000;
            relay.caps().lookupsPerDay = 1_000_000;
            DeskRig desk = new DeskRig(relay, dir.resolve("desk"), "desk-soak", "soakdesk", Clock.systemUTC(),
                    new RelayTransport.Settings(Duration.ofSeconds(2), Duration.ofMillis(100), Duration.ofSeconds(2)));
            relay.onNotify((deskId, reason) -> {
                if ("desk-soak".equals(deskId)) {
                    desk.transport.notify(reason);
                }
            });
            PeerDesk dana = new PeerDesk(relay, "desk-dana", "dana");
            Soak.Plan plan = new Soak.Plan(20261115L, 2000, Duration.ofSeconds(30), List.of("door", "ma"), 0.2, List.of(
                    new Soak.Window("relay-down", Duration.ofSeconds(3), Duration.ofSeconds(3)),
                    new Soak.Window("relay-loses-acks", Duration.ofSeconds(8), Duration.ofSeconds(3)),
                    new Soak.Window("relay-duplicates", Duration.ofSeconds(13), Duration.ofSeconds(3)),
                    new Soak.Window("desk-stop", Duration.ofSeconds(18), Duration.ofSeconds(4)),
                    new Soak.Window("deskd-kill", Duration.ofSeconds(25), Duration.ofMillis(10))), Duration.ofSeconds(60));
            Map<String, Soak.Channel> channels = Map.of(
                    "door", Channels.door(relay, desk.address),
                    "ma", Channels.member(dana, desk.address));
            Map<String, Soak.Fault> faults = Map.of(
                    "relay-down", Faults.relayDown(relay),
                    "relay-loses-acks", Faults.relayLosesAcks(relay),
                    "relay-duplicates", Faults.relayDuplicates(relay),
                    "desk-stop", Faults.hook("desk-stop", () -> {
                        relay.setConnected("desk-soak", false);
                        desk.close();
                    }, () -> {
                        desk.restart();
                        relay.setConnected("desk-soak", true);
                    }),
                    "deskd-kill", Faults.hook("deskd-kill", desk::restart, () -> {}));
            Soak.Report report;
            try (Ledger ledger = new Ledger(dir.resolve("ledger.tsv"))) {
                report = new Runner(plan, channels, faults, desk::markers, ledger, Clock.systemUTC(), d -> Thread.sleep(d.toMillis()), null).run();
            }
            Files.writeString(dir.resolve("report.md"), report.toMarkdown());
            System.out.println("COURIER-RELAY-SOAK " + report.toJson());
            assertThat(report.lost()).isEmpty();
            assertThat(report.doubled()).isEmpty();
            assertThat(report.unexpected()).isEmpty();
            assertThat(report.notSent()).isEmpty();
            assertThat(report.passed()).isTrue();
            assertThat(relay.pending("desk-soak")).isZero();
            desk.close();
        }
    }
}
