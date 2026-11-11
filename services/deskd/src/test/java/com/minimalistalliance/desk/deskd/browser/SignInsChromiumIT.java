package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.files.ImportFiles;
import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.io.IOException;
import java.io.InputStream;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

/**
 * The sign-ins against a real Chromium, headless, with a fixture extension loaded unpacked: that its own Password Manager,
 * bookmarks and extensions pages answer the constant functions as {@link SignIns} expects, hidden. Every password here is
 * an obviously fake one. Run it as ChromiumIT is run:
 *
 * <pre>DESKD_CHROMIUM_BIN=/path/to/chrome ./mvnw -q -pl deskd verify -Dtest=none -Dsurefire.failIfNoSpecifiedTests=false -Dit.test=SignInsChromiumIT</pre>
 *
 * <p>It can't cover a headed kiosk window (what a member sees of an extension's page in a tab), a Web Store install, or a
 * real password manager.
 */
@EnabledIfEnvironmentVariable(named = "DESKD_CHROMIUM_BIN", matches = ".+")
class SignInsChromiumIT {

    /** The fixture's id, fixed by the throwaway public key in its manifest. */
    private static final String FIXTURE = "jfaikohgellognmmahngiljhfiokfocb";
    /** On the list and not installed. */
    private static final String ABSENT = "ppppoooonnnnmmmmllllkkkkjjjjiiii";

    @TempDir
    Path dir;

    private int port;
    private Process chromium;
    private BrowserRig rig;
    private TestClient client;
    private final Map<String, byte[]> files = new ConcurrentHashMap<>();

