package com.minimalistalliance.desk.agent.socket;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.agent.DeskAgentApplication;
import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.service.AgentService;
import com.minimalistalliance.desk.agent.service.TopicHub;
import com.minimalistalliance.desk.agent.store.AgentStore;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SocketChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * A deskd that stops reading, as the agent socket drops it: the real application, and a peer that subscribes and never
 * reads. The drop must not take another topic's lock on the thread that published, which holds its own topic's.
 */
class AgentSocketOverflowTest {

    private static final String CONVERSATION = AgentService.CONVERSATION_PREFIX + AgentStore.MANAGER;

    @TempDir
    Path dir;

    private ConfigurableApplicationContext context;
    private SocketChannel peer;

    @BeforeEach
    void boot() throws Exception {
        Files.createDirectories(dir.resolve("data"));
        context = DeskAgentApplication.application().run(
                "--desk.agent.data.dir=" + dir.resolve("data"),
                "--desk.agent.admin.socket=" + dir.resolve("admin.sock"),
                "--desk.agent.socket=" + dir.resolve("agent.sock"),
                "--desk.agent.peer.uid=" + PeerCheck.ownUid(),
                "--desk.agent.anthropic.url=http://127.0.0.1:9",
                "--desk.agent.openai.url=http://127.0.0.1:9",
                "--desk.agent.xai.url=http://127.0.0.1:9");
        peer = SocketChannel.open(StandardProtocolFamily.UNIX);
        peer.connect(UnixDomainSocketAddress.of(dir.resolve("agent.sock")));
    }

    @AfterEach
    void stop() throws Exception {
        peer.close();
        context.close();
    }

    @Test
    void aPeerThatStopsReadingIsDroppedWithoutWaitingOnAnotherTopic() throws Exception {
        AgentSocketServer server = context.getBean(AgentSocketServer.class);
        TopicHub topics = context.getBean(TopicHub.class);
        // The reader takes them in order, so once the second is listed, the first is subscribed.
        subscribe(1, CONVERSATION);
        subscribe(2, AgentService.STATE_TOPIC);
        await().atMost(Duration.ofSeconds(10)).until(() -> server.subscriptionsForTest().size() == 2);

        // Someone has the conversation's lock for now, as agent.thread.get would.
        CountDownLatch holding = new CountDownLatch(1);
        CountDownLatch letGo = new CountDownLatch(1);
        FutureTask<Void> holder = startVirtual(() -> topics.underLock(CONVERSATION, () -> {
            holding.countDown();
            waitFor(letGo);
            return null;
        }));
        assertThat(holding.await(5, TimeUnit.SECONDS)).isTrue();

        // Events on agent.state, about 1 MiB each, until the queue passes 16 MiB and the connection is dropped.
        Map<String, Object> big = Map.of("pad", "x".repeat(1 << 20));
        FutureTask<Void> publisher = startVirtual(() -> {
            for (int i = 0; i < 24; i++) {
                topics.publish(AgentService.STATE_TOPIC, "snapshot", big);
            }
            return null;
        });
        try {
            publisher.get(10, TimeUnit.SECONDS);
            assertThat(server.connected()).isFalse();
        } finally {
            letGo.countDown();
        }
        holder.get(5, TimeUnit.SECONDS);
        await().atMost(Duration.ofSeconds(10)).until(() -> server.subscriptionsForTest().isEmpty());
    }

    private void subscribe(long sid, String topic) throws Exception {
        byte[] json = Json.bytes(Map.of("t", "sub", "sid", sid, "topic", topic));
        ByteBuffer frame = ByteBuffer.allocate(5 + json.length).putInt(json.length + 1).put((byte) 1).put(json).flip();
        while (frame.hasRemaining()) {
            peer.write(frame);
        }
    }

    private static void waitFor(CountDownLatch latch) {
        try {
            latch.await(30, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static <T> FutureTask<T> startVirtual(java.util.concurrent.Callable<T> work) {
        FutureTask<T> task = new FutureTask<>(work);
        Thread.ofVirtual().start(task);
        return task;
    }
}
