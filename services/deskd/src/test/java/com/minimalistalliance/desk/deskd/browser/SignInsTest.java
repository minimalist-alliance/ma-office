package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.files.ImportFiles;
import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.Message;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.session.Session;
import com.minimalistalliance.desk.deskd.testing.FakeCdp;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

/**
 * browser.import (bookmarks from Files), browser.import.begin, finish and abort (a passwords file over the session, in
 * memory only), browser.bookmarks.list and the key button's methods, through a client's frames, against a fake debugging
 * port that plays Chromium's own pages: its Password Manager, its bookmarks and its extensions page. Every password here
 * is an obviously fake one.
 */
@ExtendWith(OutputCaptureExtension.class)
class SignInsTest {

    private static final String VAULT = "aaaabbbbccccddddeeeeffffgggghhhh";
    private static final String OTHER_VAULT = "ppppoooonnnnmmmmllllkkkkjjjjiiii";
    private static final String NOT_ALLOWED = "abcdefghijklmnopabcdefghijklmnop";
    private static final SignIns.Timing TIMING = new SignIns.Timing(Duration.ofSeconds(2), Duration.ofSeconds(3), 2, 3);

    private static final String CSV = """
            name,url,username,password,note
            One,https://one.example/login,fake-user-1,fake-password-1,
            Two,https://two.example/,fake-user-2,"fake,password-2","a note
            on two lines"
            Bad,javascript:alert(1),fake-user-3,fake-password-3,
            Empty,https://three.example/,fake-user-4,,
            Refused,https://refuse-me.example/,fake-user-5,fake-password-5,
            """;

    @TempDir
    Path dir;

