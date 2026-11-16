package com.minimalistalliance.desk.deskd.docs;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.TopicRegistry;
import com.minimalistalliance.desk.deskd.files.AgentFilesRig;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcTestCalls;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/** Documents on a real Files tree in a temp directory, with the fake sandbox, its own dispatcher and a clock to move. */
final class DocsRig implements AutoCloseable {

    final AgentFilesRig files;
    final Path desk;
    final RpcDispatcher dispatcher = new RpcDispatcher();
    final EventHub hub = new EventHub(new TopicRegistry());
    final FakeDocsSandbox sandbox = new FakeDocsSandbox();
    final MutableClock clock = new MutableClock(Instant.parse("2026-11-12T17:00:00Z"));
    final AtomicBoolean guild = new AtomicBoolean();
    final DocsModule module;

    DocsRig(Path dir) throws Exception {
        this.files = new AgentFilesRig(dir.resolve("f"));
        this.desk = Files.createDirectories(dir.resolve("desk"));
        this.module = new DocsModule(dispatcher, hub, desk, files.files().docsAccess(), sandbox, guild::get, () -> false,
                () -> ZoneId.of("America/Denver"), clock);
    }

    /** A file in the member's Files, with its modified time now. */
    Path put(String path, byte[] bytes) throws Exception {
        Path p = files.root().resolve(path);
        Files.createDirectories(p.getParent());
        Files.write(p, bytes);
        Files.setLastModifiedTime(p, FileTime.from(clock.instant()));
        return p;
    }

    /** Indexes a folder as a change to it would. */
    void scan(String folder) throws Exception {
        module.intake().scanFolder(folder, false);
    }

    void advance(Duration d) {
        clock.advance(d);
    }

    @SuppressWarnings("unchecked")
    Map<String, Object> call(String method, Map<String, Object> params) throws Exception {
        return (Map<String, Object>) RpcTestCalls.call(dispatcher, method, params);
    }

    @SuppressWarnings("unchecked")
    List<Map<String, Object>> items(Map<String, Object> listed) {
        return (List<Map<String, Object>>) listed.get("items");
    }

    @SuppressWarnings("unchecked")
    Map<String, Object> doc(String id) throws Exception {
        return (Map<String, Object>) call("docs.get", Map.of("id", id)).get("doc");
    }

    String idOf(String path) throws Exception {
        return (String) call("docs.byPath", Map.of("path", path)).get("id");
    }

    @Override
    public void close() throws Exception {
        module.close();
        files.close();
    }
}
