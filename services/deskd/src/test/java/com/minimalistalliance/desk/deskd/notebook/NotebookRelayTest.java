package com.minimalistalliance.desk.deskd.notebook;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.FakeNotebookSocket;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The relay of {@code notebook.*} and {@code collab} (API.md section 13), from a client's frames to a fake desk-notebook's
 * socket and back, on real Unix sockets, with everything working. {@code NotebookFailureTest} has the rest.
 */
class NotebookRelayTest {

    private static final int MIB_4 = 4 << 20;

    @TempDir
    Path dir;

    private FakeNotebookSocket service;
    private NotebookRig rig;

    @BeforeEach
    void setUp() throws Exception {
        service = new FakeNotebookSocket(dir.resolve("notebook.sock"));
        rig = new NotebookRig(dir, service.socket());
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
        service.close();
    }

    private static byte[] random(int size) {
        byte[] bytes = new byte[size];
        new Random(size).nextBytes(bytes);
        return bytes;
    }

    private static void quietFor(long millis) throws InterruptedException {
        Thread.sleep(millis);
    }

    // ---- methods

    @Test
    void everyMethodOfTheTableGoesAsItCameAndItsResultComesBack() throws Exception {
        List<String> all = new ArrayList<>(NotebookMethods.READS);
        all.addAll(NotebookMethods.MUTATIONS);
        for (String method : all) {
            service.handlers.put(method, p -> Map.of("method", method));
        }
        TestClient client = rig.connect("a");
        Map<String, Object> params = Map.of("id", "p1", "extra", List.of(1, 2));
        for (String method : all) {
            assertThat(rig.call(client, method, params)).as(method).containsEntry("_kind", "RES").containsEntry("method", method);
            Map<String, Object> req = service.last().next("req");
            assertThat(req).as(method).containsEntry("m", method).containsEntry("p", params).containsKey("id");
        }
        assertThat(all).hasSize(24).doesNotHaveDuplicates();
        assertThat(service.connections).hasSize(1);
    }

    @Test
    void aMutationNeedsIdemAndAReadDoesnt() throws Exception {
        service.handlers.put("notebook.tree", p -> Map.of());
        TestClient client = rig.connect("a");

        for (String mutation : NotebookMethods.MUTATIONS) {
            assertThat(rig.call(client, mutation, Map.of(), null)).as(mutation).containsEntry("code", "bad_request");
        }
        assertThat(service.connections).isEmpty();
        assertThat(rig.call(client, "notebook.tree", Map.of(), null)).containsEntry("_kind", "RES");
    }

    @Test
    void aRepeatWithTheSameKeyGetsTheStoredReplyAndIsntSentTwice() throws Exception {
        service.handlers.put("notebook.page.create", p -> Map.of("page", Map.of("id", "p1")));
        service.handlers.put("notebook.tree", p -> Map.of());
        TestClient client = rig.connect("a");
        String idem = UUID.randomUUID().toString();

        Map<String, Object> first = rig.call(client, "notebook.page.create", Map.of("tabId", "t1"), idem);
        Map<String, Object> again = rig.call(client, "notebook.page.create", Map.of("tabId", "t1"), idem);
        rig.call(client, "notebook.tree", Map.of());

        assertThat(first).containsEntry("_kind", "RES");
        assertThat(again.get("page")).isEqualTo(first.get("page"));
        List<Object> methods = new ArrayList<>();
        service.last().received.stream().filter(m -> "req".equals(m.get("t"))).forEach(m -> methods.add(m.get("m")));
        assertThat(methods).containsExactly("notebook.page.create", "notebook.tree");
    }

    @Test
    void aMethodNotInTheTableIsNotFoundLikeAnyOtherAndOpensNothing() throws Exception {
        TestClient client = rig.connect("a");
        for (String method : List.of("notebook.nope", "notebook.page.delete", "notebook", "notebook.")) {
            Map<String, Object> reply = rig.call(client, method, Map.of(), null);
            assertThat(reply).as(method).containsEntry("code", "not_found").containsEntry("message", "No such method");
        }
        assertThat(service.connections).isEmpty();
        assertThat(rig.module.linkCount()).isZero();
    }

