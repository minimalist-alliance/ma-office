package com.minimalistalliance.desk.deskd.apps;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Apps on a guild desk (API.md section 19, "Members leaving"): the Founder adds a bundled app, each member uses it and
 * sees only their own, by the pseudonym deskd sends on every call and on each member's own SUB, and a member who leaves
 * loses their data in every app by {@code app.members.retain}, sent only on a roster the purges' guard trusts.
 */
class GuildAppsTest {

    private static final String ID = TestApps.BUNDLED_ID;
    private static final String FOUNDER = "gm-ffff0001";
    private static final String ONE = "gm-aaaa0001";
    private static final String TWO = "gm-bbbb0001";

    @TempDir
    Path dir;

    private AppsRig rig;

    @BeforeEach
    void setUp() throws Exception {
        new TestApps().bundleWithNotes(dir.resolve("bundled-apps"), "1.0.0");
        rig = new AppsRig(dir, true, false);
        rig.host.unavailable = "no_sandbox";
        rig.guild.set(true);
        rig.members.set(Set.of(FOUNDER, ONE, TWO));
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
    }

    /** A new deskd over the same volume, as after a restart, on the same guild desk. */
    private void restart() throws Exception {
        rig.close();
        rig = new AppsRig(dir, true, false);
        rig.host.unavailable = "no_sandbox";
        rig.guild.set(true);
        rig.members.set(Set.of(FOUNDER, ONE, TWO));
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> keyFile() throws Exception {
        return com.minimalistalliance.desk.deskd.protocol.Json.parseObject(
                Files.readAllBytes(rig.bundledData.resolve(ID).resolve(AppStore.MEMBER_KEY)));
    }

    private Map<String, Object> install(TestClient client) throws Exception {
        String sha = TestApps.sha(Files.readAllBytes(dir.resolve("bundled-apps").resolve(ID).resolve(BundledApps.MANIFEST)));
        return rig.call(client, "apps.install", "id", ID, "version", "1.0.0", "packageSha256", sha, "grants", List.of());
    }

    private FakeApp app() {
        return rig.fakeBundledHost().app(ID);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> callerOf(Map<String, Object> request) {
        return (Map<String, Object>) ((Map<String, Object>) request.get("from")).get("caller");
    }

    @SuppressWarnings("unchecked")
    private static List<String> retainedIn(Map<String, Object> retain) {
        return (List<String>) ((Map<String, Object>) retain.get("p")).get("members");
    }

    @Test
    @SuppressWarnings("unchecked")
    void theFounderAddsItAndEachMemberSeesOnlyTheirOwn() throws Exception {
        TestClient one = rig.member("m1", ONE, Caller.MEMBER);
        TestClient two = rig.member("m2", TWO, Caller.MEMBER);
        assertThat(install(one)).as("section 19's table").containsEntry("code", "forbidden")
                .containsEntry("details", Map.of("reason", "grant"));
        TestClient founder = rig.member("f1", FOUNDER, Caller.LEAD);
        Map<String, Object> catalog = (Map<String, Object>) rig.ok(founder, "apps.catalog.get").get("catalog");
        assertThat(catalog.toString()).contains("installable=true");
        assertThat(install(founder)).containsEntry("state", "running");

        rig.callWith(one, "apps.mutate", "n-1", AppsRig.params("id", ID, "m", "notes.put", "p", Map.of("text", "one's")));
        Map<String, Object> oneCall = app().lastRequest();
        rig.callWith(two, "apps.mutate", "n-2", AppsRig.params("id", ID, "m", "notes.put", "p", Map.of("text", "two's")));
        Map<String, Object> twoCall = app().lastRequest();
        assertThat(rig.ok(one, "apps.call", "id", ID, "m", "notes.list", "p", Map.of())).containsEntry("notes", List.of("one's"));
        assertThat(rig.ok(two, "apps.call", "id", ID, "m", "notes.list", "p", Map.of())).containsEntry("notes", List.of("two's"));

        // Every relayed REQ carries the caller as this app's pseudonym of the member: never the member's id.
        Map<String, Object> callerOne = callerOf(oneCall);
        Map<String, Object> callerTwo = callerOf(twoCall);
        assertThat(callerOne).containsEntry("kind", "guild_member").containsEntry("role", Caller.MEMBER);
        assertThat((String) callerOne.get("member")).startsWith("p-").isNotEqualTo(callerTwo.get("member"));
        assertThat(oneCall.toString()).doesNotContain(ONE).doesNotContain(TWO);
        TestClient oneAgain = rig.member("m1b", ONE, Caller.MEMBER);
        rig.ok(oneAgain, "apps.call", "id", ID, "m", "notes.list", "p", Map.of());
        assertThat(callerOf(app().lastRequest())).as("the same member, another session").containsEntry("member", callerOne.get("member"));

        // Each member's own SUB carries their pseudonym, and hears only their own.
        assertThat(rig.subscribe(one, "app:" + ID + ":notes")).containsEntry("_kind", "RES");
        assertThat(AppsRig.event(one)).containsEntry("type", "snapshot").containsEntry("data", Map.of("notes", List.of("one's")));
        assertThat(rig.subscribe(two, "app:" + ID + ":notes")).containsEntry("_kind", "RES");
        assertThat(AppsRig.event(two)).containsEntry("type", "snapshot").containsEntry("data", Map.of("notes", List.of("two's")));
        List<Object> subscribers = app().subscribes.stream().filter(b -> "notes".equals(b.get("topic")))
                .map(b -> (Object) FakeApp.who(b)).distinct().toList();
        assertThat(subscribers).containsExactlyInAnyOrder(callerOne.get("member"), callerTwo.get("member"));
        rig.callWith(two, "apps.mutate", "n-3", AppsRig.params("id", ID, "m", "notes.put", "p", Map.of("text", "two's again")));
        assertThat(AppsRig.event(two)).containsEntry("data", Map.of("notes", List.of("two's", "two's again")));
        assertThat(rig.ok(one, "apps.call", "id", ID, "m", "notes.list", "p", Map.of())).containsEntry("notes", List.of("one's"));
    }

    @Test
    void afterEachHelloTheAppIsToldWhoStaysAndALeaverLosesTheirData() throws Exception {
        TestClient founder = rig.member("f1", FOUNDER, Caller.LEAD);
        TestClient one = rig.member("m1", ONE, Caller.MEMBER);
        TestClient two = rig.member("m2", TWO, Caller.MEMBER);
        install(founder);
        await().until(() -> !app().retains.isEmpty());
        Map<String, Object> first = app().retains.get(0);
        assertThat(first).containsEntry("m", AppsModule.RETAIN).containsEntry("from", Map.of("kind", "desk"));
        assertThat((String) first.get("idem")).matches("[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}");
        assertThat(retainedIn(first)).hasSize(3).allMatch(p -> p.startsWith("p-")).doesNotContain(FOUNDER, ONE, TWO);

        rig.callWith(one, "apps.mutate", "n-1", AppsRig.params("id", ID, "m", "notes.put", "p", Map.of("text", "one's")));
        String onePseudonym = callerOf(app().lastRequest()).get("member").toString();
        rig.callWith(two, "apps.mutate", "n-2", AppsRig.params("id", ID, "m", "notes.put", "p", Map.of("text", "two's")));
        String twoPseudonym = callerOf(app().lastRequest()).get("member").toString();
        assertThat(retainedIn(first)).contains(onePseudonym, twoPseudonym);

        // Two leaves: a roster the guard trusts, then every running app hears it.
        rig.members.set(Set.of(FOUNDER, ONE));
        await().until(() -> app().retains.size() == 2);
        Map<String, Object> second = app().retains.get(1);
        assertThat(retainedIn(second)).hasSize(2).contains(onePseudonym).doesNotContain(twoPseudonym);
        assertThat(second.get("idem")).as("a fresh key each time, so a set seen before isn't answered from memory")
                .isNotEqualTo(first.get("idem"));
        await().until(() -> !app().notes.containsKey(twoPseudonym));
        assertThat(app().notes).containsKey(onePseudonym);
    }

    @Test
    void aRosterTheGuardDoesntTrustDeletesNothing() throws Exception {
        TestClient founder = rig.member("f1", FOUNDER, Caller.LEAD);
        install(founder);
        await().until(() -> app().retains.size() == 1);
        rig.members.set(null);
        rig.ok(founder, "apps.call", "id", ID, "m", "tally.get", "p", Map.of());
        await().during(Duration.ofMillis(500)).atMost(Duration.ofSeconds(2)).until(() -> app().retains.size() == 1);
        // An empty list is never sent: a guild always has its Founder.
        rig.members.set(Set.of());
        await().during(Duration.ofMillis(500)).atMost(Duration.ofSeconds(2)).until(() -> app().retains.size() == 1);
        // Off a guild desk nothing is sent at all, roster or not.
        rig.guild.set(false);
        rig.members.set(Set.of(FOUNDER));
        await().during(Duration.ofMillis(500)).atMost(Duration.ofSeconds(2)).until(() -> app().retains.size() == 1);
    }

    @Test
    void aStoppedAppIsntStartedToBeToldAndHearsAtItsNextStart() throws Exception {
        TestClient founder = rig.member("f1", FOUNDER, Caller.LEAD);
        install(founder);
        await().until(() -> app().retains.size() == 1);
        assertThat(rig.ok(founder, "apps.stop", "id", ID)).containsEntry("state", "stopped");
        int starts = (int) rig.fakeBundledHost().calls.stream().filter(c -> c.startsWith("start")).count();
        rig.members.set(Set.of(FOUNDER, ONE));
        await().during(Duration.ofMillis(500)).atMost(Duration.ofSeconds(2))
                .until(() -> rig.fakeBundledHost().calls.stream().filter(c -> c.startsWith("start")).count() == starts);
        rig.ok(founder, "apps.call", "id", ID, "m", "tally.get", "p", Map.of());
        await().until(() -> app() != null && app().retains.size() == 1);
        assertThat(retainedIn(app().retains.get(0))).hasSize(2);
    }

    @Test
    void anAppThatDoesntKnowTheCallIsLeftAsItIs() throws Exception {
        rig.fakeBundledHost().byVersion.put(FakeAppHost.BUNDLED, FakeApp.Hello.ANSWER);
        TestClient founder = rig.member("f1", FOUNDER, Caller.LEAD);
        install(founder);
        await().until(() -> app().retains.size() == 1);
        app().retainUnknown = true;
        rig.members.set(Set.of(FOUNDER));
        await().until(() -> app().retains.size() == 2);
        assertThat(rig.ok(founder, "apps.call", "id", ID, "m", "tally.get", "p", Map.of())).containsEntry("count", 0);
        assertThat(AppsRig.app(rig.ok(founder, "apps.list"), ID)).containsEntry("state", "running").containsEntry("problem", null);
    }

    @Test
    void aReAddOverMembersDataWithTheRegistryAndKeyLostDeletesNothing() throws Exception {
        // Data a move brought, or a lost registry left: members' notes under pseudonyms of a key deskd no longer has.
        rig.close();
        Path data = Files.createDirectories(dir.resolve("desk").resolve(AppsModule.BUNDLED_DATA).resolve(ID).resolve("data"));
        Files.writeString(data.resolve("state.jsonl"), "members' notes");
        restart();
        TestClient founder = rig.member("f1", FOUNDER, Caller.LEAD);
        assertThat(install(founder)).containsEntry("state", "running");
        assertThat(keyFile()).containsEntry("overData", true);
        rig.members.set(Set.of(FOUNDER, ONE));
        rig.ok(founder, "apps.call", "id", ID, "m", "tally.get", "p", Map.of());
        await().during(Duration.ofMillis(700)).atMost(Duration.ofSeconds(3)).until(() -> app().retains.isEmpty());
        assertThat(Files.readString(data.resolve("state.jsonl"))).isEqualTo("members' notes");
        // And it stays so across a restart: the flag is kept with the key.
        restart();
        TestClient again = rig.member("f2", FOUNDER, Caller.LEAD);
        rig.ok(again, "apps.call", "id", ID, "m", "tally.get", "p", Map.of());
        await().during(Duration.ofMillis(700)).atMost(Duration.ofSeconds(3)).until(() -> app().retains.isEmpty());
    }

    @Test
    void aLostRegistryChangesNoMembersPseudonym() throws Exception {
        TestClient founder = rig.member("f1", FOUNDER, Caller.LEAD);
        TestClient one = rig.member("m1", ONE, Caller.MEMBER);
        install(founder);
        rig.ok(one, "apps.call", "id", ID, "m", "notes.list", "p", Map.of());
        Object before = callerOf(app().lastRequest()).get("member");
        assertThat(keyFile()).containsEntry("overData", false);
        assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(rig.bundledData.resolve(ID).resolve(AppStore.MEMBER_KEY))))
                .isEqualTo("rw-------");

        rig.close();
        Files.delete(dir.resolve("desk").resolve(AppsModule.BUNDLED_DATA).resolve(AppStore.REGISTRY));
        restart();
        TestClient founderAgain = rig.member("f2", FOUNDER, Caller.LEAD);
        TestClient oneAgain = rig.member("m2", ONE, Caller.MEMBER);
        assertThat(install(founderAgain)).as("re-added").containsEntry("state", "running");
        rig.ok(oneAgain, "apps.call", "id", ID, "m", "notes.list", "p", Map.of());
        assertThat(callerOf(app().lastRequest())).as("the same pseudonym, from the key beside the data").containsEntry("member", before);
        await().until(() -> !app().retains.isEmpty());
        assertThat(retainedIn(app().retains.get(0))).contains((String) before);
    }

