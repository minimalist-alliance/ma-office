package com.minimalistalliance.desk.deskd.apps;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** deskd's end of an app's socket against the fake app: HELLO, calls, errors, subscriptions, the app's own requests, its end. */
class AppLinkTest {

    @TempDir
    Path dir;

    private FakeApp app;
    private final AtomicInteger downs = new AtomicInteger();
    private final AtomicReference<Boolean> plannedDown = new AtomicReference<>();
    private final List<String> asked = new CopyOnWriteArrayList<>();

    private final AppLink.Events events = new AppLink.Events() {
        @Override
        public Object request(String method, Map<String, Object> params) throws RpcException {
            asked.add(method);
            if (method.equals("desk.info.get")) {
                return Map.of("appApi", "1.0");
            }
            throw new RpcException(RpcException.NOT_FOUND, "No such method");
        }

        @Override
        public void down(AppLink link, boolean planned, int code) {
            plannedDown.set(planned);
            downs.incrementAndGet();
        }
    };

    private static final Map<String, Object> HELLO = Map.of("appApi", "1.0", "deskApi", "1.0", "app", Map.of("id", TestApps.ID, "version", "1.0.0"));

    @AfterEach
    void close() throws Exception {
        if (app != null) {
            app.close();
        }
    }

    private AppLink open(FakeApp.Hello hello) throws Exception {
        app = new FakeApp(dir.resolve("run/app.sock"), hello);
        return AppLink.open(app.socket, FakeAppHost.ownUid(), HELLO, Duration.ofSeconds(2), events);
    }

    @Test
    void helloCallsAndAnIdemThatGoesOnToTheApp() throws Exception {
        AppLink link = open(FakeApp.Hello.ANSWER);
        assertThat(app.hellos).singleElement().satisfies(h -> assertThat(h).containsEntry("appApi", "1.0"));
        assertThat(link.hello()).containsEntry("appApi", "1.0");

        Map<String, Object> add = link.call(Map.of("m", "tally.add", "p", Map.of("by", 2), "idem", "k-1", "from", Map.of("kind", "view")),
                Duration.ofSeconds(2), null);
        assertThat(add).containsEntry("count", 2);
        Map<String, Object> again = link.call(Map.of("m", "tally.add", "p", Map.of("by", 2), "idem", "k-1"), Duration.ofSeconds(2), null);
        assertThat(again).as("the app dedupes by idem").containsEntry("count", 2);
        assertThat(app.lastRequest()).containsEntry("idem", "k-1").containsKey("deadlineMs");
        assertThat(link.call(Map.of("m", "tally.get", "p", Map.of()), Duration.ofSeconds(2), null)).containsEntry("count", 2);
    }

    @Test
    void anAppsErrorComesBackWithItsCodeAndAnUnknownCodeAsInternal() throws Exception {
        AppLink link = open(FakeApp.Hello.ANSWER);
        assertThatThrownBy(() -> link.call(Map.of("m", "tally.add", "p", Map.of("by", 0), "idem", "k"), Duration.ofSeconds(2), null))
                .isInstanceOfSatisfying(RpcException.class, e -> {
                    assertThat(e.code()).isEqualTo("bad_request");
                    assertThat(e.details()).containsEntry("field", "by");
                });
        assertThatThrownBy(() -> link.call(Map.of("m", "weird.error", "p", Map.of()), Duration.ofSeconds(2), null))
                .isInstanceOfSatisfying(RpcException.class, e -> {
                    assertThat(e.code()).isEqualTo("internal");
                    assertThat(e.getMessage()).doesNotContain("secret");
                });
    }

    @Test
    void theGateRunsBeforeTheBytesGoAndCanStopThem() throws Exception {
        AppLink link = open(FakeApp.Hello.ANSWER);
        assertThatThrownBy(() -> link.call(Map.of("m", "tally.add", "p", Map.of("by", 1), "idem", "g"), Duration.ofSeconds(2),
                () -> {
                    throw new RpcException(RpcException.CANCELLED, "Cancelled");
                })).isInstanceOfSatisfying(RpcException.class, e -> assertThat(e.code()).isEqualTo("cancelled"));
        assertThat(app.count.get()).isZero();
    }

    @Test
    void aSubscriptionGetsItsSnapshotThenPatches() throws Exception {
        AppLink link = open(FakeApp.Hello.ANSWER);
        List<String> seen = new CopyOnWriteArrayList<>();
        long sub = link.subscribe("tally", Map.of("kind", "view"), (type, data) -> seen.add(type + " " + data), Duration.ofSeconds(2));
        await().until(() -> seen.size() == 1);
        assertThat(seen.get(0)).isEqualTo("snapshot {count=0}");
        link.call(Map.of("m", "tally.add", "p", Map.of("by", 3), "idem", "s"), Duration.ofSeconds(2), null);
        await().until(() -> seen.size() == 2);
        assertThat(seen.get(1)).isEqualTo("patch {count=3}");
        assertThat(app.subscribes).singleElement().satisfies(s -> assertThat(s).containsEntry("from", Map.of("kind", "view")));
        link.unsubscribe(sub);
        link.call(Map.of("m", "tally.add", "p", Map.of("by", 1), "idem", "t"), Duration.ofSeconds(2), null);
        Thread.sleep(100);
        assertThat(seen).hasSize(2);
    }