    @Test
    void anErrorComesBackWithItsCodeAndDetails() throws Exception {
        TestClient client = rig.connect("a");
        rig.send(client, "notebook.settings.set", Map.of("timeZone", "Mars"), UUID.randomUUID().toString());
        FakeNotebookSocket.Request request = service.requests.take();
        request.connection().error(request.id(), "bad_request", Map.of("reason", "time_zone"));

        Map<String, Object> reply = client.nextReply();

        assertThat(reply).containsEntry("_kind", "ERR").containsEntry("code", "bad_request");
        assertThat(reply.get("details")).isEqualTo(Map.of("reason", "time_zone"));
    }

    @Test
    void aCodeDeskdDoesntHaveOrDetailsThatWouldntFitAnErrAreInternal() throws Exception {
        TestClient client = rig.connect("a");
        rig.send(client, "notebook.tree", Map.of(), null);
        FakeNotebookSocket.Request first = service.requests.take();
        first.connection().error(first.id(), "teapot", Map.of("reason", "x"));
        assertThat(client.nextReply()).containsEntry("code", "internal").containsEntry("message", "Internal error").containsEntry("details", Map.of());

        rig.send(client, "notebook.tree", Map.of(), null);
        FakeNotebookSocket.Request second = service.requests.take();
        second.connection().error(second.id(), "not_found", Map.of("reason", "x".repeat(40_000)));
        assertThat(client.nextReply()).containsEntry("code", "internal").containsEntry("details", Map.of());
    }

    @Test
    void aResultOverTheLimitOfARESIsTooLargeAndTheLinkStays() throws Exception {
        TestClient client = rig.connect("a");
        rig.send(client, "notebook.page.content", Map.of("pageId", "p1"), null);
        FakeNotebookSocket.Request request = service.requests.take();

        request.reply(Map.of("part", "x".repeat(1024 * 1024), "next", "c"));

        assertThat(client.nextReply()).containsEntry("code", "too_large");
        assertThat(service.connections).hasSize(1);
        assertThat(service.last().isOpen()).isTrue();
    }

    // ---- notebook.activity, a page at a time