    private FakeCdp cdp;
    private BrowserRig rig;
    private PasswordUploads uploads;
    private PasswordUploads.Timing uploadTiming = new PasswordUploads.Timing(Duration.ofSeconds(30), Duration.ofSeconds(1));
    private final MemoryFiles files = new MemoryFiles();
    private final AtomicReference<AgeBand.Band> band = new AtomicReference<>(AgeBand.Band.ADULT);
    /** Chromium's saved passwords, as {@code url|username}. */
    private final Set<String> saved = ConcurrentHashMap.newKeySet();
    private final FakeBookmarks bookmarks = new FakeBookmarks();
    private final Map<String, String> extensionStates = new ConcurrentHashMap<>();
    /** The rows Chromium got, by password, so a test can see what went. */
    private final List<String> passwordsSeen = new java.util.concurrent.CopyOnWriteArrayList<>();
    private volatile boolean pageLoads = true;

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            rig.close();
        }
        if (cdp != null) {
            cdp.close();
        }
    }

    private TestClient start() throws Exception {
        return start(true, true);
    }

    private TestClient start(boolean video, boolean input) throws Exception {
        return start(video, input, files);
    }

    private TestClient start(boolean video, boolean input, ImportFiles from) throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("a", "https://example.com/a", "Title a");
        playChromiumsPages();
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        uploads = rig.module.enableSignIns(from, rig.transfers, band::get, new PasswordManagers(List.of(
                new PasswordManagers.Manager(VAULT, "Fixture Vault", "popup/index.html"),
                new PasswordManagers.Manager(OTHER_VAULT, "Other Vault", "popup.html"))), TIMING, uploadTiming);
        return rig.connect("cs-a", video, input);
    }

    /** What Chromium's own pages answer: their API once loaded, and the sign-ins' constant functions. */
    private void playChromiumsPages() {
        for (String api : List.of("chrome.passwordsPrivate", "chrome.bookmarks", "chrome.developerPrivate")) {
            cdp.answerExpression(api, command -> Map.of("result", pageLoads
                    ? Map.of("type", "object", "objectId", "global-of-" + command.sessionId())
                    : Map.of("type", "undefined")));
        }
        cdp.answer("Runtime.callFunctionOn", command -> {
            String function = Json.string(command.params(), "functionDeclaration");
            List<Object> args = new ArrayList<>();
            for (Object arg : (List<?>) command.params().get("arguments")) {
                args.add(((Map<?, ?>) arg).get("value"));
            }
            Object value;
            if (SignIns.ADD_PASSWORDS.equals(function)) {
                List<Object> codes = new ArrayList<>();
                for (Object raw : (List<?>) args.get(0)) {
                    Map<?, ?> row = (Map<?, ?>) raw;
                    passwordsSeen.add((String) row.get("password"));
                    String url = (String) row.get("url");
                    if (url.contains("refuse-me")) {
                        codes.add(2);
                    } else {
                        codes.add(saved.add(url + "|" + row.get("username")) ? 0 : 1);
                    }
                }
                value = codes;
            } else if (SignIns.HAS_URLS.equals(function)) {
                List<Object> found = new ArrayList<>();
                for (Object url : (List<?>) args.get(0)) {
                    found.add(bookmarks.hasUrl((String) url));
                }
                value = found;
            } else if (SignIns.IMPORTED_FOLDER.equals(function)) {
                value = bookmarks.importedFolder((String) args.get(0));
            } else if (SignIns.CREATE_BOOKMARKS.equals(function)) {
                value = bookmarks.create((List<?>) args.get(0));
            } else if (SignIns.LIST_BOOKMARKS.equals(function)) {
                value = bookmarks.list((String) args.get(0), ((Number) args.get(1)).intValue(), ((Number) args.get(2)).intValue());
            } else if (SignIns.EXTENSION_STATES.equals(function)) {
                List<Object> rows = new ArrayList<>();
                for (Object id : (List<?>) args.get(0)) {
                    String state = extensionStates.get(id);
                    if (state != null) {
                        rows.add(List.of(id, state));
                    }
                }
                value = rows;
            } else {
                return Map.of("_error", -32000);
            }
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("type", "object");
            result.put("value", value);
            return Map.of("result", result);
        });
    }

    private static Map<String, Object> row(String site, String username, String reason) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("site", site);
        row.put("username", username);
        row.put("reason", reason);
        return row;
    }

    private static void assertErr(Map<String, Object> reply, String code, Map<String, Object> details) {
        assertThat(reply).containsEntry("_kind", "ERR").containsEntry("code", code).containsEntry("details", details);
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> listOf(Map<String, Object> reply, String key) {
        return (List<Map<String, Object>>) reply.get(key);
    }

    private List<String> hiddenPagesOpened() {
        List<String> urls = new ArrayList<>();
        for (FakeCdp.Command command : cdp.commands("Target.createTarget")) {
            if (Boolean.TRUE.equals(command.params().get("hidden"))) {
                urls.add(Json.string(command.params(), "url"));
            }
        }
        return urls;
    }

    // ---- passwords: over the session, into memory only

    private static byte[] utf8(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    private static long number(Map<String, Object> map, String key) {
        return ((Number) map.get(key)).longValue();
    }

    /** The next CREDIT on bulk, for this transfer. */
    private static Map<String, Object> credit(TestClient client, long transferId) throws Exception {
        Frame frame = client.next(Channels.BULK);
        assertThat(frame.kind()).isEqualTo(FrameKind.CREDIT);
        assertThat(frame.id()).isEqualTo(transferId);
        return Json.parseObject(frame.payload());
    }

    private static void chunk(TestClient client, long transferId, long seq, byte[] bytes) {
        client.sendFrame(Channels.BULK, FrameKind.CHUNK, Frame.BIN, transferId, seq, bytes);
    }

    @Test
    void passwordsComeOverTheSessionIntoChromiumsOwnPasswordManagerAndTheBufferIsZeroed(CapturedOutput output) throws Exception {
        TestClient client = start();
        List<byte[]> taken = new java.util.concurrent.CopyOnWriteArrayList<>();
        uploads.onTake = taken::add;
        byte[] csv = utf8(CSV);

        Map<String, Object> begun = rig.sendPasswords(client, csv);
        assertThat(begun).containsEntry("_kind", "RES").containsEntry("size", csv.length).containsEntry("window", csv.length);
        assertThat((String) begun.get("uploadId")).matches("[A-Za-z0-9_-]{22}");
        // Every byte is in: no more credit, as a Files upload's last acknowledgement says.
        assertThat(credit(client, number(begun, "transferId"))).isEqualTo(Map.of("bytes", 0, "committed", csv.length));
        assertThat(uploads.heldBytes()).isEqualTo(csv.length);
        Map<String, Object> reply = rig.call(client, "browser.import.finish", Map.of("uploadId", begun.get("uploadId")));

        assertThat(reply)
                .containsEntry("_kind", "RES")
                .containsEntry("kind", "passwords")
                .containsEntry("found", 5)
                .containsEntry("added", 2)
                .containsEntry("alreadySaved", 0)
                .containsEntry("refused", 3)
                .doesNotContainKey("deleted");
        assertThat(listOf(reply, "notAdded")).containsExactlyInAnyOrder(
                row(null, "fake-user-3", "url"),
                row("three.example", "fake-user-4", "password"),
                row("refuse-me.example", "fake-user-5", "url"));
        assertThat(saved).containsExactlyInAnyOrder("https://one.example/login|fake-user-1", "https://two.example/|fake-user-2");
        assertThat(passwordsSeen).contains("fake,password-2").doesNotContain("fake-password-3", "");
        // The one buffer the file was in is zeroed, and nothing is held any more.
        assertThat(taken).hasSize(1);
        assertThat(taken.get(0)).hasSize(csv.length).containsOnly((byte) 0);
        assertThat(uploads.heldBytes()).isZero();
        assertThat(files.reads).isEmpty();
        assertThat(hiddenPagesOpened()).containsExactly("chrome://password-manager/passwords");
        // Two rows a batch here, and the page closed after.
        assertThat(cdp.commands("Runtime.callFunctionOn")).hasSize(2);
        assertThat(cdp.commands("Target.closeTarget")).hasSize(1);
        assertThat(output.getAll()).doesNotContain("fake-password-1", "fake,password-2", "fake-user-1", "one.example");
        assertThat(output.getAll()).contains("browser.import passwords: rows=5 added=2 alreadySaved=0 refused=3");
        // Taken: a second finish finds nothing.
        assertErr(rig.call(client, "browser.import.finish", Map.of("uploadId", begun.get("uploadId"))), "not_found",
                Map.of("reason", "upload"));
    }

    @Test
    void eachChunksOwnArrayIsZeroedAsItIsCopiedIn() throws Exception {
        start();
        Session session = rig.sessions.session("cs-a");
        PasswordUploads.Begun begun = uploads.begin("cs-a", 10);
        byte[] first = utf8("fake-");
        byte[] second = utf8("pass!");

        rig.transfers.onMessage(session, new Message(FrameKind.CHUNK, true, false, begun.transferId(), 0, first));
        rig.transfers.onMessage(session, new Message(FrameKind.CHUNK, true, false, begun.transferId(), 1, second));

        assertThat(first).containsOnly((byte) 0);
        assertThat(second).containsOnly((byte) 0);
        byte[] whole = uploads.take("cs-a", begun.uploadId());
        assertThat(new String(whole, StandardCharsets.UTF_8)).isEqualTo("fake-pass!");
        java.util.Arrays.fill(whole, (byte) 0);
        assertThat(uploads.heldBytes()).isZero();
    }

    @Test
    void noFileIsMadeAnywhereOnTheWayIn() throws Exception {
        long since = System.currentTimeMillis() - 1000;
        String marker = "fake-password-" + java.util.UUID.randomUUID();
        // A real Files tree, beside everything else this deskd writes, all under the test's own root.
        try (com.minimalistalliance.desk.deskd.files.AgentFilesRig tree =
                new com.minimalistalliance.desk.deskd.files.AgentFilesRig(dir.resolve("files-module"))) {
            Files.write(tree.root().resolve("notes.txt"), utf8("a member's own file"));
            TestClient client = start(true, true, tree.files().importFiles());
            Map<Path, Long> filesBefore = regularFiles(tree.root());
            Map<Path, Long> allBefore = regularFiles(dir);

            Map<String, Object> reply = rig.importPasswords(client,
                    utf8("url,username,password\nhttps://one.example/,fake-user-1," + marker + "\n"));

            assertThat(reply).containsEntry("_kind", "RES").containsEntry("added", 1);
            assertThat(passwordsSeen).containsExactly(marker);
            // Files, its .uploads and .trash included, is just as it was; nothing new anywhere under the root.
            assertThat(regularFiles(tree.root())).isEqualTo(filesBefore);
            assertThat(regularFiles(dir).keySet()).isSubsetOf(allBefore.keySet());
            assertThat(holding(dir, marker, 0)).isEmpty();
            // Nor in the JVM's temp directory: nothing written there since the test began holds it.
            assertThat(holding(Path.of(System.getProperty("java.io.tmpdir")), marker, since)).isEmpty();
        }
    }

    /** Every regular file under the root, by path, with its size. */
    private static Map<Path, Long> regularFiles(Path root) throws Exception {
        Map<Path, Long> out = new java.util.TreeMap<>();
        try (var walk = Files.walk(root)) {
            for (Path p : (Iterable<Path>) walk.filter(Files::isRegularFile)::iterator) {
                out.put(p, Files.size(p));
            }
        }
        return out;
    }

    /** The files under the root, changed since {@code sinceMs}, whose bytes hold the marker. Unreadable ones are skipped. */
    private static List<Path> holding(Path root, String marker, long sinceMs) throws Exception {
        byte[] needle = utf8(marker);
        List<Path> found = new ArrayList<>();
        Files.walkFileTree(root, java.util.EnumSet.noneOf(java.nio.file.FileVisitOption.class), 5, new java.nio.file.SimpleFileVisitor<>() {
            @Override
            public java.nio.file.FileVisitResult visitFile(Path file, java.nio.file.attribute.BasicFileAttributes attrs) {
                if (attrs.isRegularFile() && attrs.lastModifiedTime().toMillis() >= sinceMs && attrs.size() < 8L * 1024 * 1024) {
                    try {
                        byte[] bytes = Files.readAllBytes(file);
                        if (indexOf(bytes, needle) >= 0) {
                            found.add(file);
                        }
                    } catch (java.io.IOException | SecurityException e) {
                        // Not ours to read.
                    }
                }
                return java.nio.file.FileVisitResult.CONTINUE;
            }

            @Override
            public java.nio.file.FileVisitResult visitFileFailed(Path file, java.io.IOException e) {
                return java.nio.file.FileVisitResult.CONTINUE;
            }
        });
        return found;
    }

    private static int indexOf(byte[] hay, byte[] needle) {
        outer:
        for (int i = 0; i + needle.length <= hay.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (hay[i + j] != needle[j]) {
                    continue outer;
                }
            }
            return i;
        }
        return -1;
    }

    @Test
    void theOldRouteForPasswordsIsRefusedAndAFileInFilesIsNeverReadOrRemoved() throws Exception {
        TestClient client = start();
        byte[] bytes = files.put("Imports/passwords.csv", CSV);

        assertErr(rig.call(client, "browser.import", Map.of("kind", "passwords", "path", "Imports/passwords.csv")), "bad_request",
                Map.of("reason", "use_upload"));
        assertErr(rig.call(client, "browser.import", Map.of("kind", "passwords")), "bad_request", Map.of("reason", "use_upload"));

        assertThat(files.reads).isEmpty();
        assertThat(files.bytes).containsKey("Imports/passwords.csv");
        assertThat(new String(bytes, StandardCharsets.UTF_8)).isEqualTo(CSV);
        assertThat(hiddenPagesOpened()).isEmpty();
        assertThat(passwordsSeen).isEmpty();
    }

    @Test
    void theSizeIsCappedAtTwoMibBeforeAByteIsSent() throws Exception {
        TestClient client = start();
        assertErr(rig.call(client, "browser.import.begin", Map.of("kind", "passwords", "size", PasswordCsv.MAX_BYTES + 1)), "too_large",
                Map.of("limit", PasswordCsv.MAX_BYTES));
        assertErr(rig.call(client, "browser.import.begin", Map.of("kind", "passwords", "size", 1e300)), "too_large",
                Map.of("limit", PasswordCsv.MAX_BYTES));
        for (Object bad : List.of(0, -1, 1.5, "12")) {
            assertErr(rig.call(client, "browser.import.begin", Map.of("kind", "passwords", "size", bad)), "bad_request",
                    Map.of("reason", "size"));
        }
        assertErr(rig.call(client, "browser.import.begin", Map.of("kind", "passwords")), "bad_request", Map.of("reason", "size"));
        assertErr(rig.call(client, "browser.import.begin", Map.of("kind", "bookmarks", "size", 10)), "bad_request", Map.of("reason", "kind"));
        assertThat(uploads.heldBytes()).isZero();

        Map<String, Object> atCap = rig.call(client, "browser.import.begin", Map.of("kind", "passwords", "size", PasswordCsv.MAX_BYTES));
        assertThat(atCap).containsEntry("_kind", "RES");
        assertThat(uploads.heldBytes()).isEqualTo(PasswordCsv.MAX_BYTES);
        assertThat(rig.call(client, "browser.import.abort", Map.of("uploadId", atCap.get("uploadId")))).containsEntry("_kind", "RES");
        assertThat(credit(client, number(atCap, "transferId"))).containsEntry("error", "aborted");
        assertThat(uploads.heldBytes()).isZero();
    }

    @Test
    void bytesPastTheSizeOrOutOfOrderEndTheTransferAndZeroIt() throws Exception {
        TestClient client = start();
        Map<String, Object> begun = rig.call(client, "browser.import.begin", Map.of("kind", "passwords", "size", 8));
        long transferId = number(begun, "transferId");
        chunk(client, transferId, 0, utf8("fake-pass"));
        assertThat(credit(client, transferId)).isEqualTo(Map.of("bytes", 0, "committed", 0, "error", "credit_violation"));
        assertThat(uploads.heldBytes()).isZero();
        assertErr(rig.call(client, "browser.import.finish", Map.of("uploadId", begun.get("uploadId"))), "not_found",
                Map.of("reason", "upload"));

        Map<String, Object> again = rig.call(client, "browser.import.begin", Map.of("kind", "passwords", "size", 8));
        long next = number(again, "transferId");
        chunk(client, next, 0, utf8("fake"));
        chunk(client, next, 2, utf8("pass"));
        assertThat(credit(client, next)).isEqualTo(Map.of("bytes", 0, "committed", 4, "error", "seq"));
        assertThat(uploads.heldBytes()).isZero();
        assertThat(passwordsSeen).isEmpty();
    }

    @Test
    void finishWaitsForTheLastByteAndGivesUpIfItNeverComes() throws Exception {
        TestClient client = start();
        Map<String, Object> begun = rig.call(client, "browser.import.begin", Map.of("kind", "passwords", "size", 100));
        chunk(client, number(begun, "transferId"), 0, utf8("url,password\n"));

        assertErr(rig.call(client, "browser.import.finish", Map.of("uploadId", begun.get("uploadId"))), "conflict",
                Map.of("reason", "incomplete", "committed", 13));

        assertThat(uploads.heldBytes()).isZero();
        assertThat(passwordsSeen).isEmpty();
        assertThat(hiddenPagesOpened()).isEmpty();
    }

    @Test
    void anUploadNobodyFinishesIsZeroedAfterItsIdleTime() throws Exception {
        uploadTiming = new PasswordUploads.Timing(Duration.ofMillis(300), Duration.ofSeconds(1));
        TestClient client = start();
        Map<String, Object> begun = rig.sendPasswords(client, utf8(CSV));
        long transferId = number(begun, "transferId");
        assertThat(credit(client, transferId)).doesNotContainKey("error");

        assertThat(credit(client, transferId)).containsEntry("error", "expired");

        assertThat(uploads.heldBytes()).isZero();
        assertErr(rig.call(client, "browser.import.finish", Map.of("uploadId", begun.get("uploadId"))), "not_found",
                Map.of("reason", "upload"));
        assertThat(passwordsSeen).isEmpty();
    }

    @Test
    void itsSessionsAloneAndZeroedWhenThatSessionEnds() throws Exception {
        TestClient client = start();
        TestClient other = rig.connect("cs-b", true, true);
        Map<String, Object> begun = rig.sendPasswords(client, utf8(CSV));
        credit(client, number(begun, "transferId"));

        assertErr(rig.call(other, "browser.import.begin", Map.of("kind", "passwords", "size", 10)), "conflict", Map.of("reason", "busy"));
        assertErr(rig.call(other, "browser.import.finish", Map.of("uploadId", begun.get("uploadId"))), "not_found",
                Map.of("reason", "upload"));
        assertThat(rig.call(other, "browser.import.abort", Map.of("uploadId", begun.get("uploadId")))).containsEntry("_kind", "RES");
        assertThat(uploads.heldBytes()).isEqualTo(utf8(CSV).length);

        rig.sessions.close("cs-a", 1000, "closed_by_client");

        await().until(() -> uploads.heldBytes() == 0);
        assertThat(rig.call(other, "browser.import.begin", Map.of("kind", "passwords", "size", 10))).containsEntry("_kind", "RES");
        assertThat(passwordsSeen).isEmpty();
    }

    @Test
    void aNewBeginInTheSameSessionZeroesTheOneBefore() throws Exception {
        TestClient client = start();
        Map<String, Object> first = rig.call(client, "browser.import.begin", Map.of("kind", "passwords", "size", 50));
        chunk(client, number(first, "transferId"), 0, utf8("url,password\n"));
        Map<String, Object> second = rig.call(client, "browser.import.begin", Map.of("kind", "passwords", "size", 20));

        assertThat(credit(client, number(first, "transferId"))).containsEntry("error", "superseded");
        assertThat(uploads.heldBytes()).isEqualTo(20);
        assertErr(rig.call(client, "browser.import.finish", Map.of("uploadId", first.get("uploadId"))), "not_found",
                Map.of("reason", "upload"));
        rig.call(client, "browser.import.abort", Map.of("uploadId", second.get("uploadId")));
    }

    @Test
    void importingTheSameFileAgainAddsNothingAndReplacesNothing() throws Exception {
        TestClient client = start();
        rig.importPasswords(client, utf8(CSV));

        Map<String, Object> again = rig.importPasswords(client, utf8(CSV.replace("fake-password-1", "fake-password-changed")));

        assertThat(again).containsEntry("added", 0).containsEntry("alreadySaved", 2);
        assertThat(listOf(again, "notAdded")).contains(row("one.example", "fake-user-1", "exists"));
        assertThat(saved).hasSize(2);
    }

    @Test
    void aFileThatIsntAPasswordsFileIsZeroedAndNothingReachesChromium() throws Exception {
        TestClient client = start();
        List<byte[]> taken = new java.util.concurrent.CopyOnWriteArrayList<>();
        uploads.onTake = taken::add;

        assertErr(rig.importPasswords(client, utf8("title,body\nhello,world\n")), "bad_request", Map.of("reason", "format"));

        assertThat(taken).hasSize(1).first().satisfies(b -> assertThat(b).containsOnly((byte) 0));
        assertThat(uploads.heldBytes()).isZero();
        assertThat(hiddenPagesOpened()).isEmpty();
    }

    @Test
    void aPageThatNeverLoadsChangesNothingAndTheBytesAreStillZeroed() throws Exception {
        TestClient client = start();
        pageLoads = false;
        List<byte[]> taken = new java.util.concurrent.CopyOnWriteArrayList<>();
        uploads.onTake = taken::add;

        Map<String, Object> reply = rig.importPasswords(client, utf8(CSV));

        // No mayHaveApplied: nothing went to Chromium. The bytes are gone all the same, so a retry begins again.
        assertErr(reply, "unavailable", Map.of("reason", "chromium"));
        assertThat(passwordsSeen).isEmpty();
        assertThat(taken).hasSize(1).first().satisfies(b -> assertThat(b).containsOnly((byte) 0));
        assertThat(uploads.heldBytes()).isZero();
        assertThat(cdp.commands("Target.closeTarget")).hasSize(1);
    }

    @Test
    void chromiumFailingPartWayMayHaveApplied() throws Exception {
        TestClient client = start();
        java.util.concurrent.atomic.AtomicInteger calls = new java.util.concurrent.atomic.AtomicInteger();
        cdp.answer("Runtime.callFunctionOn", command -> calls.incrementAndGet() == 1
                ? Map.of("result", Map.of("type", "object", "value", List.of(0, 0)))
                : Map.of("_error", -32000));

        Map<String, Object> reply = rig.importPasswords(client, utf8(CSV));

        assertErr(reply, "unavailable", Map.of("reason", "chromium", "mayHaveApplied", true));
        assertThat(uploads.heldBytes()).isZero();
    }

    @Test
    void anExceptionInThePageIsAFailureAndItsWordsGoNowhere(CapturedOutput output) throws Exception {
        TestClient client = start();
        cdp.answer("Runtime.callFunctionOn", command -> Map.of(
                "result", Map.of("type", "object"),
                "exceptionDetails", Map.of("text", "Uncaught fake-password-1")));

        assertErr(rig.importPasswords(client, utf8(CSV)), "unavailable", Map.of("reason", "chromium", "mayHaveApplied", true));
        assertThat(output.getAll()).doesNotContain("fake-password-1");
    }

    @Test
    void aTeensDeskOrOneWhoseBandIsntKnownGetsNone() throws Exception {
        TestClient client = start();
        Map<String, Object> begun = rig.sendPasswords(client, utf8(CSV));
        files.put("b.html", "<DL><DT><A HREF=\"https://a.example/\">A</A></DL>");
        for (AgeBand.Band notAdult : new AgeBand.Band[] {AgeBand.Band.TEEN, null}) {
            band.set(notAdult);
            Map<String, Object> ageBand = Map.of("reason", "age_band");
            assertErr(rig.call(client, "browser.import", Map.of("kind", "bookmarks", "path", "b.html")), "forbidden", ageBand);
            assertErr(rig.call(client, "browser.import.begin", Map.of("kind", "passwords", "size", 10)), "forbidden", ageBand);
            assertErr(rig.call(client, "browser.import.finish", Map.of("uploadId", begun.get("uploadId"))), "forbidden", ageBand);
            assertErr(rig.call(client, "browser.bookmarks.list", Map.of()), "forbidden", ageBand);
            assertErr(rig.call(client, "browser.extensions.list", Map.of()), "forbidden", ageBand);
            assertErr(rig.call(client, "browser.extension.open", Map.of("id", VAULT)), "forbidden", ageBand);
            assertErr(rig.call(client, "browser.extension.close", Map.of("id", VAULT)), "forbidden", ageBand);
        }
        // The finish a teen's desk refused zeroed what was held.
        assertThat(uploads.heldBytes()).isZero();
        assertThat(files.reads).isEmpty();
        assertThat(cdp.commands("Target.createTarget")).isEmpty();
        assertThat(passwordsSeen).isEmpty();
    }

    @Test
    void aTokenWithoutInputCantImportOrOpenAndOneWithoutVideoCantList() throws Exception {
        TestClient client = start(true, false);
        files.put("b.html", "<DL><DT><A HREF=\"https://a.example/\">A</A></DL>");
        Map<String, Object> permission = Map.of("reason", "permission");
        assertErr(rig.call(client, "browser.import", Map.of("kind", "bookmarks", "path", "b.html")), "forbidden", permission);
        assertErr(rig.call(client, "browser.import.begin", Map.of("kind", "passwords", "size", 10)), "forbidden", permission);
        assertErr(rig.call(client, "browser.import.finish", Map.of("uploadId", "a".repeat(22))), "forbidden", permission);
        assertErr(rig.call(client, "browser.import.abort", Map.of("uploadId", "a".repeat(22))), "forbidden", permission);
        assertErr(rig.call(client, "browser.extension.open", Map.of("id", VAULT)), "forbidden", permission);
        assertErr(rig.call(client, "browser.extension.close", Map.of("id", VAULT)), "forbidden", permission);
        TestClient blind = rig.connect("cs-b", false, true);
        assertErr(rig.call(blind, "browser.bookmarks.list", Map.of()), "forbidden", permission);
        assertErr(rig.call(blind, "browser.extensions.list", Map.of()), "forbidden", permission);
        assertThat(files.reads).isEmpty();
        assertThat(uploads.heldBytes()).isZero();
    }

    @Test
    void badParamsAreRefusedBeforeAnythingIsRead() throws Exception {
        TestClient client = start();
        assertErr(rig.call(client, "browser.import", Map.of("kind", "history", "path", "p.csv")), "bad_request", Map.of("reason", "kind"));
        assertErr(rig.call(client, "browser.import", Map.of("kind", "bookmarks")), "bad_request", Map.of("reason", "path"));
        assertErr(rig.call(client, "browser.import", Map.of("kind", "bookmarks", "path", 7)), "bad_request", Map.of("reason", "path"));
        for (Object bad : List.of("short", "a".repeat(23), "../../../../etc/passwd", 7)) {
            assertErr(rig.call(client, "browser.import.finish", Map.of("uploadId", bad)), "bad_request", Map.of("reason", "uploadId"));
            assertErr(rig.call(client, "browser.import.abort", Map.of("uploadId", bad)), "bad_request", Map.of("reason", "uploadId"));
        }
        assertErr(rig.call(client, "browser.import.finish", Map.of("uploadId", "a".repeat(22))), "not_found", Map.of("reason", "upload"));
        assertThat(files.reads).isEmpty();
    }

    @Test
    void whatFilesSaysIsTheAnswerForBookmarks() throws Exception {
        TestClient client = start();
        files.refuse("missing.html", new RpcException(RpcException.NOT_FOUND, "No such file", Map.of()));
        files.refuse("big.html", new RpcException(RpcException.TOO_LARGE, "too large", Map.of("limit", BookmarksHtml.MAX_BYTES)));

        assertErr(rig.call(client, "browser.import", Map.of("kind", "bookmarks", "path", "missing.html")), "not_found", Map.of());
        assertErr(rig.call(client, "browser.import", Map.of("kind", "bookmarks", "path", "big.html")), "too_large",
                Map.of("limit", BookmarksHtml.MAX_BYTES));
        assertThat(files.maxAsked).containsEntry("big.html", (long) BookmarksHtml.MAX_BYTES);
    }

    // ---- bookmarks

    private static final String BOOKMARKS = """
            <!DOCTYPE NETSCAPE-Bookmark-file-1>
            <META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
            <TITLE>Bookmarks</TITLE>
            <H1>Bookmarks</H1>
            <DL><p>
                <DT><H3 ADD_DATE="1" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
                <DL><p>
                    <DT><A HREF="https://news.example/" ADD_DATE="1" ICON="data:image/png;base64,AAAA">News</A>
                    <DT><H3>Work</H3>
                    <DL><p>
                        <DT><A HREF="https://already.example/">Already</A>
                    </DL><p>
                    <DT><H3>Recipes</H3>
                    <DL><p>
                        <DT><A HREF="https://soup.example/">Soup &amp; bread</A>
                        <DT><A HREF="javascript:void(0)">A bookmarklet</A>
                    </DL><p>
                </DL><p>
                <DT><A HREF="https://other.example/">Other</A>
            </DL><p>
            """;

    @Test
    void bookmarksGoIntoAnImportedFolderWithTheirFoldersAndOnlyWhatsNew() throws Exception {
        TestClient client = start();
        bookmarks.add("2", "Already", "https://already.example/");
        files.put("Imports/bookmarks.html", BOOKMARKS);

        Map<String, Object> reply = rig.call(client, "browser.import", Map.of("kind", "bookmarks", "path", "Imports/bookmarks.html"));

        assertThat(reply)
                .containsEntry("_kind", "RES")
                .containsEntry("kind", "bookmarks")
                .containsEntry("found", 5)
                .containsEntry("added", 3)
                .containsEntry("alreadySaved", 1)
                .containsEntry("refused", 1)
                .doesNotContainKey("deleted");
        String imported = (String) reply.get("folderId");
        assertThat(bookmarks.titleOf(imported)).isEqualTo("Imported");
        assertThat(bookmarks.parentOf(imported)).isEqualTo("2");
        assertThat(bookmarks.paths()).contains(
                "Other bookmarks/Imported/Bookmarks bar/News",
                "Other bookmarks/Imported/Bookmarks bar/Recipes/Soup & bread",
                "Other bookmarks/Imported/Other")
                // A folder with nothing new in it isn't made.
                .noneMatch(p -> p.contains("Work"));
        assertThat(files.bytes).containsKey("Imports/bookmarks.html");
        assertThat(hiddenPagesOpened()).containsExactly("chrome://bookmarks/");

        // Again: nothing new, so nothing is made, not even the folder again.
        int before = bookmarks.size();
        Map<String, Object> again = rig.call(client, "browser.import", Map.of("kind", "bookmarks", "path", "Imports/bookmarks.html"));
        assertThat(again).containsEntry("added", 0).containsEntry("alreadySaved", 4);
        assertThat(bookmarks.size()).isEqualTo(before);
    }

    @Test
    void bookmarksAreListedAFolderAtATime() throws Exception {
        TestClient client = start();
        String folder = bookmarks.add("2", "Travel", null);
        bookmarks.add(folder, "Tra\u202eins", "https://trains.example/");

        Map<String, Object> roots = rig.call(client, "browser.bookmarks.list", Map.of());
        assertThat(roots).containsEntry("more", false);
        assertThat(listOf(roots, "items")).extracting(item -> item.get("title")).containsExactly("Bookmarks bar", "Other bookmarks");

        Map<String, Object> other = rig.call(client, "browser.bookmarks.list", Map.of("folderId", "2"));
        assertThat(other.get("folder")).isEqualTo(Map.of("id", "2", "title", "Other bookmarks", "parentId", "0"));
        assertThat(listOf(other, "items")).containsExactly(Map.of("id", folder, "title", "Travel"));

        Map<String, Object> travel = rig.call(client, "browser.bookmarks.list", Map.of("folderId", folder));
        assertThat(listOf(travel, "items")).hasSize(1).first()
                .satisfies(item -> assertThat(item).containsEntry("title", "Trains").containsEntry("url", "https://trains.example/"));

        assertErr(rig.call(client, "browser.bookmarks.list", Map.of("folderId", "999")), "not_found", Map.of("reason", "folder"));
        assertErr(rig.call(client, "browser.bookmarks.list", Map.of("folderId", "../1")), "bad_request", Map.of("reason", "folderId"));
        assertErr(rig.call(client, "browser.bookmarks.list", Map.of("offset", -1)), "bad_request", Map.of("reason", "offset"));
    }

    // ---- the key button

    @Test
    void theListSaysWhatsInstalledAndOpenUsingOnlyTheAllowedIds() throws Exception {
        TestClient client = start();
        extensionStates.put(VAULT, "ENABLED");
        extensionStates.put(OTHER_VAULT, "DISABLED");
        extensionStates.put(NOT_ALLOWED, "ENABLED");

        Map<String, Object> reply = rig.call(client, "browser.extensions.list", Map.of());

        assertThat(listOf(reply, "extensions")).containsExactly(
                Map.of("id", VAULT, "name", "Fixture Vault", "state", "installed", "open", false),
                Map.of("id", OTHER_VAULT, "name", "Other Vault", "state", "off", "open", false));
        FakeCdp.Command asked = cdp.commands("Runtime.callFunctionOn").get(0);
        assertThat(((Map<?, ?>) ((List<?>) asked.params().get("arguments")).get(0)).get("value")).isEqualTo(List.of(VAULT, OTHER_VAULT));
        assertThat(hiddenPagesOpened()).containsExactly("chrome://extensions/");
    }

    @Test
    void theKeyButtonOpensTheExtensionsOwnPageInATabDeskdNeverTouches() throws Exception {
        TestClient client = start();
        extensionStates.put(VAULT, "ENABLED");

        Map<String, Object> reply = rig.call(client, "browser.extension.open", Map.of("id", VAULT));

        assertThat(reply).containsEntry("_kind", "RES").containsEntry("page", "extension");
        String tabId = (String) reply.get("tabId");
        assertThat(cdp.commands("Target.createTarget")).extracting(c -> Json.string(c.params(), "url"))
                .contains("chrome-extension://" + VAULT + "/popup/index.html");
        Map<String, Object> listed = rig.call(client, "browser.extensions.list", Map.of());
        assertThat(listOf(listed, "extensions").get(0)).containsEntry("open", true);
        // Not the member's tab: not listed, never attached to, never asked anything.
        Map<String, Object> tabs = rig.call(client, "browser.tab.list", Map.of(), null);
        assertThat(listOf(tabs, "tabs")).extracting(tab -> tab.get("tabId")).doesNotContain(tabId);
        assertThat(cdp.commands("Target.attachToTarget")).extracting(c -> Json.string(c.params(), "targetId")).doesNotContain(tabId);
        assertThat(cdp.commands()).filteredOn(c -> FakeCdp.sessionOf(tabId).equals(c.sessionId())).isEmpty();

        // Pressed again while it's open: that tab comes to the front, and no second one.
        Map<String, Object> again = rig.call(client, "browser.extension.open", Map.of("id", VAULT));
        assertThat(again).containsEntry("tabId", tabId);
        assertThat(cdp.commands("Target.activateTarget")).extracting(c -> Json.string(c.params(), "targetId")).contains(tabId);
    }

    @Test
    void closingItGoesBackToTheTabTheMemberWasOn() throws Exception {
        TestClient client = start();
        extensionStates.put(VAULT, "ENABLED");
        await().until(() -> "a".equals(activeOf(client)));
        String tabId = (String) rig.call(client, "browser.extension.open", Map.of("id", VAULT)).get("tabId");
        cdp.clearCommands();

        Map<String, Object> reply = rig.call(client, "browser.extension.close", Map.of("id", VAULT));

        assertThat(reply).containsEntry("closed", 1);
        assertThat(cdp.commands("Target.activateTarget")).extracting(c -> Json.string(c.params(), "targetId")).containsExactly("a");
        assertThat(cdp.commands("Target.closeTarget")).extracting(c -> Json.string(c.params(), "targetId")).containsExactly(tabId);
        assertThat(rig.call(client, "browser.extension.close", Map.of("id", VAULT))).containsEntry("closed", 0);
    }

    @Test
    void closingItWhenItsTheLastTabLeavesAnEmptyOneSoChromiumStays() throws Exception {
        TestClient client = start();
        extensionStates.put(VAULT, "ENABLED");
        rig.call(client, "browser.extension.open", Map.of("id", VAULT));
        cdp.destroy("a");
        await().until(() -> listOf(rig.call(client, "browser.tab.list", Map.of(), null), "tabs").isEmpty());
        cdp.clearCommands();

        assertThat(rig.call(client, "browser.extension.close", Map.of("id", VAULT))).containsEntry("closed", 1);

        assertThat(cdp.commands("Target.createTarget")).extracting(c -> Json.string(c.params(), "url")).containsExactly("about:blank");
    }

    @Test
    void notInstalledYetOpensItsWebStorePageAsTheMembersTab() throws Exception {
        TestClient client = start();

        Map<String, Object> reply = rig.call(client, "browser.extension.open", Map.of("id", VAULT));

        assertThat(reply).containsEntry("page", "store");
        assertThat(cdp.commands("Target.createTarget")).extracting(c -> Json.string(c.params(), "url"))
                .contains("https://chromewebstore.google.com/detail/" + VAULT);
        String tabId = (String) reply.get("tabId");
        await().until(() -> listOf(rig.call(client, "browser.tab.list", Map.of(), null), "tabs").stream().anyMatch(t -> tabId.equals(t.get("tabId"))));
    }

    @Test
    void turnedOffSaysSoAndAnIdOffTheListIsRefused() throws Exception {
        TestClient client = start();
        extensionStates.put(VAULT, "DISABLED");
        assertErr(rig.call(client, "browser.extension.open", Map.of("id", VAULT)), "unavailable", Map.of("reason", "extension_off"));
        assertErr(rig.call(client, "browser.extension.open", Map.of("id", NOT_ALLOWED)), "forbidden", Map.of("reason", "extension"));
        assertErr(rig.call(client, "browser.extension.close", Map.of("id", NOT_ALLOWED)), "forbidden", Map.of("reason", "extension"));
        assertErr(rig.call(client, "browser.extension.open", Map.of("id", "chrome://settings")), "bad_request", Map.of("reason", "id"));
        assertErr(rig.call(client, "browser.extension.open", Map.of()), "bad_request", Map.of("reason", "id"));
        assertThat(cdp.commands("Target.createTarget")).extracting(c -> Json.string(c.params(), "url"))
                .noneMatch(url -> url.startsWith("chrome-extension:"));
    }

    @Test
    void theLaunchListIsTheThreePasswordManagers() {
        PasswordManagers launch = new PasswordManagers(PasswordManagers.LAUNCH);
        assertThat(launch.all()).extracting(PasswordManagers.Manager::name).containsExactly("Bitwarden", "1Password", "Proton Pass");
        assertThat(launch.ids()).containsExactly(
                "nngceckbapebfimnlniiiahkandclblb", "aeblfdkhhhdcdjpifhhbdiojplfjncoa", "ghmbeldphafepmbegfdlkpapadhbakde");
        assertThat(launch.get("nngceckbapebfimnlniiiahkandclblb").pageUrl())
                .isEqualTo("chrome-extension://nngceckbapebfimnlniiiahkandclblb/popup/index.html?uilocation=popout");
    }

    @Test
    void aTableEntryThatIsntAnIdAndAPageIsRefused() {
        for (PasswordManagers.Manager bad : List.of(
                new PasswordManagers.Manager("NNGCECKBAPEBFIMNLNIIIAHKANDCLBLB", "x", "popup.html"),
                new PasswordManagers.Manager(VAULT, "x", "../../etc/passwd"),
                new PasswordManagers.Manager(VAULT, "x", "popup.html#x"),
                new PasswordManagers.Manager(VAULT, "x", "javascript:alert(1)"))) {
            org.assertj.core.api.Assertions.assertThatThrownBy(() -> new PasswordManagers(List.of(bad)))
                    .isInstanceOf(IllegalArgumentException.class);
        }
    }

    private String activeOf(TestClient client) throws Exception {
        return listOf(rig.call(client, "browser.tab.list", Map.of(), null), "tabs").stream()
                .filter(tab -> Boolean.TRUE.equals(tab.get("active"))).map(tab -> (String) tab.get("tabId")).findFirst().orElse(null);
    }

    /** Files as the import sees them: whole files by path, and what was read. */
    private static final class MemoryFiles implements ImportFiles {
        final Map<String, byte[]> bytes = new ConcurrentHashMap<>();
        private final Map<String, RpcException> refusals = new ConcurrentHashMap<>();
        final List<String> reads = new java.util.concurrent.CopyOnWriteArrayList<>();
        final Map<String, Long> maxAsked = new ConcurrentHashMap<>();

        byte[] put(String path, String text) {
            byte[] b = text.getBytes(StandardCharsets.UTF_8);
            bytes.put(path, b);
            return b;
        }

        void refuse(String path, RpcException e) {
            refusals.put(path, e);
        }

        @Override
        public Read read(String path, long maxBytes) throws RpcException {
            reads.add(path);
            maxAsked.put(path, maxBytes);
            RpcException refusal = refusals.get(path);
            if (refusal != null) {
                throw refusal;
            }
            byte[] b = bytes.get(path);
            if (b == null) {
                throw new RpcException(RpcException.NOT_FOUND, "No such file", Map.of());
            }
            return new Read(b.clone(), b.length, 1L);
        }
    }

    /** Chromium's bookmarks, as chrome.bookmarks keeps them: ids as strings, 0 the root, 1 and 2 its folders. */
    private static final class FakeBookmarks {
        private record Node(String id, String parent, String title, String url) {}

        private final Map<String, Node> nodes = new LinkedHashMap<>();
        private int next = 3;

        FakeBookmarks() {
            nodes.put("1", new Node("1", "0", "Bookmarks bar", null));
            nodes.put("2", new Node("2", "0", "Other bookmarks", null));
        }

        synchronized String add(String parent, String title, String url) {
            String id = Integer.toString(next++);
            nodes.put(id, new Node(id, parent, title, url));
            return id;
        }

        synchronized boolean hasUrl(String url) {
            return nodes.values().stream().anyMatch(n -> url.equals(n.url()));
        }

        synchronized String importedFolder(String title) {
            for (Node n : nodes.values()) {
                if ("2".equals(n.parent()) && n.url() == null && title.equals(n.title())) {
                    return n.id();
                }
            }
            return add("2", title, null);
        }

        synchronized List<Object> create(List<?> ops) {
            List<Object> made = new ArrayList<>();
            for (Object raw : ops) {
                Map<?, ?> op = (Map<?, ?>) raw;
                Object parent = op.containsKey("p") ? op.get("p") : made.get(((Number) op.get("i")).intValue());
                if (!(parent instanceof String p) || !nodes.containsKey(p)) {
                    made.add(null);
                    continue;
                }
                made.add(add(p, (String) op.get("t"), (String) op.get("u")));
            }
            return made;
        }

        synchronized Map<String, Object> list(String id, int offset, int max) {
            Node node = "0".equals(id) ? new Node("0", null, "", null) : nodes.get(id);
            if (node == null) {
                return Map.of("missing", true);
            }
            if (node.url() != null) {
                return Map.of("notFolder", true);
            }
            List<Map<String, Object>> kids = new ArrayList<>();
            for (Node n : nodes.values()) {
                if (id.equals(n.parent())) {
                    Map<String, Object> item = new LinkedHashMap<>();
                    item.put("id", n.id());
                    item.put("title", n.title());
                    if (n.url() != null) {
                        item.put("url", n.url());
                    }
                    kids.add(item);
                }
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("id", node.id());
            out.put("title", node.title());
            out.put("parentId", node.parent());
            out.put("items", kids.subList(Math.min(offset, kids.size()), Math.min(kids.size(), offset + max)));
            out.put("more", kids.size() > offset + max);
            return out;
        }

        synchronized String titleOf(String id) {
            return nodes.get(id).title();
        }

        synchronized String parentOf(String id) {
            return nodes.get(id).parent();
        }

        synchronized int size() {
            return nodes.size();
        }

        synchronized List<String> paths() {
            List<String> paths = new ArrayList<>();
            for (Node n : nodes.values()) {
                if (n.url() == null) {
                    continue;
                }
                StringBuilder path = new StringBuilder(n.title());
                Set<String> seen = new HashSet<>();
                for (Node up = nodes.get(n.parent()); up != null && seen.add(up.id()); up = nodes.get(up.parent())) {
                    path.insert(0, up.title() + "/");
                }
                paths.add(path.toString());
            }
            return paths;
        }
    }
}