    @Test
    void theAppMayAskDeskdAndIsAnswered() throws Exception {
        AppLink link = open(FakeApp.Hello.ANSWER);
        link.call(Map.of("m", "ask.desk", "p", Map.of()), Duration.ofSeconds(2), null);
        await().until(() -> !app.fromDeskd.isEmpty());
        assertThat(asked).containsExactly("desk.info.get");
        assertThat(app.fromDeskd.get(0)).containsEntry("appApi", "1.0");
    }

    @Test
    void anAppThatNeverSaysHelloIsGivenUp() throws Exception {
        long start = System.nanoTime();
        assertThatThrownBy(() -> open(FakeApp.Hello.SILENT)).isInstanceOfSatisfying(AppLink.OpenException.class,
                e -> assertThat(e.reason()).isEqualTo("no_hello"));
        assertThat(Duration.ofNanos(System.nanoTime() - start)).isLessThan(Duration.ofSeconds(5));
    }

    @Test
    void anAppOfAnotherMajorNeedsAnUpdate() {
        assertThatThrownBy(() -> open(FakeApp.Hello.MISMATCH)).isInstanceOfSatisfying(AppLink.OpenException.class,
                e -> assertThat(e.reason()).isEqualTo("needs_update"));
    }

    @Test
    void aSocketThatIsntThereInTimeIsNoHello() {
        assertThatThrownBy(() -> AppLink.open(dir.resolve("none/app.sock"), FakeAppHost.ownUid(), HELLO, Duration.ofMillis(300), events))
                .isInstanceOfSatisfying(AppLink.OpenException.class, e -> assertThat(e.reason()).isEqualTo("no_hello"));
    }

    @Test
    void aPeerOfAnotherUidIsRefused() throws Exception {
        app = new FakeApp(dir.resolve("run/app.sock"), FakeApp.Hello.ANSWER);
        assertThatThrownBy(() -> AppLink.open(app.socket, FakeAppHost.ownUid() + 1, HELLO, Duration.ofSeconds(1), events))
                .isInstanceOf(AppLink.OpenException.class);
        assertThat(app.hellos).as("deskd says nothing to a stranger").isEmpty();
    }

    @Test
    void anOversizedFrameEndsTheLinkAndWaitersAreTold() throws Exception {
        AppLink link = open(FakeApp.Hello.ANSWER);
        byte[] header = AppLink.encode(FrameKind.EVT.code(), 1, 1, new byte[0]);
        java.nio.ByteBuffer.wrap(header).putInt(0, (64 << 10) + 13);
        app.raw(header);
        await().until(() -> !link.alive());
        assertThat(downs.get()).isEqualTo(1);
        assertThat(plannedDown.get()).isFalse();
        assertThatThrownBy(() -> link.call(Map.of("m", "tally.get", "p", Map.of()), Duration.ofSeconds(1), null))
                .isInstanceOfSatisfying(RpcException.class, e -> assertThat(e.code()).isEqualTo("unavailable"));
    }

    @Test
    void aCrashIsAnUnplannedDownAndACloseIsAPlannedOne() throws Exception {
        AppLink link = open(FakeApp.Hello.ANSWER);
        app.crash();
        await().until(() -> downs.get() == 1);
        assertThat(plannedDown.get()).isFalse();

        AppLink second = open(FakeApp.Hello.ANSWER);
        second.close();
        await().until(() -> downs.get() == 2);
        assertThat(plannedDown.get()).isTrue();
        assertThat(link.alive()).isFalse();
    }

    @Test
    void tooManyCallsAtOnceAreRefusedBeforeTheAppSeesThem() throws Exception {
        AppLink link = open(FakeApp.Hello.ANSWER);
        // Hold 32 calls open: each one's gate blocks until the test lets go, so none has been sent yet.
        java.util.concurrent.CountDownLatch hold = new java.util.concurrent.CountDownLatch(1);
        List<Thread> threads = new CopyOnWriteArrayList<>();
        AtomicInteger entered = new AtomicInteger();
        for (int i = 0; i < AppLink.MAX_CALLS; i++) {
            threads.add(Thread.ofVirtual().start(() -> {
                try {
                    link.call(Map.of("m", "tally.get", "p", Map.of()), Duration.ofSeconds(5), () -> {
                        entered.incrementAndGet();
                        try {
                            hold.await();
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                    });
                } catch (Exception e) {
                    // Not what's checked.
                }
            }));
        }
        await().until(() -> entered.get() == AppLink.MAX_CALLS);
        assertThatThrownBy(() -> link.call(Map.of("m", "tally.get", "p", Map.of()), Duration.ofSeconds(1), null))
                .isInstanceOfSatisfying(RpcException.class, e -> {
                    assertThat(e.code()).isEqualTo("rate_limited");
                    assertThat(e.details()).containsEntry("limit", "appCalls");
                });
        hold.countDown();
        for (Thread t : threads) {
            t.join();
        }
    }
}