    @BeforeEach
    void setUp() throws Exception {
        port = freePort();
        Path extension = copyFixture();
        chromium = new ProcessBuilder(
                        System.getenv("DESKD_CHROMIUM_BIN"),
                        "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                        "--noerrdialogs", "--disable-breakpad", "--password-store=basic", "--window-size=1280,800",
                        "--user-data-dir=" + dir.resolve("profile"),
                        "--load-extension=" + extension, "--disable-extensions-except=" + extension,
                        "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=" + port,
                        "about:blank")
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.appendTo(dir.resolve("chromium.log").toFile()))
                .start();
        await().atMost(Duration.ofSeconds(30)).until(() -> list() != null);
        BrowserTabs.Timing real = BrowserTabs.Timing.DEFAULT;
        rig = new BrowserRig(dir, port, new BrowserTabs.Timing(
                real.publishEvery(), Duration.ofMinutes(5), Duration.ofSeconds(5), Duration.ofSeconds(10), Duration.ofSeconds(10),
                real.navigate(), real.settle(), real.listEvery(), real.visibility(), real.restartEvery(), real.cdp()));
        ImportFiles fromFiles = (path, maxBytes) -> {
            byte[] bytes = files.get(path);
            if (bytes == null) {
                throw new RpcException(RpcException.NOT_FOUND, "No such file", Map.of());
            }
            return new ImportFiles.Read(bytes.clone(), bytes.length, 1);
        };
        rig.module.enableSignIns(fromFiles, rig.transfers, () -> AgeBand.Band.ADULT, new PasswordManagers(List.of(
                new PasswordManagers.Manager(FIXTURE, "Fixture Vault", "popup/index.html"),
                new PasswordManagers.Manager(ABSENT, "Absent Vault", "popup.html"))),
                new SignIns.Timing(Duration.ofSeconds(15), Duration.ofSeconds(30), 100, 200), PasswordUploads.Timing.DEFAULT);
        client = rig.connect("cs-a");
    }

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            rig.close();
        }
        if (chromium != null) {
            chromium.toHandle().descendants().forEach(ProcessHandle::destroy);
            chromium.destroy();
            if (!chromium.waitFor(10, TimeUnit.SECONDS)) {
                chromium.toHandle().descendants().forEach(ProcessHandle::destroyForcibly);
                chromium.destroyForcibly();
            }
        }
    }

    private Path copyFixture() throws IOException {
        Path to = dir.resolve("fixture-extension");
        for (String file : List.of("manifest.json", "sw.js", "popup/index.html")) {
            try (InputStream in = getClass().getResourceAsStream("/signin/fixture-extension/" + file)) {
                Files.createDirectories(to.resolve(file).getParent());
                Files.write(to.resolve(file), in.readAllBytes());
            }
        }
        return to;
    }

    private static int freePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    /** /json/list's targets, by HTTP, or null while Chromium doesn't answer. */
    private List<Map<String, Object>> list() {
        try (HttpClient http = HttpClient.newHttpClient()) {
            HttpResponse<String> response = http.send(
                    HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/json/list")).timeout(Duration.ofSeconds(3)).build(),
                    HttpResponse.BodyHandlers.ofString());
            Map<String, Object> wrapped = Json.parseObject(("{\"l\":" + response.body() + "}").getBytes(StandardCharsets.UTF_8));
            List<Map<String, Object>> targets = new ArrayList<>();
            for (Object item : (List<?>) wrapped.get("l")) {
                @SuppressWarnings("unchecked")
                Map<String, Object> target = (Map<String, Object>) item;
                targets.add(target);
            }
            return targets;
        } catch (Exception e) {
            return null;
        }
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> listOf(Map<String, Object> reply, String key) {
        return (List<Map<String, Object>>) reply.get(key);
    }

    private Map<String, Object> call(String method, Map<String, Object> params) throws Exception {
        Map<String, Object> reply = rig.call(client, method, params);
        assertThat(reply).containsEntry("_kind", "RES");
        return reply;
    }

    private Map<String, Object> importPasswords(String csv) throws Exception {
        Map<String, Object> reply = rig.importPasswords(client, csv.getBytes(StandardCharsets.UTF_8));
        assertThat(reply).containsEntry("_kind", "RES");
        return reply;
    }

    @Test
    void passwordsGoIntoChromiumsPasswordManagerOnceAndNothingIsLeftOpen() throws Exception {
        // Over the session into deskd's memory, as the Desk app sends them: begin, the bytes on bulk, finish.
        Map<String, Object> first = importPasswords("name,url,username,password,note\n"
                + "One,https://one.example/login,fake-user-1,fake-password-1,a note\n"
                + "Two,https://two.example/,fake-user-2,\"fake,password-2\",\n"
                + "Files,ftp://files.example/,fake-user-3,fake-password-3,\n");
        assertThat(first).containsEntry("found", 3).containsEntry("added", 2).containsEntry("alreadySaved", 0)
                .containsEntry("refused", 1);

        // The same rows again, one with another password: Chromium keeps what it has.
        Map<String, Object> again = importPasswords("url,username,password\n"
                + "https://one.example/login,fake-user-1,fake-password-changed\n"
                + "https://two.example/,fake-user-2,\"fake,password-2\"\n");
        assertThat(again).containsEntry("added", 0).containsEntry("alreadySaved", 2);
        // The hidden page went with the call (Chromium's own toolbar and omnibox are listed too, and aren't deskd's).
        await().atMost(Duration.ofSeconds(5)).until(() -> list().stream().map(t -> (String) t.get("url"))
                .noneMatch(url -> url.startsWith("chrome://password-manager") || url.startsWith("chrome://bookmarks")
                        || url.startsWith("chrome://extensions")));
    }

    @Test
    void bookmarksGoInAnImportedFolderAndCanBeListed() throws Exception {
        files.put("b.html", """
                <!DOCTYPE NETSCAPE-Bookmark-file-1>
                <DL><p>
                    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
                    <DL><p>
                        <DT><A HREF="https://news.example/">News</A>
                        <DT><A HREF="javascript:void(0)">Bookmarklet</A>
                    </DL><p>
                    <DT><A HREF="https://other.example/">Other</A>
                </DL><p>
                """.getBytes(StandardCharsets.UTF_8));

        Map<String, Object> imported = call("browser.import", Map.of("kind", "bookmarks", "path", "b.html"));
        assertThat(imported).containsEntry("added", 2).containsEntry("refused", 1).doesNotContainKey("deleted");
        String folderId = (String) imported.get("folderId");

        Map<String, Object> roots = call("browser.bookmarks.list", Map.of());
        String other = listOf(roots, "items").stream().filter(i -> "Other bookmarks".equals(i.get("title")))
                .map(i -> (String) i.get("id")).findFirst().orElseThrow();
        Map<String, Object> inOther = call("browser.bookmarks.list", Map.of("folderId", other));
        assertThat(listOf(inOther, "items")).contains(Map.of("id", folderId, "title", "Imported"));
        Map<String, Object> inImported = call("browser.bookmarks.list", Map.of("folderId", folderId));
        assertThat(listOf(inImported, "items")).extracting(i -> i.get("title")).containsExactly("Bookmarks bar", "Other");
        assertThat(inImported.get("folder")).isEqualTo(Map.of("id", folderId, "title", "Imported", "parentId", other));
        String bar = (String) listOf(inImported, "items").get(0).get("id");
        List<Map<String, Object>> inBar = listOf(call("browser.bookmarks.list", Map.of("folderId", bar)), "items");
        assertThat(inBar).hasSize(1);
        assertThat(inBar.get(0)).containsEntry("title", "News").containsEntry("url", "https://news.example/");

        Map<String, Object> again = call("browser.import", Map.of("kind", "bookmarks", "path", "b.html"));
        assertThat(again).containsEntry("added", 0).containsEntry("alreadySaved", 2).containsEntry("folderId", null);
        assertThat(rig.call(client, "browser.bookmarks.list", Map.of("folderId", "987654"))).containsEntry("code", "not_found");
    }

    @Test
    void theKeyButtonOpensTheExtensionsOwnPageAndClosesIt() throws Exception {
        Map<String, Object> extensions = call("browser.extensions.list", Map.of());
        assertThat(listOf(extensions, "extensions")).containsExactly(
                Map.of("id", FIXTURE, "name", "Fixture Vault", "state", "installed", "open", false),
                Map.of("id", ABSENT, "name", "Absent Vault", "state", "missing", "open", false));

        Map<String, Object> opened = call("browser.extension.open", Map.of("id", FIXTURE));
        assertThat(opened).containsEntry("page", "extension");
        String tabId = (String) opened.get("tabId");
        // Its own page, loaded: the title is the fixture's, not Chromium's error page's.
        await().atMost(Duration.ofSeconds(10)).until(() -> list().stream().anyMatch(
                t -> tabId.equals(t.get("id")) && "Fixture Vault".equals(t.get("title"))
                        && ("chrome-extension://" + FIXTURE + "/popup/index.html").equals(t.get("url"))));
        assertThat(listOf(rig.call(client, "browser.tab.list", Map.of(), null), "tabs")).extracting(t -> t.get("tabId")).doesNotContain(tabId);
        assertThat(listOf(call("browser.extensions.list", Map.of()), "extensions").get(0)).containsEntry("open", true);

        assertThat(call("browser.extension.close", Map.of("id", FIXTURE))).containsEntry("closed", 1);
        await().atMost(Duration.ofSeconds(10)).until(() -> list().stream().noneMatch(t -> tabId.equals(t.get("id"))));
        assertThat(list()).extracting(t -> (String) t.get("type")).contains("page");
    }
}
