package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.browser.minified.MinifiedModule;
import com.minimalistalliance.desk.deskd.browser.minified.MinifiedSwitch;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import com.minimalistalliance.desk.deskd.tools.BrowserTools;
import com.minimalistalliance.desk.deskd.tools.HostedCall;
import com.minimalistalliance.desk.deskd.tools.HostedTool;
import com.minimalistalliance.desk.deskd.tools.RunLedger;
import com.minimalistalliance.desk.deskd.tools.ToolFailure;
import com.minimalistalliance.desk.deskd.tools.ToolRisk;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

/**
 * The Agent's Browser against a real Chromium, headless, on pages from a local server only: what a fake can't show. The
 * run's off-the-record context keeps its cookies from the member's and the member's from it, and goes at the run's end;
 * Agent tabs are hidden targets the member's list never has; the member's session tab sees the member's cookies, and a
 * navigation off its site never reaches the other site; the walker reads and the action proxy acts through the Browser
 * tools, refs and all, and a field that turns into a password one is refused. {@code a.test} and {@code b.test} both
 * resolve to the local server, as two sites; {@code 127.0.0.1} is the local host no Agent page may reach.
 *
 * <p>S-14: clicks and keys are deskd's half's own, from deskd's world, so they work where trusted input doesn't reach a
 * hidden target: with {@code DESKD_CHROMIUM_HEADFUL} set (under {@code xvfb-run}) Chromium runs as a desk's kiosk does,
 * where Chrome 156 gives a hidden target no trusted input, and every test here passes the same. A link, a submit button
 * ({@code send}), a pay button ({@code spend}), Enter in a form field ({@code send}), a click in the member's session
 * ({@code write}, a link {@code egress}), an off-site link there (refused, and cancelled), a sensitive field (refused),
 * typed quotes and backticks (text), and a frame of another site in a process of its own whose local requests stop too.
 *
 * <pre>DESKD_CHROMIUM_BIN=/path/to/chrome ./mvnw -q -pl deskd verify -Dtest=none -Dsurefire.failIfNoSpecifiedTests=false -Dit.test=AgentBrowsingChromiumIT</pre>
 * and, as a desk runs, {@code DESKD_CHROMIUM_HEADFUL=1 xvfb-run -a} before the same.
 */
@EnabledIfEnvironmentVariable(named = "DESKD_CHROMIUM_BIN", matches = ".+")
@SuppressWarnings("unchecked")
class AgentBrowsingChromiumIT {

    @TempDir
    Path dir;

    private int port;
    private int cdpPort;
    private Process chromium;
    private HttpServer pages;
    private final Map<String, AtomicInteger> hits = new ConcurrentHashMap<>();
    private BrowserRig rig;
    private TestClient client;
    private AgentBrowsing agent;
    private BrowserTools tools;
    private final RunLedger ledger = new RunLedger(Clock.systemUTC(), runId -> {});

