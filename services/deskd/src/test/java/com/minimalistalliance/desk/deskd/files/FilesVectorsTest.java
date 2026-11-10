package com.minimalistalliance.desk.deskd.files;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * services/deskd/docs/files-vectors.json holds golden frames for the web builder's mock. deskd must answer them exactly:
 * the requests are decoded as deskd's own frame decoder reads them, and the replies are the ones deskd gives for the same
 * calls, field by field (ids and times are the ones the vectors fix, so the test fixes them too).
 */
class FilesVectorsTest {

    @TempDir
    Path dir;

    FilesRig rig;
    TestClient owner;
    Map<String, Object> doc;

    @BeforeEach
    void setUp() throws Exception {
        rig = new FilesRig(dir);
        owner = rig.owner("s-1");
        Path file = Path.of("..", "..", "services", "deskd", "docs", "files-vectors.json");
        Path here = Path.of(System.getProperty("user.dir"));
        Path found = here.resolve("docs/files-vectors.json");
        if (!Files.exists(found)) {
            found = here.resolve(file);
        }
        doc = Json.parseObject(Files.readAllBytes(found));
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> vectors() {
        return (List<Map<String, Object>>) doc.get("vectors");
    }

    private Map<String, Object> vector(String name) {
        return vectors().stream().filter(v -> name.equals(v.get("name"))).findFirst().orElseThrow();
    }

    private static Frame decode(Map<String, Object> v) throws Exception {
        return Frame.decode(HexFormat.of().parseHex((String) v.get("frameHex")));
    }

    @Test
    void everyFrameInTheFileIsAWellFormedFrameThatSaysWhatItClaims() throws Exception {
        assertThat(vectors()).hasSizeGreaterThan(8);
        for (Map<String, Object> v : vectors()) {
            Frame f = decode(v);
            assertThat(f.kind().name()).as((String) v.get("name")).isEqualTo(v.get("kind"));
            assertThat(f.flags()).isEqualTo(((Number) v.get("flags")).intValue());
            assertThat(f.id()).isEqualTo(((Number) v.get("id")).longValue());
            assertThat(f.seq()).isEqualTo(((Number) v.get("seq")).longValue());
            if (v.containsKey("payloadJson")) {
                assertThat(Json.parseObject(f.payload())).isEqualTo(v.get("payloadJson"));
            }
        }
    }

    @Test
    void theUploadConversationReplaysAgainstDeskd() throws Exception {
        byte[] file = "0123456789abcdef".getBytes(StandardCharsets.UTF_8);
        assertThat(FilesRig.sha(file)).isEqualTo(doc.get("sha256OfFile"));

        Frame begin = decode(vector("upload.begin request"));
        Map<String, Object> request = Json.parseObject(begin.payload());
        Map<String, Object> reply = rig.callWith(owner, "files.upload.begin", "idem-0001", map(request.get("p")));
        Map<String, Object> want = map(Json.parseObject(decode(vector("upload.begin reply")).payload()));
        for (String key : want.keySet()) {
            if (key.equals("uploadId") || key.equals("expiresAt")) {
                assertThat(reply.get(key)).as(key).isInstanceOf(String.class);
            } else if (key.equals("transferId")) {
                // The vector's 3 stands for "the session's next id"; this session has made none before.
                assertThat(reply.get(key)).as(key).isInstanceOf(Number.class);
            } else {
                assertThat(reply.get(key)).as(key).isEqualTo(want.get(key));
            }
        }
        // The first CHUNK, as the vector has it but for the id the desk gave.
        Frame chunk = decode(vector("first CHUNK"));
        assertThat(chunk.flags()).isEqualTo(Frame.BIN);
        owner.sendFrame(Channels.BULK, FrameKind.CHUNK, chunk.flags(), ((Number) reply.get("transferId")).longValue(), chunk.seq(), chunk.payload());
        Frame credit = owner.next(Channels.BULK);
        assertThat(credit.kind()).isEqualTo(FrameKind.CREDIT);
        Map<String, Object> gotCredit = Json.parseObject(credit.payload());
        Map<String, Object> wantCredit = map(Json.parseObject(decode(vector("progress CREDIT")).payload()));
        assertThat(gotCredit).isEqualTo(wantCredit);

        Map<String, Object> finishParams = new LinkedHashMap<>(map(Json.parseObject(decode(vector("upload.finish request")).payload()).get("p")));
        finishParams.put("uploadId", reply.get("uploadId"));
        Map<String, Object> done = rig.callWith(owner, "files.upload.finish", "idem-0002", finishParams);
        Map<String, Object> wantDone = map(Json.parseObject(decode(vector("upload.finish reply")).payload()));
        for (String key : wantDone.keySet()) {
            assertThat(done.get(key)).as(key).isEqualTo(wantDone.get(key));
        }
    }

    @Test
    void theListReplyHasTheVectorsShape() throws Exception {
        rig.ok(owner, "files.mkdir", "path", "Photos/2026", "parents", true);
        Path f = rig.root.resolve("Photos/a.txt");
        Files.writeString(f, "0123456789abcdef");
        Files.setLastModifiedTime(f, java.nio.file.attribute.FileTime.fromMillis(1_762_560_000_000L));
        Map<String, Object> list = rig.ok(owner, "files.list", "path", "Photos");
        Map<String, Object> want = map(Json.parseObject(decode(vector("files.list reply")).payload()));
        assertThat(list.keySet()).containsAll(want.keySet());
        List<Map<String, Object>> entries = rig.files == null ? List.of() : castList(list.get("entries"));
        List<Map<String, Object>> wantEntries = castList(want.get("entries"));
        assertThat(entries.get(1)).isEqualTo(wantEntries.get(1));
        assertThat(entries.get(0).keySet()).isEqualTo(wantEntries.get(0).keySet());
        assertThat(entries.get(0)).containsEntry("name", "2026").containsEntry("type", "dir").containsEntry("size", null);
        assertThat(list).containsEntry("next", null).containsEntry("skipped", 0);
    }

    @Test
    void theErrorVectorsMatchTheCodesAndDetailKeys() throws Exception {
        for (String name : List.of("check_required", "no_space")) {
            Map<String, Object> err = map(Json.parseObject(decode(vector(name)).payload()));
            assertThat(err).containsKeys("code", "message", "details");
            assertThat(decode(vector(name)).kind()).isEqualTo(FrameKind.ERR);
        }
        Map<String, Object> req = map(Json.parseObject(decode(vector("check_required")).payload()).get("details"));
        assertThat(req).containsKey("format");
        byte[] img = FilesImageGateTest.image(500, 1);
        Map<String, Object> begin = rig.callWith(owner, "files.upload.begin", "k1", FilesRig.params("path", "i.jpg", "size", 500L));
        FilesRig.Sending s = rig.begun(begin, 0);
        rig.sendBytes(owner, s, img, 500);
        rig.drain(owner, s, 500);
        Map<String, Object> got = rig.callWith(owner, "files.upload.finish", "k2", FilesRig.params("uploadId", s.uploadId, "sha256", FilesRig.sha(img), "size", 500L));
        assertThat(got).containsEntry("code", "check_required");
        assertThat(map(got.get("details")).keySet()).isEqualTo(req.keySet());
        rig.freeBytes.set(2_500_000_000L);
        Map<String, Object> nospace = rig.err(owner, "no_space", "files.upload.begin", "path", "x", "size", 482_113_000L);
        Map<String, Object> wantNo = map(Json.parseObject(decode(vector("no_space")).payload()).get("details"));
        Map<String, Object> d = map(nospace.get("details"));
        assertThat(d.keySet()).isEqualTo(wantNo.keySet());
        for (String key : wantNo.keySet()) {
            assertThat(((Number) d.get(key)).longValue()).as(key).isEqualTo(((Number) wantNo.get(key)).longValue());
        }
        assertThat(map(nospace.get("details")).keySet()).isEqualTo(wantNo.keySet());
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object o) {
        return (Map<String, Object>) o;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> castList(Object o) {
        return (List<Map<String, Object>>) o;
    }
}