    @Test
    void anEntryWithNoKeyIsNeverToldAndNoKeyOfTheRunIsUsed() throws Exception {
        rig.close();
        Path home = dir.resolve("desk").resolve(AppsModule.BUNDLED_DATA);
        Files.createDirectories(home.resolve(ID).resolve("data"));
        Files.deleteIfExists(home.resolve(ID).resolve(AppStore.MEMBER_KEY));
        Map<String, Object> entry = new java.util.LinkedHashMap<>();
        entry.put("id", ID);
        entry.put("uid", AppStore.NO_UID);
        entry.put("version", "1.0.0");
        entry.put("tier", AppManifest.FIRST_PARTY);
        entry.put("grants", List.of());
        entry.put("state", "installed");
        entry.put("bundled", true);
        Files.write(home.resolve(AppStore.REGISTRY), com.minimalistalliance.desk.deskd.protocol.Json.bytes(
                Map.of("registry", 1, "catalogSeq", 0, "apps", List.of(entry))));
        restart();
        TestClient founder = rig.member("f1", FOUNDER, Caller.LEAD);
        assertThat(rig.ok(founder, "apps.call", "id", ID, "m", "tally.get", "p", Map.of())).containsEntry("count", 0);
        rig.members.set(Set.of(FOUNDER));
        await().during(Duration.ofMillis(700)).atMost(Duration.ofSeconds(3)).until(() -> app().retains.isEmpty());
    }

    @Test
    void aCatalogAppIsToldToo() throws Exception {
        rig.host.unavailable = null;
        Files.createDirectories(rig.root);
        TestApps.Built v1 = rig.apps.build("1.0.0");
        rig.publish(1, v1);
        TestClient founder = rig.member("f1", FOUNDER, Caller.LEAD);
        assertThat(rig.install(founder, v1)).containsEntry("state", "running");
        FakeApp catalogApp = rig.host.app(TestApps.ID);
        await().until(() -> catalogApp.retains.size() == 1);
        assertThat(retainedIn(catalogApp.retains.get(0))).hasSize(3);
    }
}