    @BeforeEach
    void setUp() throws Exception {
        pages = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        port = pages.getAddress().getPort();
        pages.createContext("/", exchange -> {
            String host = exchange.getRequestHeaders().getFirst("Host");
            String path = exchange.getRequestURI().getPath();
            String query = exchange.getRequestURI().getRawQuery();
            hits.computeIfAbsent((host == null ? "" : host.replaceFirst(":.*", "")) + path, k -> new AtomicInteger()).incrementAndGet();
            if (path.equals("/away")) {
                exchange.getResponseHeaders().set("Location", "http://b.test:" + port + "/landed");
                exchange.sendResponseHeaders(302, -1);
                exchange.close();
                return;
            }
            if (path.equals("/set") && query != null && query.matches("who=[a-z]+")) {
                exchange.getResponseHeaders().add("Set-Cookie", query + "; Path=/; Max-Age=3600");
            }
            byte[] body = html(path).getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "text/html; charset=utf-8");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        pages.start();
        cdpPort = freePort();
        List<String> command = new java.util.ArrayList<>(List.of(
                System.getenv("DESKD_CHROMIUM_BIN"),
                "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                "--noerrdialogs", "--disable-breakpad", "--password-store=basic", "--window-size=1280,800",
                "--user-data-dir=" + dir.resolve("profile"),
                "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=" + cdpPort,
                "--host-resolver-rules=MAP a.test 127.0.0.1, MAP www.a.test 127.0.0.1, MAP b.test 127.0.0.1",
                "about:blank"));
        if (System.getenv("DESKD_CHROMIUM_HEADFUL") != null) {
            // As on a desk: a kiosk window on an X display with no window manager (run under xvfb-run).
            command.set(1, "--kiosk");
            command.add(2, "--ozone-platform=x11");
        }
        chromium = new ProcessBuilder(command)
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.appendTo(dir.resolve("chromium.log").toFile()))
                .start();
        await().atMost(Duration.ofSeconds(30)).until(this::debuggingPortAnswers);
        rig = new BrowserRig(dir, cdpPort, BrowserRig.timing(Duration.ofMillis(250), Duration.ofMinutes(5)));
        rig.module.enableMinified(dir, Clock.systemUTC(), new MinifiedModule.Timing(
                Duration.ofSeconds(10), Duration.ofSeconds(8), Duration.ofSeconds(20), Duration.ofMillis(24), Duration.ofMillis(100),
                Duration.ofSeconds(30)), MinifiedSwitch.fixed(true, false, false));
        agent = (AgentBrowsing) rig.module.enableAgentBrowsing(() -> false);
        tools = new BrowserTools(agent);
        client = rig.connect("cs-a");
    }

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            rig.close();
        }
        if (pages != null) {
            pages.stop(0);
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

    private static final String PROSE = "The lamp has lit the reading rooms of the world for a long time, and it is still the best way to "
            + "read at night without waking anyone else in the house. ";

    private String html(String path) {
        return switch (path) {
            case "/set" -> "<title>Set</title><main><h1>Set</h1><p>" + PROSE.repeat(3) + "</p></main>";
            // What the page sees of its cookies, as text the walker reads.
            case "/show" -> "<title>Show</title><main><h1>Cookies</h1><p id=c>none</p><p>" + PROSE.repeat(3) + "</p></main>"
                    + "<script>document.getElementById('c').textContent = 'cookies: [' + document.cookie + ']'</script>";
            case "/form" -> "<title>Form</title><main><h1>A form</h1><p>" + PROSE.repeat(3) + "</p>"
                    + "<p><label>Name <input id=q name=q></label> <button id=go type=button "
                    + "onclick=\"document.getElementById('out').textContent='Hello, '+document.getElementById('q').value\">Greet</button></p>"
                    + "<p id=out>Nobody yet</p><p><label>Code <input id=flip onfocus=\"this.type='password'\"></label></p></main>";
            case "/jump" -> "<title>Jump</title><main><h1>Jump</h1><p>" + PROSE.repeat(3) + "</p></main>"
                    + "<script>setTimeout(function(){location.href='http://b.test:" + port + "/jumped'}, 50)</script>";
            case "/links" -> "<title>Links</title><main><h1>Links</h1><p>" + PROSE.repeat(3) + "</p>"
                    + "<p><a href=\"/page\">Next page</a> and <a href=\"http://b.test:" + port + "/direct-link\">Other site</a> and "
                    + "<a href=\"/away\">Away</a></p>"
                    + "<p><button type=button onclick=\"document.getElementById('st').textContent='More shown'\">Show more</button> "
                    + "<button type=button onclick=\"location.href='http://b.test:" + port + "/jsaway'\">Leave by script</button></p>"
                    + "<p id=st>Nothing shown yet</p></main>";
            case "/shop" -> "<title>Shop</title><main><h1>Shop</h1><p>" + PROSE.repeat(3) + "</p>"
                    // The form's controls are the form's by its id, as the walker reads a <form> itself as the site's menu.
                    + "<h2>Write to us</h2><p><label>Name <input name=name id=name form=f1></label></p>"
                    + "<p><label>Message <input name=msg id=msg form=f1></label></p><p><button type=submit form=f1>Send message</button></p>"
                    + "<p><button type=button onclick=\"document.getElementById('paid').textContent='Paid now'\">Pay now</button></p>"
                    + "<p id=paid>Not paid</p>"
                    + "<p><label>Card number <input id=cn></label></p>"
                    + "<p><label>Code <input id=flip onfocus=\"this.type='password'\"></label></p>"
                    + "<p><label>Echo <input id=echo oninput=\"document.getElementById('echoed').textContent='Echoed: '+this.value\"></label></p>"
                    + "<p id=echoed>Echoed: none</p></main><form id=f1 action=\"/sent\" method=get></form>";
            // Boxes the page made read-only, each telling of any input it gets, and one beside them that isn't.
            case "/readonly" -> "<title>Read only</title><main><h1>Read only</h1><p>" + PROSE.repeat(6) + "</p><p>" + PROSE.repeat(6) + "</p>"
                    + "<p><label>Account <input id=acct readonly value=\"A-123\" oninput=\"touched('acct')\"></label></p>"
                    + "<p><label>Plan <input id=plan aria-readonly=true value=\"Basic\" oninput=\"touched('plan')\"></label></p>"
                    + "<p><label>Terms <textarea id=terms readonly oninput=\"touched('terms')\">As agreed</textarea></label></p>"
                    + "<fieldset disabled><p><label>Old address <input id=old value=\"1 Lamp St\" oninput=\"touched('old')\"></label></p></fieldset>"
                    + "<div role=textbox aria-label=\"Signed note\" contenteditable=true aria-readonly=true oninput=\"touched('note')\">Signed</div>"
                    + "<div contenteditable=false><span role=textbox tabindex=0 aria-label=\"Mention\" oninput=\"touched('mention')\">@ann</span></div>"
                    + "<p><label>Echo <input id=echo oninput=\"document.getElementById('echoed').textContent='Echoed: '+this.value\"></label></p>"
                    + "<p id=echoed>Echoed: none</p><p id=t>Touched: none</p><p>" + PROSE.repeat(6) + "</p></main>"
                    + "<script>function touched(w){document.getElementById('t').textContent='Touched: '+w}</script>";
            case "/sent" -> "<title>Sent</title><main><h1>Sent</h1><p id=m>Nothing</p><p>" + PROSE.repeat(3) + "</p></main>"
                    + "<script>document.getElementById('m').textContent='Sent: '+new URLSearchParams(location.search).get('msg')</script>";
            // A frame of another site, in a process of its own, with a local host in it; a local host straight in a frame; and
            // another such frame born after the page has loaded.
            case "/framed" -> "<title>Framed</title><main><h1>Framed</h1><p>" + PROSE.repeat(3) + "</p>"
                    + "<iframe src=\"http://b.test:" + port + "/inner?n=nested\" width=400 height=200></iframe>"
                    + "<iframe src=\"http://127.0.0.1:" + port + "/secret-direct\" width=400 height=200></iframe></main>"
                    + "<script>setTimeout(function(){var f=document.createElement('iframe');f.width=400;f.height=200;"
                    + "f.src='http://b.test:" + port + "/inner?n=late';document.querySelector('main').appendChild(f)}, 1500)</script>";
            case "/inner" -> "<title>Inner</title><p>Inner frame</p><iframe id=f width=300 height=100></iframe>"
                    + "<script>document.getElementById('f').src='http://127.0.0.1:" + port + "/secret-'"
                    + "+new URLSearchParams(location.search).get('n')</script>";
            default -> "<title>Page</title><main><h1>A page</h1><p>" + PROSE.repeat(3) + "</p></main>";
        };
    }

    private String url(String host, String path) {
        return "http://" + host + ":" + port + path;
    }

    private String memberTab() throws Exception {
        List<Map<String, Object>> tabs = (List<Map<String, Object>>) rig.call(client, "browser.tab.list", Map.of(), null).get("tabs");
        assertThat(tabs).hasSize(1);
        return (String) tabs.get(0).get("tabId");
    }

    private void memberGoesTo(String url) throws Exception {
        Map<String, Object> reply = rig.call(client, "browser.tab.navigate", Map.of("url", url));
        assertThat(reply).containsEntry("_kind", "RES");
        Thread.sleep(300);
    }

    /** The member's own cookies, as data.browser.cookies reads them: the default context's. */
    private List<String> memberCookies() throws Exception {
        return rig.module.cookies().stream().map(c -> c.get("name") + "=" + c.get("value")).sorted().toList();
    }

    private String text(String runId, String tabId) throws Exception {
        Map<String, Object> content = (Map<String, Object>) exec(runId, "browser_read", Map.of("tabId", tabId)).content();
        assertThat(content).containsEntry("view", "page");
        return (String) content.get("text");
    }

    private HostedTool.Look look(String runId, String tool, Map<String, Object> args) throws Exception {
        HostedCall call = new HostedCall(1, runId, "ag-1", tool, new LinkedHashMap<>(args), null, true, Caller.THE_OWNER, null);
        return tools.look(call, ledger.join(runId, "ag-1", Caller.THE_OWNER, List.of()));
    }

    /** As desk-agent runs a call the member approved: with exactly the payload deskd's look gave for the card. */
    private HostedTool.Result approved(String runId, String tool, HostedTool.Look look) throws Exception {
        return exec(runId, tool, look.payload());
    }

    /** Where a page's control is in the walker's view: {node, fp, block, rev}, for a call into the action proxy itself. */
    private Object[] control(String runId, String tabId, String label) throws Exception {
        Map<String, Object> mdoc = (Map<String, Object>) agent.read(runId, tabId).get("mdoc");
        for (Object block : (List<Object>) mdoc.get("blocks")) {
            Object[] found = find(block, label);
            if (found != null) {
                return new Object[] {found[0], found[1], ((Map<String, Object>) block).get("key"), ((Number) mdoc.get("rev")).longValue()};
            }
        }
        throw new AssertionError("no control " + label);
    }

    private static Object[] find(Object value, String label) {
        if (value instanceof Map<?, ?> map) {
            if (map.get("node") instanceof String node && (label.equals(map.get("label"))
                    || map.get("runs") instanceof List<?> runs && runs.contains(label))) {
                return new Object[] {node, map.get("fp")};
            }
            for (Object child : map.values()) {
                Object[] found = find(child, label);
                if (found != null) {
                    return found;
                }
            }
        } else if (value instanceof List<?> list) {
            for (Object child : list) {
                Object[] found = find(child, label);
                if (found != null) {
                    return found;
                }
            }
        }
        return null;
    }

    private int hitsOf(String key) {
        AtomicInteger n = hits.get(key);
        return n == null ? 0 : n.get();
    }

    private HostedTool.Result exec(String runId, String tool, Map<String, Object> args) throws Exception {
        HostedCall call = new HostedCall(1, runId, "ag-1", tool, new LinkedHashMap<>(args), null, false, Caller.THE_OWNER, null);
        RunLedger.Run run = ledger.join(runId, "ag-1", Caller.THE_OWNER, List.of());
        HostedTool.Look look = tools.look(call, run);
        if (look.refusal() != null) {
            throw new AssertionError("refused at look: " + look.refusal());
        }
        return tools.run(call, run);
    }

    private static String ref(String text, String label) {
        Matcher m = Pattern.compile("\\[(n[0-9]+) [a-z ]+(?:[a-z_]+)?: " + Pattern.quote(label)).matcher(text);
        assertThat(m.find()).as("a ref for " + label + " in " + text).isTrue();
        return m.group(1);
    }

    @Test
    void theAgentsContextAndTheMembersKeepTheirCookiesApartAndTheRunsGoesWithIt() throws Exception {
        memberGoesTo(url("a.test", "/set?who=member"));
        assertThat(memberCookies()).containsExactly("who=member");

        // The Agent's own context has none of the member's.
        String tab = agent.open("run-1", url("a.test", "/show")).tabId();
        assertThat(text("run-1", tab)).contains("cookies: \\[\\]").doesNotContain("member");

        // What the Agent's browsing sets stays in its context: the member's cookies are as they were.
        agent.navigate("run-1", tab, url("a.test", "/set?who=agent"));
        agent.navigate("run-1", tab, url("a.test", "/show"));
        assertThat(text("run-1", tab)).contains("who=agent").doesNotContain("member");
        assertThat(memberCookies()).containsExactly("who=member");
        memberGoesTo(url("a.test", "/show"));
        assertThat(memberCookies()).containsExactly("who=member");

        // The run ends: its tab and context go, and the next run's context starts empty.
        agent.runEnded("run-1");
        await().atMost(Duration.ofSeconds(10)).until(() -> agent.agentTabs() == 0 && !jsonList().contains(tab));
        String next = agent.open("run-2", url("a.test", "/show")).tabId();
        assertThat(text("run-2", next)).contains("cookies: \\[\\]").doesNotContain("agent");
        assertThat(memberCookies()).containsExactly("who=member");
    }

    @Test
    void anAgentTabIsHiddenAndTheMembersListNeverHasIt() throws Exception {
        String member = memberTab();
        String tab = agent.open("run-1", url("a.test", "/page")).tabId();
        String session = agent.useSession("run-1", "a.test").tabId();
        List<Map<String, Object>> tabs = (List<Map<String, Object>>) rig.call(client, "browser.tab.list", Map.of(), null).get("tabs");
        assertThat(tabs).extracting(t -> t.get("tabId")).containsExactly(member);
        assertThat(tabs.get(0)).containsEntry("active", true);
        // Chromium lists a hidden target only as "other", which the member's list never takes.
        String list = jsonList();
        for (String id : List.of(tab, session)) {
            Matcher entry = Pattern.compile("\\{[^{}]*\"id\":\\s*\"" + id + "\"[^{}]*}").matcher(list);
            assertThat(entry.find()).as(id).isTrue();
            assertThat(entry.group()).contains("\"type\": \"other\"");
        }
    }

    @Test
    void theSessionTabIsTheMembersOwnAndANavigationOffItsSiteNeverReachesTheOtherSite() throws Exception {
        memberGoesTo(url("a.test", "/set?who=member"));
        String session = agent.useSession("run-1", "a.test").tabId();
        agent.navigate("run-1", session, url("a.test", "/show"));
        String text = text("run-1", session);
        assertThat(text).contains("who=member");
        HostedTool.Result read = exec("run-1", "browser_read", Map.of("tabId", session));
        assertThat(read.taints()).containsExactlyInAnyOrder("U", "S");

        // Off the site by the Agent: refused before anything goes out.
        assertThatThrownBy(() -> agent.navigate("run-1", session, url("b.test", "/direct")))
                .isInstanceOfSatisfying(RpcException.class, e -> assertThat(e.details()).containsEntry("reason", "off_site"));
        // Off the site by a redirect: the hop is failed at the request, and the call says so.
        assertThatThrownBy(() -> agent.navigate("run-1", session, url("a.test", "/away")))
                .isInstanceOfSatisfying(RpcException.class, e -> assertThat(e.details()).containsEntry("reason", "off_site"));
        assertThat(hits.get("a.test/away")).isNotNull();
        // Off the site by the page itself, as it loads.
        try {
            agent.navigate("run-1", session, url("a.test", "/jump"));
        } catch (RpcException e) {
            assertThat(e.details()).containsEntry("reason", "off_site");
        }
        Thread.sleep(1000);
        assertThat(hits.get("b.test/landed")).as("the redirect's other site").isNull();
        assertThat(hits.get("b.test/jumped")).as("the page's own navigation's other site").isNull();
        assertThat(hits.get("b.test/direct")).isNull();
        // The member's cookies are as they were: the Agent read them, and changed nothing.
        assertThat(memberCookies()).containsExactly("who=member");
        // It's closed at the run's end.
        agent.runEnded("run-1");
        await().atMost(Duration.ofSeconds(10)).until(() -> !jsonList().contains(session));
    }

    @Test
    void theWalkerReadsAndTheProxyTypesAndClicksThroughTheTools() throws Exception {
        HostedTool.Result opened = exec("run-1", "browser_open", Map.of("url", url("a.test", "/form")));
        Map<String, Object> content = (Map<String, Object>) opened.content();
        String tab = (String) content.get("tabId");
        assertThat(content).containsEntry("view", "page").containsEntry("session", "agent").containsEntry("origin", "http://a.test:" + port)
                .containsEntry("title", "Form");
        String text = (String) content.get("text");
        assertThat(text).contains("Nobody yet");
        String name = ref(text, "Name");
        String greet = ref(text, "Greet");

        HostedTool.Result typed = exec("run-1", "browser_type", Map.of("tabId", tab, "ref", name, "text", "Ada"));
        assertThat((Map<String, Object>) typed.content()).containsEntry("done", true);
        // deskd's half's own click, from deskd's world: done headless and headful alike, where trusted input isn't (S-14).
        HostedTool.Result clicked = exec("run-1", "browser_click", Map.of("tabId", tab, "ref", greet));
        assertThat((Map<String, Object>) clicked.content()).containsEntry("done", true);
        assertThat(text("run-1", tab)).contains("Hello, Ada");

        // A field that turns into a password one as it gets focus: the action proxy refuses it, and nothing is typed.
        String flip = ref(text("run-1", tab), "Code");
        assertThatThrownBy(() -> exec("run-1", "browser_type", Map.of("tabId", tab, "ref", flip, "text", "123456")))
                .isInstanceOfSatisfying(ToolFailure.class, e -> assertThat(e.reason()).isEqualTo("sensitive"));
        assertThat(text("run-1", tab)).doesNotContain("123456");
    }

    @Test
    void securityOneClicksAndKeysInTheAgentsOwnContextRiseToSendAndSpendAndASensitiveFieldIsRefused() throws Exception {
        String tab = (String) ((Map<String, Object>) exec("run-1", "browser_open", Map.of("url", url("a.test", "/links"))).content()).get("tabId");

        // A link: a read, done.
        HostedTool.Look next = look("run-1", "browser_click", Map.of("tabId", tab, "ref", ref(text("run-1", tab), "Next page")));
        assertThat(next.risk()).isNull();
        assertThat(next.refusal()).isNull();
        Map<String, Object> went = (Map<String, Object>) exec("run-1", "browser_click", next.payload()).content();
        assertThat(went).containsEntry("done", true).containsEntry("title", "Page");

        // A submit button: send.
        agent.navigate("run-1", tab, url("a.test", "/shop"));
        HostedTool.Look submit = look("run-1", "browser_click", Map.of("tabId", tab, "ref", ref(text("run-1", tab), "Send message")));
        assertThat(submit.risk()).isEqualTo(ToolRisk.SEND);
        assertThat((Map<String, Object>) approved("run-1", "browser_click", submit).content()).containsEntry("done", true)
                .containsEntry("title", "Sent");
        assertThat(hitsOf("a.test/sent")).isEqualTo(1);

        // Enter in a form field: send, by the form's own button, with what was typed.
        agent.navigate("run-1", tab, url("a.test", "/shop"));
        String message = ref(text("run-1", tab), "Message");
        exec("run-1", "browser_type", Map.of("tabId", tab, "ref", message, "text", "hi"));
        HostedTool.Look enter = look("run-1", "browser_press", Map.of("tabId", tab, "ref", message, "key", "Enter"));
        assertThat(enter.risk()).isEqualTo(ToolRisk.SEND);
        Map<String, Object> sent = (Map<String, Object>) approved("run-1", "browser_press", enter).content();
        assertThat(sent).containsEntry("done", true).containsEntry("submitted", true).containsEntry("title", "Sent");
        assertThat((String) sent.get("text")).contains("Sent: hi");
        assertThat(hitsOf("a.test/sent")).isEqualTo(2);

        // A pay button: spend, done only as the spend the member approved.
        agent.navigate("run-1", tab, url("a.test", "/shop"));
        HostedTool.Look pay = look("run-1", "browser_click", Map.of("tabId", tab, "ref", ref(text("run-1", tab), "Pay now")));
        assertThat(pay.risk()).isEqualTo(ToolRisk.SPEND);
        assertThat(pay.payload()).containsEntry("spend", true);
        Map<String, Object> unasked = new LinkedHashMap<>(pay.payload());
        unasked.remove("spend");
        assertThatThrownBy(() -> exec("run-1", "browser_click", unasked))
                .isInstanceOfSatisfying(ToolFailure.class, e -> assertThat(e.reason()).isEqualTo("changed"));
        assertThat(text("run-1", tab)).contains("Not paid");
        assertThat((Map<String, Object>) approved("run-1", "browser_click", pay).content()).containsEntry("done", true);
        assertThat(text("run-1", tab)).contains("Paid now");

        // A sensitive field: refused before asking by its label, and by deskd's half when it turns into a password one.
        String page = text("run-1", tab);
        assertThat(look("run-1", "browser_press", Map.of("tabId", tab, "ref", ref(page, "Card number"), "key", "Backspace")).refusal())
                .isEqualTo("sensitive");
        String flip = ref(page, "Code");
        assertThatThrownBy(() -> exec("run-1", "browser_press", Map.of("tabId", tab, "ref", flip, "key", "Enter")))
                .isInstanceOfSatisfying(ToolFailure.class, e -> assertThat(e.reason()).isEqualTo("sensitive"));
        assertThat(look("run-1", "browser_click", Map.of("tabId", tab, "ref", flip)).refusal()).isEqualTo("sensitive");

        // Security's third: typed quotes, backticks and a script's end land as text, never as script.
        String typed = "He said \"hi\", it's `ls` ${x} '); alert(1); // </script>";
        HostedTool.Result echo = exec("run-1", "browser_type", Map.of("tabId", tab, "ref", ref(text("run-1", tab), "Echo"), "text", typed));
        assertThat((Map<String, Object>) echo.content()).containsEntry("done", true);
        assertThat(text("run-1", tab)).contains("Echoed: " + typed);
        // And Backspace's own edit, as a key.
        exec("run-1", "browser_press", Map.of("tabId", tab, "ref", ref(text("run-1", tab), "Echo"), "key", "Backspace"));
        assertThat(text("run-1", tab)).contains("Echoed: " + typed.substring(0, typed.length() - 1)).doesNotContain(typed);
    }

    /**
     * Security (Nov 11): the type gate refuses a box the page made read-only (readonly, aria-readonly, a disabled fieldset's
     * field, and rich text inside contenteditable="false"), for typing, emptying and keys alike, so the Agent can't change
     * what a person couldn't; a box beside them still takes both.
     */
    @Test
    void securityAReadOnlyBoxTakesNoTypingAndNoKeys() throws Exception {
        String tab = (String) ((Map<String, Object>) exec("run-1", "browser_open", Map.of("url", url("a.test", "/readonly"))).content()).get("tabId");
        String page = text("run-1", tab);
        for (String label : List.of("Account", "Plan", "Terms", "Old address", "Signed", "@ann")) {
            String box = ref(page, label);
            for (Map<String, Object> args : List.of(
                    Map.<String, Object>of("tabId", tab, "ref", box, "text", "changed by the agent"),
                    Map.<String, Object>of("tabId", tab, "ref", box, "text", ""))) {
                assertThatThrownBy(() -> exec("run-1", "browser_type", args)).as("%s %s", label, args.get("text"))
                        .isInstanceOfSatisfying(ToolFailure.class, e -> assertThat(e.reason()).isIn("kind", "changed"));
            }
            assertThatThrownBy(() -> exec("run-1", "browser_press", Map.of("tabId", tab, "ref", box, "key", "Backspace"))).as(label)
                    .isInstanceOfSatisfying(ToolFailure.class, e -> assertThat(e.reason()).isIn("kind", "changed"));
        }
        String after = text("run-1", tab);
        assertThat(after).contains("Touched: none").doesNotContain("changed by the agent");
        assertThat(after).contains("A-123", "Basic", "As agreed", "1 Lamp St", "Signed", "@ann");

        HostedTool.Result echo = exec("run-1", "browser_type", Map.of("tabId", tab, "ref", ref(after, "Echo"), "text", "still types"));
        assertThat((Map<String, Object>) echo.content()).containsEntry("done", true);
        exec("run-1", "browser_press", Map.of("tabId", tab, "ref", ref(text("run-1", tab), "Echo"), "key", "Backspace"));
        assertThat(text("run-1", tab)).contains("Echoed: still type").doesNotContain("Echoed: still types").contains("Touched: none");
    }

    @Test
    void securityOneInTheMembersSessionAClickIsWriteALinkEgressAndOffTheSiteIsRefusedOrCancelled() throws Exception {
        memberGoesTo(url("a.test", "/set?who=member"));
        String session = agent.useSession("run-1", "a.test").tabId();
        agent.navigate("run-1", session, url("a.test", "/links"));

        // A plain button: write.
        HostedTool.Look more = look("run-1", "browser_click", Map.of("tabId", session, "ref", ref(text("run-1", session), "Show more")));
        assertThat(more.risk()).isEqualTo(ToolRisk.WRITE);
        assertThat(more.context()).isEqualTo("member:a.test");
        assertThat((Map<String, Object>) approved("run-1", "browser_click", more).content()).containsEntry("done", true);
        assertThat(text("run-1", session)).contains("More shown");

        // A link on the site: egress, asked before it happens, then done.
        HostedTool.Look next = look("run-1", "browser_click", Map.of("tabId", session, "ref", ref(text("run-1", session), "Next page")));
        assertThat(next.risk()).isEqualTo(ToolRisk.EGRESS);
        assertThat(next.refusal()).isNull();
        assertThat((Map<String, Object>) approved("run-1", "browser_click", next).content()).containsEntry("title", "Page");

        // A link off the site: refused before anyone is asked, and by the action proxy itself on the element.
        agent.navigate("run-1", session, url("a.test", "/links"));
        assertThat(look("run-1", "browser_click", Map.of("tabId", session, "ref", ref(text("run-1", session), "Other site"))).refusal())
                .isEqualTo("off_site");
        Object[] other = control("run-1", session, "Other site");
        assertThatThrownBy(() -> agent.act("run-1", session, (String) other[0], "click", null, (String) other[1], (String) other[2],
                (long) other[3], false)).isInstanceOfSatisfying(RpcException.class, e -> assertThat(e.details()).containsEntry("reason", "off_site"));

        // A link on the site that redirects off it, and a button whose script leaves it: cancelled at the request.
        HostedTool.Look away = look("run-1", "browser_click", Map.of("tabId", session, "ref", ref(text("run-1", session), "Away")));
        assertThat(away.risk()).isEqualTo(ToolRisk.EGRESS);
        assertThatThrownBy(() -> approved("run-1", "browser_click", away))
                .isInstanceOfSatisfying(ToolFailure.class, e -> assertThat(e.reason()).isEqualTo("off_site"));
        assertThat(hitsOf("a.test/away")).isEqualTo(1);
        agent.navigate("run-1", session, url("a.test", "/links"));
        HostedTool.Look script = look("run-1", "browser_click", Map.of("tabId", session, "ref", ref(text("run-1", session), "Leave by script")));
        assertThat(script.risk()).isEqualTo(ToolRisk.WRITE);
        assertThatThrownBy(() -> approved("run-1", "browser_click", script))
                .isInstanceOfSatisfying(ToolFailure.class, e -> assertThat(e.reason()).isEqualTo("off_site"));
        Thread.sleep(1000);
        assertThat(hitsOf("b.test/direct-link")).as("an off-site link").isZero();
        assertThat(hitsOf("b.test/landed")).as("a redirect's other site").isZero();
        assertThat(hitsOf("b.test/jsaway")).as("a script's other site").isZero();
        assertThat(memberCookies()).containsExactly("who=member");
    }

    @Test
    void securityFourAFrameOfAnotherSiteInAProcessOfItsOwnHasItsLocalRequestsRefusedToo() throws Exception {
        String tab = agent.open("run-1", url("a.test", "/page")).tabId();
        try {
            agent.navigate("run-1", tab, url("a.test", "/framed"));
        } catch (RpcException e) {
            // A local host refused during the call says so.
            assertThat(e.details()).containsEntry("reason", "blocked");
        }
        assertThat(text("run-1", tab)).contains("Framed");
        // The frames of the other site ran, the late one too, so they were let go once their requests stopped.
        await().atMost(Duration.ofSeconds(15)).until(() -> hitsOf("b.test/inner") >= 2);
        Thread.sleep(2000);
        for (String secret : List.of("127.0.0.1/secret-direct", "127.0.0.1/secret-nested", "127.0.0.1/secret-late")) {
            assertThat(hitsOf(secret)).as(secret).isZero();
        }
    }

    private String jsonList() {
        try (HttpClient http = HttpClient.newHttpClient()) {
            return http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + cdpPort + "/json/list"))
                    .timeout(Duration.ofSeconds(2)).build(), HttpResponse.BodyHandlers.ofString()).body();
        } catch (IOException e) {
            return "";
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return "";
        }
    }

    private boolean debuggingPortAnswers() {
        try (HttpClient http = HttpClient.newHttpClient()) {
            return http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + cdpPort + "/json/version"))
                    .timeout(Duration.ofSeconds(2)).build(), HttpResponse.BodyHandlers.discarding()).statusCode() == 200;
        } catch (IOException e) {
            return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private static int freePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }
}