    /** Rows shaped and sized as desk-notebook's: newest day first, then page id, highest first. */
    private static List<Map<String, Object>> activityRows(int count) {
        List<Map<String, Object>> rows = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            int page = count - 1 - i;
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("pageId", String.format("%08x-5eed-4000-8000-%012x", page % 3000, page % 3000));
            row.put("day", String.format("2025-%02d-%02d", 12 - (i / 3000) % 12, 28 - (i / 3000) / 12));
            row.put("created", false);
            row.put("firstAt", 1_761_998_400_000L + i);
            row.put("lastAt", 1_761_998_460_000L + i);
            row.put("edits", 1 + i % 9);
            row.put("added", i % 90);
            row.put("removed", i % 7);
            row.put("actors", List.of("user"));
            rows.add(row);
        }
        return rows;
    }

    /** desk-notebook's paging: as many rows as fit 1 MiB less 4 KiB, from just after the cursor, and the next cursor. */
    private static Map<String, Object> activityPage(List<Map<String, Object>> rows, Object cursor) {
        int from = 0;
        if (cursor != null) {
            from = Integer.parseInt(((String) cursor).substring(2)) + 1;
        }
        int budget = (1 << 20) - 4096;
        List<Map<String, Object>> page = new ArrayList<>();
        int i = from;
        for (; i < rows.size(); i++) {
            int size = Json.bytes(rows.get(i)).length + (page.isEmpty() ? 0 : 1);
            if (!page.isEmpty() && size > budget) {
                break;
            }
            budget -= size;
            page.add(rows.get(i));
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("rows", page);
        result.put("next", i < rows.size() ? "a:" + (i - 1) : null);
        return result;
    }

    @Test
    void activityComesAPageAtATimeWithTheCursorAndNextPassedOnAsTheyAre() throws Exception {
        List<Map<String, Object>> rows = activityRows(30_000);
        List<Map<String, Object>> asked = new CopyOnWriteArrayList<>();
        service.handlers.put("notebook.activity", p -> {
            asked.add(p);
            return activityPage(rows, p.get("cursor"));
        });
        TestClient owner = rig.connect("a");
        TestClient member = rig.connect("m", rig.member("gm-aaaa0001", "member", List.of(), false));

        for (TestClient client : List.of(owner, member)) {
            asked.clear();
            List<Object> got = new ArrayList<>();
            List<Object> nexts = new ArrayList<>();
            Object cursor = null;
            do {
                Map<String, Object> params = new LinkedHashMap<>();
                params.put("fromDay", "0000-01-01");
                params.put("toDay", "9999-12-31");
                if (cursor != null) {
                    params.put("cursor", cursor);
                }
                Map<String, Object> reply = rig.call(client, "notebook.activity", params);
                assertThat(reply).containsEntry("_kind", "RES").containsOnlyKeys("_kind", "_id", "rows", "next");
                Map<String, Object> result = new LinkedHashMap<>(reply);
                result.remove("_kind");
                result.remove("_id");
                assertThat(Json.bytes(result).length).isLessThanOrEqualTo(FrameKind.RES.maxMessageBytes());
                got.addAll((List<?>) reply.get("rows"));
                cursor = reply.get("next");
                nexts.add(cursor);
            } while (cursor != null);

            assertThat(got).isEqualTo(rows);
            assertThat(nexts.size()).isGreaterThan(4);
            // deskd adds nothing and drops nothing: the first ask has no cursor, and each later one the last reply's next.
            assertThat(asked).hasSize(nexts.size());
            assertThat(asked.get(0)).isEqualTo(Map.of("fromDay", "0000-01-01", "toDay", "9999-12-31"));
            for (int i = 1; i < asked.size(); i++) {
                assertThat(asked.get(i)).isEqualTo(Map.of("fromDay", "0000-01-01", "toDay", "9999-12-31", "cursor", nexts.get(i - 1)));
            }
        }
    }

    // ---- the connection

    @Test
    void theHelloIsTheFirstFrameAndNamesTheSession() throws Exception {
        service.handlers.put("notebook.tree", p -> Map.of());
        TestClient client = rig.connect("session-a");

        rig.call(client, "notebook.tree", Map.of());

        Map<String, Object> hello = service.last().received.take();
        assertThat(hello).containsOnlyKeys("t", "sessionId", "sub", "caller").containsEntry("t", "hello").containsEntry("sessionId", "session-a").containsEntry("sub", "user-1");
        // The verified caller (docs/sub-status/deskd-guild-sessions.md): the owner's, on an owner's desk.
        assertThat(hello).containsEntry("caller", com.minimalistalliance.desk.deskd.rpc.Caller.THE_OWNER.toJson());
        assertThat(service.last().received.take()).containsEntry("t", "req");
    }

    @Test
    void nothingConnectsUntilTheSessionUsesIt() throws Exception {
        rig.connect("a");
        quietFor(100);
        assertThat(service.connections).isEmpty();
        assertThat(rig.module.health()).containsEntry("notebook", "waiting");
    }

    @Test
    void aFirstSubOpensIt() throws Exception {
        TestClient client = rig.connect("a");

        client.subscribe("notebook.tree", null);

        await().until(() -> service.connections.size() == 1);
        assertThat(service.last().next("hello")).containsEntry("sessionId", "a");
        assertThat(service.last().next("sub")).containsEntry("topic", "notebook.tree");
    }

    @Test
    void aFirstCollabDataOpensIt() throws Exception {
        TestClient client = rig.connect("a");

        rig.sendCollab(client, new byte[] {1, 2, 3});

        assertThat(service.collabReceived.poll(5, TimeUnit.SECONDS)).containsExactly(1, 2, 3);
        assertThat(service.last().next("hello")).containsEntry("sessionId", "a");
        assertThat(rig.module.health()).containsEntry("notebook", "connected");
    }

    @Test
    void oneConnectionPerSessionHoweverMuchItDoes() throws Exception {
        service.handlers.put("notebook.tree", p -> Map.of());
        TestClient a = rig.connect("a");
        TestClient b = rig.connect("b");

        for (int i = 0; i < 5; i++) {
            rig.call(a, "notebook.tree", Map.of());
            rig.call(b, "notebook.tree", Map.of());
            rig.sendCollab(a, new byte[] {1});
            rig.sendCollab(b, new byte[] {2});
        }

        assertThat(service.connections).hasSize(2);
        List<Object> ids = new ArrayList<>();
        for (FakeNotebookSocket.Connection connection : service.connections) {
            ids.add(connection.next("hello").get("sessionId"));
        }
        assertThat(ids).containsExactlyInAnyOrder("a", "b");
    }

    @Test
    void aSessionsEndClosesItsConnectionHoweverItEnds() throws Exception {
        service.handlers.put("notebook.tree", p -> Map.of());

        TestClient closed = rig.connect("closed");
        rig.call(closed, "notebook.tree", Map.of());
        FakeNotebookSocket.Connection one = service.last();
        closed.sendJson(Channels.CTL, FrameKind.CLOSE, 0, Map.of("code", 1000));
        await().until(() -> !one.isOpen());

        TestClient gone = rig.connect("gone");
        rig.call(gone, "notebook.tree", Map.of());
        FakeNotebookSocket.Connection two = service.last();
        assertThat(two).isNotSameAs(one);
        rig.sessions.close("gone", 1000, "client_gone");
        await().until(() -> !two.isOpen());

        TestClient revoked = rig.connect("revoked");
        rig.call(revoked, "notebook.tree", Map.of());
        FakeNotebookSocket.Connection three = service.last();
        assertThat(three).isNotSameAs(two);
        rig.sessions.revoke(grant -> grant.sid().equals("sid-revoked"));
        await().until(() -> !three.isOpen());

        // And nothing tries again for them.
        quietFor(200);
        assertThat(service.connections).hasSize(3);
        assertThat(rig.module.linkCount()).isZero();
        assertThat(rig.module.health()).containsEntry("notebook", "waiting");
    }

    @Test
    void aSubscribedSessionsEndClosesItsConnectionAndNothingTriesAgain() throws Exception {
        TestClient client = rig.connect("a");
        client.subscribe("notebook.tree", null);
        await().until(() -> service.connections.size() == 1);
        rig.nextEvent(client);
        FakeNotebookSocket.Connection connection = service.last();

        client.sendJson(Channels.CTL, FrameKind.CLOSE, 0, Map.of("code", 1000));

        await().until(() -> !connection.isOpen());
        quietFor(200);
        assertThat(service.connections).hasSize(1);
    }

    // ---- the scope

    @Test
    void anExportSessionIsRefusedOnMethodsSubAndTheChannelAndOpensNothing() throws Exception {
        TestClient export = rig.connect("e", "export");
        List<String> methods = new ArrayList<>(NotebookMethods.READS);
        methods.addAll(NotebookMethods.MUTATIONS);
        for (String method : methods) {
            Map<String, Object> reply = rig.call(export, method, Map.of("pageId", "p1"));
            assertThat(reply).as(method).containsEntry("_kind", "ERR").containsEntry("code", "forbidden");
            assertThat(reply.get("details")).as(method).isEqualTo(Map.of("reason", "scope"));
        }
        Map<String, Object> sub = export.subscribe("notebook.tree", null);
        assertThat(sub).containsEntry("code", "forbidden");
        assertThat(sub.get("details")).isEqualTo(Map.of("reason", "scope"));

        // The session itself checks no scope on a module's channel: this is the handler's.
        rig.sendCollab(export, new byte[] {1, 2, 3});
        rig.sendCollab(export, random(100_000));

        quietFor(200);
        assertThat(service.connections).isEmpty();
        assertThat(rig.module.linkCount()).isZero();
        assertThat(rig.sessions.isLive("e")).isTrue();
    }

    // ---- the topic

    @Test
    void aSubGetsTheRevThenEachChange() throws Exception {
        service.tree = Map.of("rev", 41);
        TestClient client = rig.connect("a");

        assertThat(client.subscribe("notebook.tree", null)).containsEntry("_kind", "RES");

        assertThat(rig.nextEvent(client)).containsEntry("type", "snapshot").containsEntry("data", Map.of("rev", 41));
        service.publish(Map.of("rev", 42));
        rig.awaitRev(client, 42);
    }

    @Test
    void twoSessionsEachHearAChangeOnceThoughBothLinksDo() throws Exception {
        TestClient a = rig.connect("a");
        TestClient b = rig.connect("b");
        a.subscribe("notebook.tree", null);
        rig.nextEvent(a);
        b.subscribe("notebook.tree", null);
        assertThat(rig.nextEvent(b)).containsEntry("data", Map.of("rev", 1));
        await().until(() -> service.connections.size() == 2 && service.connections.get(1).subscriptions.size() == 1);

        service.publish(Map.of("rev", 2));

        rig.awaitRev(a, 2);
        rig.awaitRev(b, 2);
        assertThat(rig.rtcFake.pollFrame(a.handle(), Channels.EVENTS, 100)).isNull();
        assertThat(rig.rtcFake.pollFrame(b.handle(), Channels.EVENTS, 100)).isNull();
    }

    @Test
    void aSessionEndingLeavesTheOtherHearingAndALaterSubGetsTheRevAtOnce() throws Exception {
        TestClient a = rig.connect("a");
        TestClient b = rig.connect("b");
        a.subscribe("notebook.tree", null);
        rig.nextEvent(a);
        b.subscribe("notebook.tree", null);
        rig.nextEvent(b);
        await().until(() -> service.connections.size() == 2 && service.connections.get(1).subscriptions.size() == 1);

        a.sendJson(Channels.CTL, FrameKind.CLOSE, 0, Map.of("code", 1000));
        await().until(() -> service.openConnections() == 1);
        service.publish(Map.of("rev", 9));
        rig.awaitRev(b, 9);

        // The new session's first event doesn't wait for its own link, which won't hear anything of a stalled service.
        service.stallAll();
        TestClient c = rig.connect("c");
        c.subscribe("notebook.tree", null);
        assertThat(rig.nextEvent(c)).containsEntry("data", Map.of("rev", 9));
    }

    @Test
    void aRepeatSubGetsTheRevAgain() throws Exception {
        service.tree = Map.of("rev", 7);
        TestClient client = rig.connect("a");
        client.subscribe("notebook.tree", null);
        rig.nextEvent(client);

        client.subscribe("notebook.tree", null);

        assertThat(rig.nextEvent(client)).containsEntry("type", "snapshot").containsEntry("data", Map.of("rev", 7));
        assertThat(service.last().subscriptions).hasSize(1);
    }

    @Test
    void anUnsubLetsDeskNotebooksSubscriptionGoAndTheConnectionStays() throws Exception {
        TestClient client = rig.connect("a");
        Map<String, Object> sub = client.subscribe("notebook.tree", null);
        rig.nextEvent(client);
        FakeNotebookSocket.Connection connection = service.last();
        Object sid = connection.next("sub").get("sid");

        client.sendJson(Channels.RPC, FrameKind.UNSUB, 900, Map.of("subId", sub.get("subId")));
        assertThat(client.nextReply()).containsEntry("_kind", "RES");

        assertThat(connection.next("unsub")).containsEntry("sid", sid);
        assertThat(connection.isOpen()).isTrue();
    }

    @Test
    void nothingElseIsATopicHere() throws Exception {
        TestClient client = rig.connect("a");
        assertThat(client.subscribe("notebook.tree:x", null)).containsEntry("code", "not_found");
        assertThat(client.subscribe("notebook.other", null)).containsEntry("code", "not_found");
        assertThat(service.connections).isEmpty();
    }

    // ---- cancel

    @Test
    void aCancelReachesDeskNotebook() throws Exception {
        TestClient client = rig.connect("a");
        long id = rig.send(client, "notebook.search", Map.of("query", "x"), null);
        FakeNotebookSocket.Request request = service.requests.take();

        client.send(Channels.RPC, FrameKind.CANCEL, id, 0, new byte[0]);

        assertThat(client.nextReply()).containsEntry("code", "cancelled");
        assertThat(((Number) service.last().next("cancel").get("id")).longValue()).isEqualTo(request.id());
    }

    @Test
    void aDeadlineSendsCancelToo() throws Exception {
        TestClient client = rig.connect("a");
        rig.send(client, "notebook.search", Map.of("query", "x"), null, 50L);
        FakeNotebookSocket.Request request = service.requests.take();

        assertThat(client.nextReply()).containsEntry("code", "deadline_exceeded");
        assertThat(((Number) service.last().next("cancel").get("id")).longValue()).isEqualTo(request.id());
    }

    @Test
    void aMutationThatHasGoneRunsOnPastACancelAndARetryGetsItsResult() throws Exception {
        TestClient client = rig.connect("a");
        String idem = UUID.randomUUID().toString();
        long id = rig.send(client, "notebook.page.trash", Map.of("pageId", "p1"), idem);
        FakeNotebookSocket.Request request = service.requests.take();

        client.send(Channels.RPC, FrameKind.CANCEL, id, 0, new byte[0]);
        assertThat(client.nextReply()).containsEntry("code", "cancelled");

        // API.md section 4: once it has started nothing stops it, so desk-notebook isn't told to.
        request.reply(Map.of("done", true));
        Map<String, Object> retried = rig.call(client, "notebook.page.trash", Map.of("pageId", "p1"), idem);
        assertThat(retried).containsEntry("_kind", "RES").containsEntry("done", true);
        assertThat(service.last().received).noneMatch(m -> "cancel".equals(m.get("t")));
        assertThat(service.requests).isEmpty();
    }

    // ---- collab

    @Test
    void aCollabMessageGoesBothWaysAsBytes() throws Exception {
        TestClient client = rig.connect("a");
        byte[] up = {0, 1, 2, (byte) 0xff, 0};
        byte[] down = {9, 8, 7, 0, (byte) 0x80};

        rig.sendCollab(client, up);
        assertThat(service.collabReceived.poll(5, TimeUnit.SECONDS)).containsExactly(up);

        service.last().sendCollab(down);
        NotebookRig.Data data = rig.nextData(client);
        assertThat(data.binary()).isTrue();
        assertThat(data.bytes()).containsExactly(down);
    }

    @Test
    void messagesKeepTheirOrderEachWay() throws Exception {
        TestClient client = rig.connect("a");
        for (int i = 0; i < 200; i++) {
            rig.sendCollab(client, new byte[] {(byte) i});
        }
        for (int i = 0; i < 200; i++) {
            assertThat(service.collabReceived.poll(5, TimeUnit.SECONDS)).containsExactly((byte) i);
        }
        for (int i = 0; i < 200; i++) {
            service.last().sendCollab(new byte[] {(byte) i});
        }
        for (int i = 0; i < 200; i++) {
            assertThat(rig.nextData(client).bytes()).containsExactly((byte) i);
        }
    }

    @Test
    void dataFromAClientWithoutBinIsIgnoredAndOpensNothing() throws Exception {
        TestClient client = rig.connect("a");

        client.send(Channels.COLLAB, FrameKind.DATA, 7, 0, "{\"t\":\"reset\"}".getBytes(StandardCharsets.UTF_8));
        // Nor is any other kind anything on this channel.
        client.send(Channels.COLLAB, FrameKind.CREDIT, 7, 0, "{}".getBytes(StandardCharsets.UTF_8));

        quietFor(100);
        assertThat(service.connections).isEmpty();
        assertThat(rig.sessions.isLive("a")).isTrue();
    }

    @Test
    void nonBinDataAfterTheLinkIsUpGoesNowhereEither() throws Exception {
        TestClient client = rig.connect("a");
        rig.sendCollab(client, new byte[] {1});
        assertThat(service.collabReceived.poll(5, TimeUnit.SECONDS)).containsExactly(1);

        client.send(Channels.COLLAB, FrameKind.DATA, 7, 0, "{\"t\":\"x\"}".getBytes(StandardCharsets.UTF_8));
        rig.sendCollab(client, new byte[] {2});

        assertThat(service.collabReceived.poll(5, TimeUnit.SECONDS)).containsExactly(2);
    }

    @Test
    void aLargeMessageArrivesWholeEachWay() throws Exception {
        TestClient client = rig.connect("a");
        byte[] up = random(3 << 20);
        byte[] down = random((3 << 20) + 1);

        rig.sendCollab(client, up);
        assertThat(service.collabReceived.poll(20, TimeUnit.SECONDS)).isEqualTo(up);

        service.last().sendCollab(down);
        NotebookRig.Data data = rig.nextData(client);
        assertThat(data.binary()).isTrue();
        assertThat(data.bytes()).isEqualTo(down);
    }

    @Test
    void exactly4MiBGoesEachWayAndTheSessionGoesOn() throws Exception {
        service.handlers.put("notebook.tree", p -> Map.of());
        TestClient client = rig.connect("a");
        byte[] message = random(MIB_4);

        rig.sendCollab(client, message);
        assertThat(service.collabReceived.poll(20, TimeUnit.SECONDS)).isEqualTo(message);
        service.last().sendCollab(message);
        NotebookRig.Data data = rig.nextData(client);

        assertThat(data.binary()).isTrue();
        assertThat(data.bytes()).isEqualTo(message);
        assertThat(rig.call(client, "notebook.tree", Map.of())).containsEntry("_kind", "RES");
        assertThat(service.connections).hasSize(1);
    }

    /** The contract: going over DATA's limit closes the session from the client's side, which the adapter must never do. */
    @Test
    void oneByteOver4MiBFromAClientClosesItsSession() throws Exception {
        TestClient client = rig.connect("a");
        rig.sendCollab(client, new byte[] {1});
        assertThat(service.collabReceived.poll(5, TimeUnit.SECONDS)).isNotNull();
        FakeNotebookSocket.Connection connection = service.last();

        byte[] over = random(MIB_4 + 1);
        for (byte[] frame : Frame.fragment(FrameKind.DATA, Frame.BIN, 7, 0, over)) {
            rig.rtcFake.sendData(client.handle(), Channels.COLLAB, frame);
        }

        Map<String, Object> close = client.nextJson(Channels.CTL, FrameKind.CLOSE);
        assertThat(close).containsEntry("code", 4001);
        await().until(() -> !connection.isOpen());
        assertThat(service.collabReceived).isEmpty();
    }

    /** The other way it must never reach the client: the session stays, Browser and all. */
    @Test
    void oneByteOver4MiBFromDeskNotebookOnlyResetsTheLink() throws Exception {
        service.handlers.put("notebook.tree", p -> Map.of());
        TestClient client = rig.connect("a");
        rig.sendCollab(client, new byte[] {1});
        assertThat(service.collabReceived.poll(5, TimeUnit.SECONDS)).isNotNull();
        FakeNotebookSocket.Connection connection = service.last();

        connection.sendCollab(random(MIB_4 + 1));

        NotebookRig.Data data = rig.nextData(client);
        assertThat(data.isReset()).as("a reset").isTrue();
        await().until(() -> !connection.isOpen());
        assertThat(rig.sessions.isLive("a")).isTrue();
        assertThat(rig.call(client, "notebook.tree", Map.of())).containsEntry("_kind", "RES");
        assertThat(service.connections).hasSize(2);
        assertThat(rig.rtcFake.pollFrame(client.handle(), Channels.CTL, 100)).isNull();
    }

    @Test
    void aFrameOverTheContractsLimitDropsTheLinkWithoutReadingIt() throws Exception {
        service.handlers.put("notebook.tree", p -> Map.of());
        TestClient client = rig.connect("a");
        rig.sendCollab(client, new byte[] {1});
        assertThat(service.collabReceived.poll(5, TimeUnit.SECONDS)).isNotNull();
        FakeNotebookSocket.Connection connection = service.last();

        // Claims nearly 2 GiB. There's no body, and nothing is allocated for one.
        connection.sendRaw(Integer.MAX_VALUE, (byte) 0x02, new byte[0]);

        assertThat(rig.nextData(client).isReset()).isTrue();
        await().until(() -> !connection.isOpen());
        assertThat(rig.call(client, "notebook.tree", Map.of())).containsEntry("_kind", "RES");
    }

    @Test
    void anUnknownTypeOrAMessageWithNoTDropsTheLinkAndUnknownKindsArentMinded() throws Exception {
        service.handlers.put("notebook.tree", p -> Map.of());
        TestClient client = rig.connect("a");
        rig.call(client, "notebook.tree", Map.of());
        FakeNotebookSocket.Connection first = service.last();

        // A kind of message a newer desk-notebook might send.
        first.sendJson(Map.of("t", "something-new"));
        assertThat(rig.call(client, "notebook.tree", Map.of())).containsEntry("_kind", "RES");
        assertThat(service.connections).hasSize(1);

        first.sendRaw(3, (byte) 0x07, new byte[] {1, 2});
        await().until(() -> !first.isOpen());
        assertThat(rig.call(client, "notebook.tree", Map.of())).containsEntry("_kind", "RES");
        FakeNotebookSocket.Connection second = service.last();
        assertThat(second).isNotSameAs(first);

        second.sendJson(Map.of("r", 1));
        await().until(() -> !second.isOpen());
    }

    @Test
    void aReplyToNothingIsIgnored() throws Exception {
        service.handlers.put("notebook.tree", p -> Map.of());
        TestClient client = rig.connect("a");
        rig.call(client, "notebook.tree", Map.of());

        service.last().reply(999_999, Map.of("x", 1));
        service.last().event(999_999, Map.of("rev", 5));

        assertThat(rig.call(client, "notebook.tree", Map.of())).containsEntry("_kind", "RES");
        assertThat(service.connections).hasSize(1);
        assertThat(rig.rtcFake.pollFrame(client.handle(), Channels.EVENTS, 100)).isNull();
    }
}
