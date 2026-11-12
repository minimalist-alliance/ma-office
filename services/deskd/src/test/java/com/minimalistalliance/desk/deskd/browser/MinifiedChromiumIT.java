package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.browser.minified.MinifiedModule;
import com.minimalistalliance.desk.deskd.browser.minified.MinifiedSwitch;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import com.sun.net.httpserver.HttpServer;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;
import java.util.stream.IntStream;
import java.util.stream.Stream;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

/**
 * The simplified view (task 47, Stage A) against a real Chromium, headless, on pages from a local server. It proves what
 * a fake can't: that deskd's half runs in its own world, that every frame's guard holds against Security's hostile
 * pages (T47-1, T47-2, T47-3, T47-5), and what Chromium really answers. {@code a.test}, {@code b.test},
 * {@code js.stripe.com} and {@code www.chase.com} all resolve to the local server, so a.test and b.test are two sites,
 * and a frame from one in a page of the other runs in a process of its own.
 *
 * <pre>DESKD_CHROMIUM_BIN=/path/to/chrome ./mvnw -q -pl deskd verify -Dtest=none -Dsurefire.failIfNoSpecifiedTests=false -Dit.test=MinifiedChromiumIT</pre>
 */
@EnabledIfEnvironmentVariable(named = "DESKD_CHROMIUM_BIN", matches = ".+")
class MinifiedChromiumIT {

    private static final String PROSE = "The lamp has lit the reading rooms of the world for a long time, and it is still the best way to "
            + "read at night without waking anyone else in the house. ";

    @TempDir
    Path dir;

    private int port;
    private int cdpPort;
    private Process chromium;
    private HttpServer pages;
    private final Map<String, AtomicInteger> hits = new ConcurrentHashMap<>();
    private byte[] png;
    private BrowserRig rig;
    private TestClient client;

    @BeforeEach
    void setUp() throws Exception {
        png = png();
        pages = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        port = pages.getAddress().getPort();
        pages.createContext("/", exchange -> {
            String path = exchange.getRequestURI().getPath();
            String query = exchange.getRequestURI().getRawQuery();
            hits.computeIfAbsent(path + (query == null ? "" : "?" + query), k -> new AtomicInteger()).incrementAndGet();
            byte[] body;
            String type = "text/html; charset=utf-8";
            if (path.equals("/pic.png") || path.equals("/lazy.png")) {
                body = png;
                type = "image/png";
                exchange.getResponseHeaders().set("Cache-Control", "max-age=3600");
            } else {
                body = html(path).getBytes(StandardCharsets.UTF_8);
            }
            exchange.getResponseHeaders().set("Content-Type", type);
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        pages.start();
        cdpPort = freePort();
        startChromium();
        await().atMost(Duration.ofSeconds(30)).until(this::debuggingPortAnswers);
        rig = new BrowserRig(dir, cdpPort, BrowserRig.timing(Duration.ofMillis(250), Duration.ofMinutes(5)));
        rig.module.enableMinified(dir, Clock.systemUTC(), new MinifiedModule.Timing(
                Duration.ofSeconds(10), Duration.ofSeconds(8), Duration.ofSeconds(20), Duration.ofMillis(24), Duration.ofMillis(100),
                Duration.ofSeconds(30)), MinifiedSwitch.fixed(true, false, false));
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

    private String html(String path) {
        String b = "http://b.test:" + port;
        if (path.startsWith("/sec/") && path.matches("/sec/[a-z-]+\\.html")) {
            // The distiller's own security pages (T47X), as services/scripts/sync-distiller.sh copied them.
            try (java.io.InputStream page = getClass().getResourceAsStream("/minified/security/" + path.substring(5))) {
                return page == null ? "<title>missing</title>" : new String(page.readAllBytes(), StandardCharsets.UTF_8);
            } catch (IOException e) {
                return "<title>unreadable</title>";
            }
        }
        if (path.startsWith("/lazy") || path.equals("/feed")) {
            return prescrollPage(path);
        }
        if (path.startsWith("/r3/")) {
            return roundThree(path);
        }
        if (path.startsWith("/r4/") || path.startsWith("/t/")) {
            return roundFour(path);
        }
        if (path.startsWith("/r5/")) {
            return roundFive(path);
        }
        if (path.startsWith("/r6/")) {
            return roundSix(path);
        }
        return switch (path) {
            // The sign-ins work's finding (Nov 11): the fixture extension puts its own page over this one in a frame.
            case "/vault" -> "<title>vault</title><main><h1>The lamp shop</h1><p>" + PROSE.repeat(3) + "</p>"
                    + "<button id=more onclick=\"fetch('/hit?more')\">Read more</button><p>" + PROSE.repeat(3) + "</p></main>";
            // A frame of the page's own that starts as about:blank and is then sent to another site's page.
            case "/blank-frame" -> "<title>blank frame</title><main><h1>The lamp shop</h1><p>" + PROSE.repeat(3) + "</p>"
                    + "<button id=more onclick=\"fetch('/hit?more')\">Read more</button><p>" + PROSE.repeat(3) + "</p>"
                    + "<iframe id=f style=\"width:300px;height:80px;border:0;margin-top:300px\"></iframe></main>"
                    + "<script>addEventListener('message', (e) => { if (e.data === 'go') document.getElementById('f').src = '" + b + "/allow'; });</script>";
            case "/article" -> "<title>Article</title><main><h1>Lamps of the world</h1><p>" + PROSE.repeat(4) + "</p><p>"
                    + PROSE.repeat(3) + "</p><p>Read <a href=\"/next\">the next page</a> now.</p>"
                    + "<img src=\"/pic.png\" width=\"300\" height=\"200\" alt=\"A brass lamp\"><p>" + PROSE.repeat(3) + "</p></main>";
            case "/next" -> "<title>Next</title><p>" + PROSE + "</p>";
            // T47-3, as Security reproduced it: another site's frame, moved over the button and away every 10 ms.
            case "/slide" -> "<title>slide</title><p>" + PROSE + "</p>"
                    + "<button id=more style=\"position:absolute;left:100px;top:200px;width:160px;height:40px\""
                    + " onclick=\"fetch('/hit?more')\">Read more</button>"
                    + "<iframe id=f src=\"" + b + "/allow\" style=\"position:absolute;left:600px;top:500px;width:200px;height:60px;border:0\"></iframe>"
                    + "<script>const f = document.getElementById('f'); let over = false;"
                    + "setInterval(() => { over = !over; f.style.left = over ? '90px' : '600px'; f.style.top = over ? '190px' : '500px'; }, 10);"
                    + "</script>";
            case "/allow" -> "<title>allow</title><body style=\"margin:0\"><button style=\"width:200px;height:60px\""
                    + " onclick=\"fetch('/hit?allow')\">Allow</button></body>";
            // T47-2: a row whose node is reused for another item.
            case "/mail" -> "<title>mail</title><p>" + PROSE + "</p><ul>"
                    + "<li><span class=s>Mail A from Ann about lunch</span> <button onclick=\"archive(this)\">Archive</button></li>"
                    + "<li><span class=s>Mail C from Cy about the trip</span> <button onclick=\"archive(this)\">Archive</button></li></ul>"
                    + "<script>function archive(b) { fetch('/hit?archive-' + encodeURIComponent(b.parentElement.querySelector('.s').textContent)); }"
                    + "window.swap = () => { document.querySelector('.s').textContent = 'Mail B from Bob about money'; return 1; };</script>";
            // T47-1: password, code, card and masked fields, and a payment provider's frame.
            case "/signin" -> "<title>signin</title><main><h1>Sign in</h1><p>" + PROSE + "</p>"
                    + "<label>Name <input id=name></label>"
                    + "<label>Password <input type=password id=pw value=\"hunter2\"></label>"
                    + "<label>Code <input id=otp autocomplete=\"one-time-code\" value=\"123456\"></label>"
                    + "<label>Card <input id=cc autocomplete=\"cc-number\" value=\"4111111111111111\"></label>"
                    + "<label>PIN <input id=pin style=\"-webkit-text-security:disc\" value=\"9876\"></label>"
                    + "<label>Expiry <select autocomplete=\"cc-exp-month\" name=m><option>01</option><option>07</option></select></label>"
                    + "<label>Flip <input id=flip onfocus=\"this.type='password'\"></label>"
                    + "<iframe src=\"http://js.stripe.com:" + port + "/card\" width=\"400\" height=\"100\"></iframe></main>";
            // The same fields without a password, card number or payment frame, which make the page a challenge.
            case "/signin-box" -> "<title>signin box</title><main><h1>Your details</h1><p>" + PROSE.repeat(5) + "</p>"
                    + "<label>Name <input id=name></label>"
                    + "<label>Code <input id=otp autocomplete=\"one-time-code\" value=\"123456\"></label>"
                    + "<label>PIN <input id=pin style=\"-webkit-text-security:disc\" value=\"9876\"></label>"
                    + "<label>Expiry <select autocomplete=\"cc-exp-month\" name=m><option>01</option><option>07</option></select></label>"
                    + "<label>Flip <input id=flip onfocus=\"this.type='password'\"></label></main>";
            case "/card" -> "<title>card</title><input autocomplete=cc-number>";
            // T47-2, review 3: a list of divs, virtualized: scrolling to a row rebinds it to another mail.
            case "/virtual" -> "<title>virtual</title><p>" + PROSE + "</p><div id=list>"
                    + java.util.stream.IntStream.range(0, 120).mapToObj(i -> "<div class=row><span class=s>Mail " + i + " about item " + i
                            + "</span> <button onclick=\"archive(this)\">Archive</button></div>").collect(java.util.stream.Collectors.joining())
                    + "</div><script>function archive(b) { fetch('/hit?archive-' + encodeURIComponent(b.parentElement.querySelector('.s').textContent)); }"
                    + "const rebind = () => { document.querySelectorAll('.s')[100].textContent = 'Mail B from Bob about money'; };"
                    + "addEventListener('scroll', rebind, {once: true}); document.addEventListener('pointerdown', rebind, {capture: true, once: true});"
                    + "</script>";
            case "/form" -> "<title>form</title><p>" + PROSE.repeat(5) + "</p><label>Search <input id=i oninput=\"document.title='typed:'+this.value\"></label>";
            case "/video" -> "<title>video</title><p>" + PROSE + "</p><video id=v width=\"640\" height=\"360\" poster=\"/pic.png\""
                    + " style=\"background:#000\"></video><p>" + PROSE + "</p>";
            case "/canvas" -> "<title>canvas</title><style>body{margin:0}</style><canvas width=\"1280\" height=\"800\""
                    + " style=\"width:100vw;height:100vh;display:block\"></canvas>";
            case "/grows" -> "<title>grows</title><p>" + PROSE + "</p><p id=last>first</p>"
                    + "<script>window.grow = () => { const p = document.createElement('p'); p.textContent = 'A brand new paragraph arrived'; document.body.append(p); return 1; };</script>";
            // T47D-1, as the Security Analyst reproduced it: as deskd scrolls the button in, the page busies a frame of its
            // own (d.test), so deskd's look at the frames waits on it, and puts a frame from the victim site (c.test) over
            // the button meanwhile.
            case "/lastframe" -> "<title>lastframe</title><p>" + PROSE + "</p><div style=\"height:1400px\"></div>"
                    + "<button id=more style=\"width:200px;height:60px\" onclick=\"fetch('/hit?more')\">Read more</button>"
                    + "<div style=\"height:1400px\"></div>"
                    + "<iframe id=d src=\"http://d.test:" + port + "/stall\" style=\"width:120px;height:60px;border:0\"></iframe>"
                    + "<script>let sprung = false; addEventListener('scroll', () => { if (sprung) return; sprung = true;"
                    + " document.getElementById('d').contentWindow.postMessage('busy', '*');"
                    + " setTimeout(() => { const b = document.getElementById('more').getBoundingClientRect();"
                    + " const v = document.createElement('iframe'); v.src = 'http://c.test:" + port + "/victim';"
                    + " v.style.cssText = 'position:absolute;border:0;width:200px;height:60px;left:' + (b.left + scrollX) + 'px;top:' + (b.top + scrollY) + 'px';"
                    + " document.body.append(v); }, 5); });</script>";
            // T47D-2: another site's frame in a closed shadow root, right beside the button's press point, which no walk of
            // the page's DOM can see.
            case "/closedframe" -> "<title>closedframe</title><p>" + PROSE + "</p>"
                    + "<button id=go style=\"position:absolute;left:100px;top:300px;width:120px;height:40px\" onclick=\"fetch('/hit?closed')\">Go on</button>"
                    + "<div id=host style=\"position:absolute;left:150px;top:300px\"></div>"
                    + "<script>const r = document.getElementById('host').attachShadow({mode: 'closed'});"
                    + " r.innerHTML = '<iframe src=\"" + b + "/allow\" style=\"width:100px;height:40px;border:0\"></iframe>';</script>";
            // A terms wall drawn by another site's frame, as BBC's comes from its CMP: the page under it is never the view.
            case "/termsframe" -> "<title>termsframe</title><main><h1>Lamps under a wall</h1><p>" + PROSE.repeat(6) + "</p></main>"
                    + "<div style=\"position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2147483647\">"
                    + "<iframe src=\"" + b + "/termsbox\" style=\"position:absolute;left:340px;top:150px;width:600px;height:420px;border:0;background:#fff\"></iframe></div>"
                    + "<style>html,body{overflow:hidden}</style>";
            case "/termsbox" -> "<title>terms</title><body style=\"margin:20px\"><h2>Terms of Use &amp; Privacy</h2><p>By clicking Accept and"
                    + " Continue, you confirm you agree to the Terms of Use and the collection and use of your information, as described"
                    + " in our Privacy Policy.</p><button>Accept and Continue</button></body>";
            // An encyclopedia's opening (P01, P20): an infobox and a thumbnail floated beside the lead come first in the
            // page's order.
            case "/infobox" -> "<title>infobox</title><main><h1>Brass lamps</h1>"
                    + "<table style=\"float:right;width:300px\"><tr><th>Made</th><td>Since 1900</td></tr><tr><th>Metal</th><td>Brass</td></tr></table>"
                    + "<figure style=\"float:right;width:240px;margin:0\"><img src=\"/pic.png\" width=220 height=160 alt=\"A lamp\">"
                    + "<figcaption>A lamp on a desk in the reading room.</figcaption></figure>"
                    + "<p>The brass lamp opens the lead. " + PROSE + "</p><p>" + PROSE + "</p><h2>History</h2><p>" + PROSE + "</p>"
                    + "<figure style=\"float:right;width:240px;margin:0\"><img src=\"/pic.png\" width=220 height=160 alt=\"Later\">"
                    + "<figcaption>A later lamp, beside the history.</figcaption></figure><p>The history goes on. " + PROSE + "</p></main>";
            // A shop's filter rail known only by its shape (Best Buy, Target): no filter, facet or refine in its names.
            case "/rail" -> "<title>rail</title><body style=\"margin:0\"><div style=\"display:flex\">"
                    + "<div style=\"width:240px;min-height:900px\">" + "<button aria-expanded=false>Category</button><button aria-expanded=false>Brand</button>"
                    + "<label><input type=checkbox> Pickup today</label><label><input type=checkbox> Ships today</label>"
                    + "<label><input type=checkbox> On sale</label></div>"
                    + "<div style=\"width:900px\"><h1>Desk lamps</h1>" + ("<div style=\"width:260px;display:inline-block;height:240px\">"
                    + "<a href=\"/p\">Rating 4.5 out of 5 stars with 12 reviews</a><img src=\"/pic.png\" width=200 height=120 alt=\"\">"
                    + "<a href=\"/p\">The brass reading lamp, small</a><span>$49.99</span></div>").repeat(6) + "</div></div></body>";
            // A story's opening in a box of its own, and a hidden consent modal holding more paragraphs than the story
            // (Ars Technica, T03), with a small promo player far down the page.
            case "/chunks" -> "<title>chunks</title><main><article><h1>The lamp makers</h1><div class=\"post-content\"><p>The opening of the story. "
                    + PROSE + "</p></div><figure><img src=\"/pic.png\" width=600 height=300 alt=\"\"></figure><div class=\"post-content\"><p>"
                    + PROSE + "</p><p>" + PROSE + "</p><p>" + PROSE + "</p><p>" + PROSE + "</p><p>" + PROSE + "</p><p>" + PROSE + "</p></div></article></main>"
                    + "<div style=\"height:3000px\"></div><video src=\"/none.mp4\" width=320 height=180 controls></video>"
                    + "<div id=modal style=\"display:none\">" + ("<p>" + PROSE + "</p>").repeat(6) + "</div>";
            // A consent manager's banner in the page's own flow (GOV.UK, P29), and a search engine's shopping ads whose
            // links carry an ad network's click id, with the ad module's own switch left behind (Yahoo T12, Google P30).
            case "/inflow" -> "<title>inflow</title><div class=\"app-cookie-banner\" role=region><p>We use some essential cookies to make"
                    + " this service work. We would also like to use analytics cookies.</p><button>Accept additional cookies</button>"
                    + "<button>Reject additional cookies</button></div><main><h1>Check the lamp rules</h1><p>" + PROSE + "</p>"
                    + "<p><button>Hide sponsored results</button></p><div style=\"display:flex\">"
                    + ("<div style=\"width:200px;height:200px\"><a href=\"/shop?x=1&msclkid=abc\"><img src=\"/pic.png\" width=180 height=120 alt=\"\">"
                    + "Brass desk lamp from a shop</a> $35.99</div>").repeat(4) + "</div><p>" + PROSE + "</p></main>";
            // A front page's kicker run into its headline, set apart on its right only (the Guardian, T01).
            case "/kicker" -> "<title>kicker</title><main><h1>Front page</h1><h3><a href=\"/story\"><span style=\"color:#c70000;margin-right:6px\">"
                    + "Politics sketch</span><span>The lamp makers win the vote</span></a></h3><p>" + PROSE + PROSE + "</p></main>";
            // A site's hidden copy of its own title, beside the shown one, as The Verge has (P06).
            case "/twotitles" -> "<title>two titles</title><header><h1 style=\"display:none\">The lamp makers of the northern valley</h1></header>"
                    + "<main><h1>The lamp makers of the northern valley</h1><p>" + PROSE.repeat(4) + "</p>"
                    + "<p style=\"display:none\">A paragraph the page never shows, long enough to count.</p></main>";
            // T47N-1, as the Security Analyst described it: no new frame this time. A c.test frame already on the page, armed
            // with the rest, is sent to a new c.test page and moved under the button while deskd's re-read waits on d.test.
            case "/navframe" -> "<title>navframe</title><p>" + PROSE + "</p><div style=\"height:1400px\"></div>"
                    + "<button id=more style=\"width:200px;height:60px\" onclick=\"fetch('/hit?more')\">Read more</button>"
                    + "<div style=\"height:1400px\"></div>"
                    + "<iframe id=d src=\"http://d.test:" + port + "/stall\" style=\"width:120px;height:60px;border:0\"></iframe>"
                    + "<iframe id=v src=\"http://c.test:" + port + "/plainframe\" style=\"position:absolute;left:900px;top:20px;width:200px;height:60px;border:0\"></iframe>"
                    + "<script>let sent = false; addEventListener('scroll', () => { if (sent) return; sent = true;"
                    + " document.getElementById('d').contentWindow.postMessage('busy', '*');"
                    + " setTimeout(() => { const b = document.getElementById('more').getBoundingClientRect(); const v = document.getElementById('v');"
                    + " v.src = 'http://c.test:" + port + "/victim';"
                    + " v.style.left = (b.left + scrollX) + 'px'; v.style.top = (b.top + scrollY) + 'px'; }, 5); });</script>";
            case "/plainframe" -> "<title>plain</title><body style=\"margin:0\"><p>A frame of c.test.</p></body>";
            case "/stall" -> "<title>stall</title><script>addEventListener('message', (e) => { if (e.data === 'busy') {"
                    + " const t = Date.now(); while (Date.now() - t < 2500) {} } });</script><p>busy</p>";
            case "/victim" -> "<title>victim</title><body style=\"margin:0\"><button style=\"width:200px;height:60px\""
                    + " onclick=\"fetch('/hit?victim')\">Allow</button></body>";
            // The consent press, and Security's conditions (Ask 1, T47X-1): what may be pressed, and what never.
            case "/cookies" -> consentPage("We and our partners use cookies to measure this site.", "bottom:0;left:0;right:0;height:120px",
                    "<button onclick=\"fetch('/hit?accept')\">Accept all</button>"
                    + "<button onclick=\"fetch('/hit?reject-' + event.isTrusted)\">Reject all</button>");
            case "/oauth" -> consentPage("Example App wants to access your account and your contacts.", "top:150px;left:400px;width:400px;height:200px",
                    "<button onclick=\"fetch('/hit?allow')\">Allow</button><button onclick=\"fetch('/hit?deny')\">Deny</button>");
            case "/bigcookies" -> consentPage("We use cookies, with our vendors, for tracking.", "inset:0",
                    "<button onclick=\"fetch('/hit?accept')\">Accept all</button><button onclick=\"fetch('/hit?bigreject')\">Reject all</button>");
            case "/offcookies" -> consentPage("We and our partners use cookies to measure this site.", "bottom:0;left:0;right:0;height:120px",
                    "<button onclick=\"fetch('/hit?accept')\">Accept all</button><a href=\"http://b.test:" + port + "/elsewhere\">Reject all</a>");
            // T47X-1: a box that says only "consent" and "privacy policy", even with a cookie banner's class, isn't one.
            case "/consentword" -> "<title>consent</title><main><h1>An article</h1><p>" + PROSE.repeat(5) + "</p></main>"
                    + "<div class=\"cookie-banner\" style=\"position:fixed;bottom:0;left:0;right:0;height:140px;background:#fff;z-index:9999\">"
                    + "<p>Example App asks for your consent to read your profile. See our privacy policy.</p>"
                    + "<button onclick=\"fetch('/hit?accept')\">Accept</button><button onclick=\"fetch('/hit?consentdeny')\">Deny</button></div>";
            case "/noaccept" -> consentPage("We and our partners use cookies to measure this site.", "bottom:0;left:0;right:0;height:120px",
                    "<button onclick=\"fetch('/hit?lonereject')\">Reject all</button>");
            // Security's Ask 2, cross-origin frames: another site's player frame, with a big and a small video in it.
            case "/framevideo" -> "<title>framevideo</title><main><h1>A talk</h1><p>" + PROSE.repeat(4) + "</p>"
                    + "<iframe src=\"http://b.test:" + port + "/player/embed\" width=\"640\" height=\"360\" style=\"border:0\"></iframe>"
                    + "<p>" + PROSE + "</p></main>";
            case "/player/embed" -> "<title>player</title><body style=\"margin:0\">"
                    + "<video id=big width=\"480\" height=\"270\" style=\"background:#000\"></video>"
                    + "<video id=small width=\"160\" height=\"90\" style=\"background:#000\"></video>"
                    + "<script>for (const t of ['pointerdown', 'mousedown', 'keydown', 'click']) addEventListener(t, () => fetch('/hit?frame-input'), true);"
                    + "const big = document.getElementById('big'), small = document.getElementById('small');"
                    + "for (const v of [big, small]) v.addEventListener('volumechange', () => fetch('/hit?vol-' + big.volume + '-' + small.volume"
                    + " + '-' + navigator.userActivation.hasBeenActive));</script></body>";
            // T47X-2: a site's own alert and account notice stay, whatever the distiller does with them.
            case "/notice" -> "<title>notice</title><main><h1>Your account</h1><p>" + PROSE.repeat(5) + "</p></main>"
                    + "<div role=alert style=\"position:fixed;top:0;left:0;right:0;height:50px;background:#fee;z-index:999\">"
                    + "Your session expires in 2 minutes. <button onclick=\"fetch('/hit?stay')\">Stay signed in</button></div>"
                    + "<div class=\"promo-banner\" style=\"position:fixed;bottom:0;left:0;right:0;height:60px;background:#eef;z-index:999\">"
                    + "Unusual sign-in activity on your account. <a href=\"/review\">Review it</a></div>";
            // The policy: never more than the real page shows this member.
            case "/paywall" -> "<title>paywall</title><main><h1>Lamps behind a wall</h1><p>" + PROSE + "</p>"
                    + "<p>The lamp the member can read before the wall comes, in a paragraph long enough to key.</p>"
                    + "<p style=\"display:none\">A hidden paragraph the member never sees on the real page at all.</p>"
                    + "<div style=\"max-height:20px;overflow:hidden\"><p>Shown line</p><p>A clipped paragraph the box cuts away from the member's sight.</p></div>"
                    + "<div style=\"height:900px\"></div><p>The paragraph under the wall, which only subscribers read here.</p>"
                    + "<p>And the one after it, past the wall too, which nobody here should see.</p></main>"
                    + "<style>html{overflow:hidden}</style><div style=\"position:fixed;left:0;right:0;top:50%;bottom:0;background:#fff;z-index:99\">"
                    + "<p>Subscribe to keep reading</p><button>Subscribe</button></div>";
            // A subscribe box the member can close is a nag, never a wall (AP's front page, P32).
            case "/nag" -> "<title>nag</title><main><h1>Lamps under a nag</h1><p>" + PROSE + "</p><div style=\"height:900px\"></div>"
                    + "<p>The paragraph further down, which the member reads once the box is closed.</p></main>"
                    + "<div style=\"position:fixed;inset:0;background:rgba(255,255,255,.95);z-index:99\"><p>Subscribe to our newsletter</p>"
                    + "<button>Subscribe</button><button aria-label=\"Close\">×</button></div>";
            // AP's donation banner, word for word in kind: "This is not a paywall", and a way to collapse it.
            case "/donate" -> "<title>donate</title><main><h1>Lamps and donations</h1><p>" + PROSE + "</p><div style=\"height:900px\"></div>"
                    + "<p>The paragraph further down, which the member reads under the banner.</p></main>"
                    + "<div style=\"position:fixed;left:0;right:0;bottom:0;top:10%;background:#fff;z-index:99\"><p>This is not a paywall."
                    + " Your donation today keeps the reporting free.</p><a href=\"/give\">Donate Now</a>"
                    + "<button aria-label=\"Collapse donation banner\"></button></div>";
            case "/terms" -> "<title>terms</title><main><h1>Terms first</h1><p>" + PROSE + "</p></main>"
                    + "<style>html{overflow:hidden}</style><div style=\"position:fixed;inset:0;background:#fffe;z-index:99\">"
                    + "<p>We have updated our Terms of Use. Please agree to continue.</p><button>I agree</button></div>";
            case "/videowall" -> "<title>videowall</title><p>" + PROSE + "</p><div style=\"position:relative;width:640px\">"
                    + "<video id=v width=\"640\" height=\"360\" style=\"background:#000\"></video>"
                    + "<div style=\"position:absolute;left:20px;top:20px;width:260px;height:140px;background:#fff\">Sign in to watch</div></div>";
            case "/confirm" -> "<title>confirm</title><p>" + PROSE + "</p><button onclick=\"confirm('Delete everything?')\">Delete</button>";
            // Person checks the distiller lets through, as a desk on AWS's network meets them. Stack Overflow's own page:
            // its title and heading, a form to its /nocaptcha, the check's frame in a closed shadow root, the site's footer.
            case "/so-check" -> "<title>Human verification - Stack Overflow</title><header><a href=/>Stack Overflow</a> <a href=/q>Questions</a></header>"
                    + "<main><h1>Human verification</h1><p>Stack Overflow needs to make sure this is you before you go on.</p>"
                    + "<form action=\"/nocaptcha?s=7f3\" method=post><div id=box style=\"width:300px;height:65px\"></div>"
                    + "<button>Continue</button></form></main>" + footer()
                    + "<script>document.getElementById('box').attachShadow({mode: 'closed'}).innerHTML ="
                    + " '<iframe src=\"" + b + "/turnstile/widget\" style=\"width:300px;height:65px;border:0\"></iframe>';</script>";
            // Cloudflare's newer interstitial: no "Just a moment" title, no challenge form yet, its options inline.
            case "/cf-check" -> "<title>a.test</title><main><h1>a.test</h1><h2 id=challenge-body-text>Performing security verification</h2>"
                    + "<p>This website uses a security service to protect against malicious bots. This page is displayed while the"
                    + " website verifies you are not a bot.</p><div id=w style=\"width:300px;height:65px\"></div></main>"
                    + "<script>window._cf_chl_opt = {cZone: 'a.test', cType: 'managed'};"
                    + " document.getElementById('w').attachShadow({mode: 'closed'}).innerHTML ="
                    + " '<iframe src=\"" + b + "/turnstile/widget\" style=\"width:300px;height:65px;border:0\"></iframe>';</script>";
            // A page whose only content is a check's prompt, with nothing else to know it by.
            case "/prompt-check" -> "<title>Welcome</title><main><p>Verifying you are human. This may take a few seconds.</p></main>";
            // A check's box on an otherwise plain page, its frame in a closed shadow root where the distiller can't see it.
            case "/widget-check" -> "<title>Welcome</title><main><p>One moment while we look at your browser.</p>"
                    + "<div class=h-captcha id=w style=\"width:303px;height:78px\"></div></main>"
                    + "<script>document.getElementById('w').attachShadow({mode: 'closed'}).innerHTML ="
                    + " '<iframe src=\"" + b + "/turnstile/widget\" style=\"width:303px;height:78px;border:0\"></iframe>';</script>";
            case "/turnstile/widget" -> "<title>widget</title><body style=\"margin:0\"><label><input type=checkbox> Confirm</label></body>";
            // A real page about checks is still simplified. Its paragraphs differ, as the distiller keeps one of a repeated
            // paragraph, and there are enough of them that the distiller's own check, under 2500 characters, doesn't apply.
            case "/captcha-article" -> "<title>Are you a robot? How CAPTCHA works</title><main><h1>Human verification, explained</h1>"
                    + java.util.stream.IntStream.rangeClosed(1, 6).mapToObj(i -> "<p>Part " + i + ". " + PROSE.repeat(3) + "</p>")
                            .collect(java.util.stream.Collectors.joining()) + "</main>";
            default -> "<title>bank</title><p>" + PROSE + "</p>";
        };
    }

    /**
     * Round 3's pre-scroll: a thread whose replies load only as they're scrolled to and a lazy picture far down, with
     * what the page counts of presses, keys and focus, which must stay at none, and of its own scrolling; the page starts
     * at 137 px. {@code /lazy-focus} has a field with focus, {@code /lazy-code} a one-time code field, and {@code /feed}
     * grows by two screens whenever its end is in view.
     */
    private String prescrollPage(String path) {
        String count = "<script>window.__pressed = 0; window.__scrolls = 0; window.__marked = 0;"
                + " for (const t of ['click', 'mousedown', 'mouseup', 'pointerdown', 'keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'focusin'])"
                + " addEventListener(t, () => window.__pressed++, true); addEventListener('scroll', () => window.__scrolls++, true);</script>";
        if (path.equals("/feed")) {
            return "<title>feed</title>" + count + "<main><h1>Every lamp, newest first</h1>"
                    + "<button id=mark onclick=\"window.__marked++\">Mark all read</button><section id=feed></section><div id=end style=\"height:10px\"></div></main>"
                    + "<script>let n = 0; const add = (k) => { for (let i = 0; i < k; i++) { const a = document.createElement('article');"
                    + " a.innerHTML = '<h2>Lamp ' + (++n) + '</h2><p>" + PROSE + "</p>'; document.getElementById('feed').append(a); } };"
                    + " add(30); new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) add(12); }).observe(document.getElementById('end'));</script>";
        }
        StringBuilder page = new StringBuilder("<title>lazy</title>").append(count).append("<main><h1>The lamp makers' thread</h1>");
        if (path.equals("/lazy-focus")) {
            page.append("<label>Reply <input id=reply autofocus></label>");
        }
        if (path.equals("/lazy-code")) {
            page.append("<label>Code <input id=otp autocomplete=\"one-time-code\"></label>");
        }
        if (path.equals("/lazy-shadow")) {
            // A component the code field is drawn in later, in its open shadow root (the test adds it). Its size is fixed, so
            // drawing it moves nothing: no scroll anchoring, so the page's only scroll is its own.
            page.append("<div id=host style=\"height:40px;overflow:hidden\"></div>");
        }
        for (int i = 0; i < 80; i++) {
            page.append("<p>").append(PROSE.repeat(3)).append("</p>");
        }
        page.append("<img loading=lazy src=\"/lazy.png\" width=\"300\" height=\"200\" alt=\"A lamp far down the thread\">")
                .append("<section id=replies></section><div id=more style=\"height:20px\"></div></main>")
                .append("<script>new IntersectionObserver((es) => { const r = document.getElementById('replies');")
                .append(" if (!es.some((e) => e.isIntersecting) || r.childElementCount) return;")
                .append(" for (let i = 1; i <= 3; i++) { const a = document.createElement('article');")
                .append(" a.innerHTML = '<p>A reply that loads as you scroll, number ' + i + '. ").append(PROSE).append("</p>'; r.append(a); }")
                .append(" }).observe(document.getElementById('more'));");
        if (!path.equals("/lazy-focus")) {
            page.append(" addEventListener('load', () => scrollTo(0, 137));");
        }
        return page.append("</script>").toString();
    }

    /** Round 3's distiller rules, each its page's shape. */
    private String roundThree(String path) {
        String prose = "<p>" + PROSE.repeat(3) + "</p>";
        return switch (path) {
            // Wikipedia's Appearance panel (text size, width, colour) in a narrow column, and a shop's size picker
            case "/r3/appearance" -> "<title>appearance</title><div style=\"display:flex\"><main style=\"width:900px\"><h1>Lamps of the world</h1>"
                    + prose.repeat(4) + "<fieldset><legend>Size</legend>"
                    + radios("size", "Small", "Medium", "Large") + "</fieldset>" + prose + "</main>"
                    + "<div id=vector-appearance class=vector-appearance style=\"width:200px\"><h2>Appearance</h2>"
                    + "<p>Text</p>" + radios("font", "Small", "Standard", "Large") + "<p>Width</p>" + radios("width", "Standard", "Wide")
                    + "<p>Color (beta)</p>" + radios("color", "Automatic", "Light", "Dark") + "</div></div>";
            // a store's grid whose promo tile holds the page's only h1
            case "/r3/grid" -> {
                StringBuilder page = new StringBuilder("<title>grid</title><p>48 results for lamps</p>"
                        + "<div style=\"display:grid;grid-template-columns:repeat(4,260px);gap:12px\">");
                for (int i = 1; i <= 9; i++) {
                    if (i == 3) {
                        page.append("<div class=tile><h1>Holiday lights from $1</h1><a href=\"/sale\"><img src=\"/pic.png\" width=200 height=150 alt=\"Lights\"></a></div>");
                    }
                    page.append("<div class=tile><a href=\"/p/").append(i).append("\"><img src=\"/pic.png\" width=200 height=150 alt=\"\"></a>")
                            .append("<a href=\"/p/").append(i).append("\">Brass desk lamp number ").append(i).append("</a><span>$").append(20 + i).append(".99</span></div>");
                }
                yield page.append("</div>").toString();
            }
            // an engine's shopping ads behind its own redirect, their click ids URL-encoded, among its results
            case "/r3/engine" -> {
                StringBuilder page = new StringBuilder("<title>engine</title><main><h1>desk lamp reviews</h1><ol>");
                for (int i = 1; i <= 3; i++) {
                    page.append("<li><a href=\"http://r.a.test:").append(port).append("/RU=http%3a%2f%2fshop.b.test%2flamp").append(i)
                            .append("%3ftag%3dx%26hvadid%3d8012").append(i).append("/RK=2\"><img src=\"/pic.png\" width=120 height=90 alt=\"\">Shopping ad lamp ")
                            .append(i).append("</a> <span>$1").append(i).append(".99</span></li>");
                }
                for (int i = 1; i <= 5; i++) {
                    page.append("<li><h3><a href=\"http://b.test:").append(port).append("/review").append(i).append("\">The best desk lamps, review ")
                            .append(i).append("</a></h3><p>").append(PROSE).append("</p></li>");
                }
                yield page.append("</ol></main>").toString();
            }
            // a docs page's definitions: a signature, then what it says
            case "/r3/defs" -> "<title>defs</title><main><h1>datetime</h1>" + prose + "<dl class=\"py class\"><dt id=x>class datetime.timedelta(days=0)</dt>"
                    + "<dd><p>All arguments are optional and default to 0.</p><p>Only days, seconds and microseconds are stored.</p></dd></dl>" + prose + "</main>";
            // a column of the page's own section links with their Toggle buttons, and a header nav with a CSS filter class
            case "/r3/toc" -> {
                StringBuilder toc = new StringBuilder("<div style=\"width:200px;min-height:600px\"><p>Contents</p>");
                StringBuilder body = new StringBuilder();
                for (int i = 1; i <= 5; i++) {
                    toc.append("<div><a href=\"#s").append(i).append("\">Section ").append(i).append("</a> <button aria-expanded=\"true\">Toggle section ")
                            .append(i).append(" subsection</button></div>");
                    body.append("<h2 id=s").append(i).append(">Section ").append(i).append("</h2>").append(prose);
                }
                yield "<title>toc</title><nav class=\"duration-300 backdrop-filter\"><a href=\"/learn\">Learn</a> <a href=\"/reference\">Reference</a>"
                        + " <a href=\"/blog\">Blog</a></nav><div style=\"display:flex\">" + toc + "</div><main style=\"width:900px\"><h1>Lamps of the world</h1>"
                        + body + "</main></div>";
            }
            default -> "<title>missing</title>";
        };
    }

    /** Round 4's rules, each its page's shape. */
    private String roundFour(String path) {
        String prose = "<p>" + PROSE.repeat(3) + "</p>";
        String tiles = IntStream.rangeClosed(1, 8).mapToObj(i -> "<div class=tile><a href=\"/p/" + i + "\"><img src=\"/pic.png\" width=200 height=150 alt=\"\"></a>"
                + "<a href=\"/p/" + i + "\">Brass desk lamp number " + i + "</a><span>$" + (20 + i) + ".99</span></div>").collect(Collectors.joining());
        String grid = "<div style=\"display:grid;grid-template-columns:repeat(4,220px);gap:12px\">" + tiles + "</div>";
        return switch (path) {
            // a Discourse topic: the first post drawn, the rest cloaked to empty boxes; their words in the page's own JSON
            case "/t/lamps/123" -> {
                List<Map<String, Object>> posts = List.of(
                        Map.of("post_number", 1, "post_type", 1, "username", "ann", "name", "Ann Lee", "created_at", "2026-11-09T10:00:00Z",
                                "cooked", "<p>" + PROSE + "</p>"),
                        Map.of("post_number", 2, "post_type", 1, "username", "bob", "name", "Bob Day", "created_at", "2026-11-10T10:00:00Z",
                                "cooked", "<p>The brass one has lasted me ten years, a reply from the topic's own data.</p><div class=lightbox-wrapper>"
                                        + "<a class=lightbox href=\"/full.png\"><img src=\"/pic.png\" width=690 height=388></a><div class=meta>"
                                        + "<span class=filename>lamp.png</span>690x388 45 KB</div></div><script>fetch('/hit?cooked')</script>"
                                        + "<img src=\"/hit?img\" onerror=\"fetch('/hit?onerror')\" width=10 height=10>"),
                        Map.of("post_number", 3, "post_type", 4, "username", "cy", "name", "Cy", "created_at", "2026-11-10T11:00:00Z",
                                "cooked", "<p>A whisper only the site's staff see, never the view.</p>"),
                        Map.of("post_number", 4, "post_type", 1, "username", "mallory", "name", "Mallory", "created_at", "2026-11-10T12:00:00Z",
                                "cooked", "<p>A post whose box names someone else, never the view.</p>"));
                String topic = new String(Json.bytes(Map.of("id", 123, "post_stream", Map.of("posts", posts, "stream", List.of(1, 2, 3, 4)))), StandardCharsets.UTF_8);
                String preloaded = new String(Json.bytes(Map.of("topic_123", topic)), StandardCharsets.UTF_8).replace("</", "<\\/");
                StringBuilder page = new StringBuilder("<title>lamps</title><meta name=generator content=\"Discourse 3.6.0 - https://github.com/discourse/discourse\">"
                        + "<main><h1>Which desk lamp lasts?</h1><div id=post_1 data-post-number=1><p>Ann Lee</p><p>" + PROSE + "</p></div>");
                String[] who = {"", "", "bob", "cy", "eve"};
                for (int i = 2; i <= 4; i++) {
                    page.append("<div class=post-stream--cloaked id=post_").append(i).append(" data-post-number=").append(i)
                            .append(" style=\"height:300px\"><h2 class=sr-only style=\"position:absolute;width:1px;height:1px;overflow:hidden\">Post by ")
                            .append(who[i]).append(" 1 day ago</h2></div>");
                }
                yield page.append("</main><script type=\"application/json\" id=\"data-preloaded\">").append(preloaded).append("</script>").toString();
            }
            // a repo: its file list and README in the main column, its About column beside them
            case "/r4/repo" -> {
                StringBuilder files = new StringBuilder("<table><tr><th>Name</th><th>Last commit</th><th>Age</th></tr>");
                for (int i = 1; i <= 15; i++) {
                    files.append("<tr><td><a href=\"/tree/dir").append(i).append("\">dir").append(i).append("</a></td><td>Tidy dir ").append(i)
                            .append("</td><td>2 days ago</td></tr>");
                }
                String topics = IntStream.rangeClosed(1, 9).mapToObj(i -> "<a href=\"/topics/t" + i + "\">topic-" + i + "</a> ").collect(Collectors.joining());
                yield "<title>repo</title><main><div style=\"display:flex\"><div style=\"width:860px\">" + files + "</table>"
                        + "<article class=markdown-body><h1>Lampkit</h1>" + prose.repeat(3) + "<h2>Install</h2>" + prose + "</article></div>"
                        + "<div style=\"width:300px\"><div class=BorderGrid-cell><h2>About</h2><p>A kit for lamps of every kind.</p>"
                        + "<a href=\"https://lampkit.example\">lampkit.example</a><h3>Topics</h3><div>" + topics + "</div><h3>Resources</h3>"
                        + "<a href=\"#readme\">Readme</a> <a href=\"#license\">MIT license</a><h3>Stars</h3><a href=\"/stargazers\"><strong>9.9k</strong> stars</a>"
                        + "<h3>Watchers</h3><span><strong>61</strong> watching</span><h3>Forks</h3><a href=\"/forks\">6.8k forks</a>"
                        + "<a href=\"/report\">Report repository</a></div></div></div></main>";
            }
            // a forum's announcement banner above the topic, which the member can dismiss
            case "/r4/banner" -> {
                String tools = IntStream.rangeClosed(1, 12).mapToObj(i -> "<li><a href=\"/tool" + i + "\">tool number " + i + "</a></li>").collect(Collectors.joining());
                yield "<title>banner</title><main><div id=banner><button aria-label=\"Dismiss this banner\">\u200b</button><p>A security incident"
                        + " affecting a certificate authority required updates to these tools. " + PROSE + "</p><ul>" + tools + "</ul></div>"
                        + "<h1>Is the lamp safe?</h1>" + prose.repeat(2) + "</main>";
            }
            // a store's long filter rail at the side (past 6000 characters), its results beside it, and a sort control's h1
            case "/r4/rail" -> {
                StringBuilder rail = new StringBuilder("<div id=s-refinements style=\"width:240px\">");
                for (int g = 1; g <= 40; g++) {
                    rail.append("<h4>Filter group ").append(g).append("</h4><ul>");
                    for (int v = 1; v <= 4; v++) {
                        rail.append("<li><a href=\"/f?g=").append(g).append("&v=").append(v).append("\"><input type=checkbox> Choice ").append(v)
                                .append(" of the group, with a few more words</a></li>");
                    }
                    rail.append("</ul>");
                }
                yield "<title>rail</title><div style=\"display:flex\">" + rail + "</div><main style=\"width:1000px\"><h1><label for=s>Sort by:</label>"
                        + "<select id=s><option>Featured</option><option>Price</option></select></h1><h2>1-48 of over 50,000 results for desk lamp</h2>"
                        + grid + "</main></div>";
            }
            // an engine's results, each one link holding its site, its address as crumbs and its title (Brave's)
            case "/r4/crumbs" -> {
                StringBuilder page = new StringBuilder("<title>crumbs</title><main><h1>desk lamp reviews</h1><div id=results>");
                for (int i = 1; i <= 6; i++) {
                    page.append("<div class=snippet><a href=\"http://b.test:").append(port).append("/review").append(i).append("\"><div class=site>")
                            .append("<span>Site ").append(i).append("</span> <cite>b.test \u203a reviews \u203a lamps-").append(i).append("</cite></div>")
                            .append("<div class=\"title search-snippet-title\">The best desk lamps of the year, review ").append(i).append("</div></a>")
                            .append("<div class=snippet-description>We tried forty lamps over a month and these are the ones worth buying.</div></div>");
                }
                yield page.append("</div></main>").toString();
            }
            // a store's shopping row whose links carry an ad's click id, inside the results' own column
            case "/r4/adrow" -> {
                String ads = IntStream.rangeClosed(1, 4).mapToObj(i -> "<div class=tile><a href=\"http://shop.b.test:" + port + "/lamp" + i
                        + "?tag=x&hvadid=8012" + i + "\"><img src=\"/pic.png\" width=200 height=150 alt=\"\"></a><a href=\"http://shop.b.test:" + port + "/lamp" + i
                        + "?tag=x&hvadid=8012" + i + "\">Shopping ad lamp " + i + "</a><span>$1" + i + ".99</span></div>").collect(Collectors.joining());
                yield "<title>adrow</title><main><h1>desk lamp</h1><div style=\"display:grid;grid-template-columns:repeat(4,220px);gap:12px\">" + ads
                        + "</div>" + grid + "</main>";
            }
            // a bot check drawn over a store's own error page and its long footer
            case "/r4/check" -> "<title>Target : Expect More. Pay Less.</title><main><p>We're sorry! This page is currently unavailable.</p></main>"
                    + "<footer>" + ("<p>" + PROSE + "</p>").repeat(25) + "</footer><div id=px-captcha-modal role=dialog style=\"position:fixed;top:20%;"
                    + "left:30%;width:420px;height:220px;background:#fff;z-index:99\"><h2>Quick verification</h2><p>Press &amp; hold to confirm you're a"
                    + " human (and not a bot).</p><button>Press &amp; hold</button></div>";
            // a store's long results page still drawing its placeholders
            case "/r4/skeleton" -> "<title>skeleton</title><main><h1>desk lamp (1452)</h1><p>Deals for every list.</p><p>18 of 1452 products</p>"
                    + "<div style=\"display:grid;grid-template-columns:repeat(3,300px);gap:12px\">"
                    + "<div style=\"height:420px;background:#eee\"></div>".repeat(36) + "</div></main>";
            // a player that draws its own poster over a video that has none
            case "/r4/player" -> "<title>player</title><main><h1>Watch the lamp</h1>" + prose + "<div class=jwplayer style=\"position:relative;width:640px;"
                    + "height:360px\"><video id=v width=\"640\" height=\"360\" style=\"background:#000\"></video><div class=jw-preview style=\"position:absolute;"
                    + "inset:0;background-image:url(/pic.png);background-size:cover\"></div></div>" + prose + "</main>";
            // a docs page: its breadcrumbs, a Copy page button, its own contents list, its headings' anchors and a highlighter
            // that draws each line of code as a box of its own
            case "/r4/docs" -> {
                String toc = "<ul><li><a href=\"#ref\">Reference</a><ul><li><a href=\"#a\">useLamp(on)</a></li><li><a href=\"#b\">set functions</a></li></ul>"
                        + "</li><li><a href=\"#usage\">Usage</a></li><li><a href=\"#c\">Adding a lamp</a></li><li><a href=\"#d\">Updating a lamp</a></li>"
                        + "<li><a href=\"#e\">Troubleshooting</a></li></ul>";
                String code = "<pre><code><span style=\"display:block\">line one</span>\n<span style=\"display:block\">line two</span>\n"
                        + "<span style=\"display:block\">line three</span></code></pre>";
                yield "<title>docs</title><main><div><a href=\"/reference/lamps\">API Reference</a></div><div><a href=\"/reference/lamps/hooks\">Hooks</a>"
                        + "</div><h1>useLamp</h1><button>Copy page</button>" + prose + toc + "<h2 id=ref>Reference <a href=\"#ref\" aria-label=\"Link for"
                        + " Reference\">#</a></h2>" + prose + code + prose.repeat(3) + "</main>";
            }
            // a store's results: its popular filters as a row of pictured links back to this listing, a carousel of deals
            // whose pictures haven't drawn yet, then its grid
            case "/r4/store" -> {
                String chips = IntStream.rangeClosed(1, 6).mapToObj(i -> "<div style=\"width:120px\"><a href=\"/r4/store?facet=b" + i
                        + "\"><img src=\"/pic.png\" width=60 height=60 alt=\"\">Brand chip " + i + "</a></div>").collect(Collectors.joining());
                String deals = IntStream.rangeClosed(1, 6).mapToObj(i -> "<li style=\"width:200px;flex:none\"><div style=\"height:150px\"></div><span>$8"
                        + i + ".99</span> <a href=\"/p/deal" + i + "\">Ceramic table lamp number " + i + " with a linen shade</a> <button>Add to cart</button></li>")
                        .collect(Collectors.joining());
                yield "<title>desk lamp : Store</title><header><form role=search action=\"/r4/store\"><input type=search name=q value=\"desk lamp\">"
                        + "</form></header><main><h2>Popular filters</h2><div style=\"display:flex;gap:8px\">" + chips + "</div>"
                        + "<p>1,000+ results for desk lamp</p><h2>Deals based on your search</h2><ul style=\"display:flex;gap:12px;list-style:none\">"
                        + deals + "</ul>" + grid + "</main>";
            }
            // an engine's related searches and its feedback line, each a list whose first item is its label
            case "/r4/related" -> {
                String results = IntStream.rangeClosed(1, 5).mapToObj(i -> "<li><h3><a href=\"http://b.test:" + port + "/review" + i
                        + "\">The best desk lamps, review " + i + "</a></h3><p>" + PROSE + "</p></li>").collect(Collectors.joining());
                String related = IntStream.rangeClosed(1, 8).mapToObj(i -> "<li><a href=\"/search?q=lamp" + i + "\">related lamp search " + i + "</a></li>")
                        .collect(Collectors.joining());
                yield "<title>related</title><main><h1>desk lamp reviews</h1><ol>" + results + "</ol><ol><li>Searches related to desk lamp reviews</li>"
                        + related + "</ol><ul><li>Was this helpful? <button aria-label=\"Positive feedback\"></button><button aria-label=\"Negative feedback\">"
                        + "</button></li></ul></main>";
            }
            default -> "<title>missing</title>";
        };
    }

    /** Round 5's page shapes, each one a class of real page the view read badly (task 47, docs/sub-status/simple-view-quality.md). */
    private String roundFive(String path) {
        String prose = "<p>" + PROSE.repeat(3) + "</p>";
        String results = IntStream.rangeClosed(1, 8).mapToObj(i -> "<div class=result style=\"margin:12px 0\"><h3><a href=\"http://b.test:" + port + "/review" + i
                + "\">The best desk lamps of the year, review " + i + "</a></h3><p>" + PROSE + "</p></div>").collect(Collectors.joining());
        return switch (path) {
            // a site's header drawn as a table row, no landmarks: its logo and name lead home, a row of short links, a sign-in
            case "/r5/header" -> "<title>A lamp that lasts | Lamp News</title><table><tr><td><a href=\"/\"><img src=\"/pic.png\" width=18 height=18></a></td>"
                    + "<td><b><a href=\"/news\">Lamp News</a></b> <a href=\"/newest\">new</a> | <a href=\"/past\">past</a> | <a href=\"/ask\">ask</a> | "
                    + "<a href=\"/show\">show</a></td><td><a href=\"/login\">login</a></td></tr></table><table><tr><td><a href=\"http://b.test:" + port
                    + "/lamp\">A lamp that lasts</a></td></tr><tr><td>288 points by ann</td></tr></table>" + prose
                    + "<p><a href=\"/user?id=bob\">bob</a> 3 days ago | <a href=\"/reply?id=2\">reply</a> <a id=up_2 href=\"/vote?id=2\"><span class=votearrow title=upvote"
                    + " style=\"display:inline-block;width:10px;height:10px;background:#999\"></span></a></p>" + prose;
            // a video page: its title, then the site's own section links as a list, a player's controls drawn as links to the page
            case "/r5/navlist" -> "<title>Big Lamp</title><main><h1>Big Lamp</h1><ul>" + Stream.of("about", "blog", "events", "projects", "help", "jobs")
                    .map(s -> "<li><a href=\"/" + s + "/\">" + s.toUpperCase(Locale.ROOT) + "</a></li>").collect(Collectors.joining()) + "</ul>"
                    + "<div style=\"width:640px;height:360px\"><video width=640 height=360 style=\"background:#000\"></video></div>"
                    + "<p><a href=\"#\">Click to mute</a> <a href=\"#\">Fullscreen view</a></p>" + prose + "</main>";
            // a list's own tools: menu buttons over the results, density switches, a module's chips led by All, an engine's tools
            case "/r5/listing" -> "<title>Issues</title><header><form role=search action=\"/r5/listing\"><input type=search name=q value=\"lamps\"></form></header>"
                    + "<main><h1>Issues</h1><div>" + Stream.of("Author", "Labels", "Projects", "Milestones", "Assignees")
                    .map(s -> "<button aria-expanded=false aria-haspopup=menu>" + s + "</button> ").collect(Collectors.joining()) + "</div>"
                    + "<div><button aria-pressed=true>Comfortable display density</button><button aria-pressed=false>Compact display density</button></div>"
                    + results + "<h2>Results from the forum</h2><ul><li><button>All</button> <button>r/lamps</button> <button>r/desks</button> <button>r/light</button></li>"
                    + "<li>More boards</li><li><button>r/brass</button> <button>r/shades</button> <button>r/bulbs</button></li></ul>" + results
                    + "<p><button>Copy to clipboard</button> <button>Share Feedback</button> <button>Scan to get the app</button></p></main>";
            // a shop's product: a read-only rich text box, a price drawn for the eye beside its screen-reader twin, a photo gallery
            // of zoom buttons, swatches named for the product, the button to buy
            case "/r5/product" -> "<title>Brass Lamp</title><main><h1>Brass Lamp</h1><div><span aria-hidden=true>$<span>19</span>.99</span><span style=\""
                    + "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)\">Price $ 19.99</span></div>"
                    + "<div><button><img src=\"/pic.png\" width=400 height=250 alt=\"Brass Lamp - front\"></button><button><img src=\"/pic.png\" width=400"
                    + " height=250 alt=\"Brass Lamp - side\"></button></div><div><button aria-label=\"Brass Lamp - Navy swatch\"><img src=\"/pic.png\" width=30"
                    + " height=30 alt=\"\"></button><button aria-label=\"Brass Lamp - Mist swatch\"><img src=\"/pic.png\" width=30 height=30 alt=\"\"></button></div>"
                    + "<button>Add to bag</button>" + prose + "<h2>Reviews</h2><div role=textbox contenteditable=false class=ProseMirror><p>A review that reads"
                    + " as text, never a field to type in.</p></div></main>";
            // a forecast: the current conditions floated left with their table, then the days as a strip of tiles, then each day's words
            case "/r5/forecast" -> "<title>Forecast</title><main><h1>Lamptown (KLMP)</h1><div><div style=\"float:left;width:300px\"><img src=\"/pic.png\" width=100"
                    + " height=100><p>Mostly Cloudy</p><p>57°F</p></div><div style=\"float:left\"><table><tr><td>Humidity</td><td>67%</td></tr>"
                    + "<tr><td>Wind</td><td>Calm</td></tr></table></div><div style=\"clear:both\"></div></div><h2>Extended Forecast</h2><ul style=\"display:flex;"
                    + "gap:8px;list-style:none\">" + IntStream.rangeClosed(1, 6).mapToObj(i -> "<li style=\"width:100px\"><div><p>Day " + i + "</p><p><img src=\"/pic.png\""
                    + " width=86 height=86 alt=\"\"></p><p>High: 6" + i + " °F</p><p>Sunny</p></div></li>").collect(Collectors.joining()) + "</ul>"
                    + "<h2>Detailed Forecast</h2>" + IntStream.rangeClosed(1, 6).mapToObj(i -> "<p><b>Day " + i + "</b></p><p>Sunny, with a high near 6" + i
                    + ". " + PROSE + "</p>").collect(Collectors.joining()) + "</main>";
            // a front page: each story a card whose covering link repeats its headline, a kicker over the headline, a comment count
            // linking off, and a fundraiser's ask with its amounts to pick
            case "/r5/front" -> "<title>The Lamp Times</title><main><h1>News</h1><ul>" + IntStream.rangeClosed(1, 2).mapToObj(i -> "<li style=\"position:relative\">"
                    + "<a href=\"/s" + i + "\" style=\"position:absolute;inset:0\">Headline number " + i + " about the lamps of the world</a><h3>Lamps</h3>"
                    + "<h3>Headline number " + i + " about the lamps of the world</h3><p>A trail of words for story " + i + ".</p></li>").collect(Collectors.joining())
                    + "</ul><p><a href=\"/s1#comments\">2315</a></p><aside><div data-testid=contributions-liveblog-epic><p>There's no paywall here</p><p>Please"
                    + " support our year-end fundraiser today.</p><label><input type=radio name=amt> Support once from just $1</label><label><input type=radio"
                    + " name=amt> Support $15/month</label><a href=\"/contribute\">Continue</a></div></aside>" + prose + "</main>";
            // a recipe: its facts in JSON-LD, its cooks' photos as nameless tiles, a long story before the ingredients, a lone Filter
            case "/r5/recipe" -> {
                String ld = "{\"@context\":\"https://schema.org\",\"@type\":\"Recipe\",\"name\":\"Lamp Cookies\",\"prepTime\":\"PT20M\",\"cookTime\":\"PT10M\","
                        + "\"totalTime\":\"PT30M\",\"recipeYield\":\"48\",\"aggregateRating\":{\"ratingValue\":\"4.6\",\"ratingCount\":\"19336\"},"
                        + "\"recipeIngredient\":[\"1 cup butter, softened\",\"1 cup white sugar\"],\"recipeInstructions\":[\"Mix.\",\"Bake.\"]}";
                yield "<title>Lamp Cookies</title><script type=\"application/ld+json\">" + ld + "</script><header><button aria-label=Filter>Filter</button></header>"
                        + "<main><h1>Lamp Cookies</h1><div style=\"display:flex;gap:8px\">" + IntStream.rangeClosed(1, 4).mapToObj(i -> "<div style=\"width:160px\">"
                        + "<img src=\"/pic.png\" width=160 height=90 alt=\"\">" + (i == 4 ? "<span>4,927</span>" : "") + "</div>").collect(Collectors.joining())
                        + "</div>" + IntStream.rangeClosed(1, 3).mapToObj(i -> "<p>" + PROSE.repeat(3) + " Story part " + i + ".</p>").collect(Collectors.joining())
                        + "<h2>Ingredients</h2><ul><li>1 cup butter, softened</li><li>1 cup white sugar</li></ul>" + prose + "</main>";
            }
            // a link aggregator: each story's score, tags, by-line and comment count, and its next page in a nav of its own
            case "/r5/stories" -> "<title>Lamp Links</title><main><h1>Lamp Links</h1><ol>" + IntStream.rangeClosed(1, 8).mapToObj(i -> "<li class=story>"
                    + "<div class=voters><a class=upvoter href=\"/login\"></a><div class=score>3" + i + "</div></div><div class=details><span class=link>"
                    + "<a href=\"http://b.test:" + port + "/story" + i + "\">Story number " + i + " about the lamps of the world</a></span> <span class=tags>"
                    + "<a class=tag href=\"/t/ask\">ask</a> <a class=tag href=\"/t/devops\">devops</a></span><div class=byline><img src=\"/pic.png\" width=48 height=48 alt=\"\"> "
                    + "<span>authored by</span> <a href=\"/~ann\">ann</a> <time>2 hours ago</time> | <a href=\"/s/" + i + "\">1" + i + " comments</a></div></div></li>")
                    .collect(Collectors.joining()) + "</ol><nav class=morelink><a rel=next href=\"/page/2\">Page 2</a></nav></main>";
            // an engine's results: each one's address line before its snippet, an ad module's searches, and its own answer among
            // the results, named by its source's domain
            case "/r5/engine" -> "<title>desk lamp reviews</title><header><form role=search action=\"/r5/engine\"><input type=search name=q value=\"desk lamp reviews\">"
                    + "</form></header><main><h1>desk lamp reviews</h1><ol>" + "<li class=r><h3><a href=\"http://b.test:" + port + "/answer\">answers.b.test</a></h3>"
                    + "<p>The brass lamp is praised for its wide coverage and its many brightness settings, making it ideal for large desks and for reducing"
                    + " the strain on tired eyes late at night.</p></li>" + IntStream.rangeClosed(1, 7).mapToObj(i -> "<li class=r><h3><a href=\"http://b.test:"
                    + port + "/review" + i + "\">The best desk lamps of the year, review " + i + "</a></h3><div><span>Lamp Review</span> <cite>https://b.test"
                    + " › reviews › lamps-" + i + "</cite></div><p>" + PROSE + "</p></li>").collect(Collectors.joining())
                    + "<li class=r><h3><a href=\"/search?q=lamps&mrq=1\">Find related products &amp; services</a></h3><p>These searches help you find relevant"
                    + " offers from advertisers. " + PROSE + "</p></li></ol><h2>AI Overview</h2><div><span style=\"display:block\">The</span>"
                    + "<a style=\"display:block\" href=\"http://b.test:" + port + "/benq\">BenQ e-Reading lamp</a><span style=\"display:block\">is widely ranked as"
                    + " the best lamp for large desks, priced around $249.</span></div><button>Show more</button></main>";
            // a docs page: a side menu holding the page's own contents among its other links, and a callout's title on a line of its own
            case "/r5/docs" -> "<title>datelamp</title><div role=navigation aria-label=Main class=sphinxsidebar><ul>" + IntStream.rangeClosed(1, 8)
                    .mapToObj(i -> "<li><a href=\"#s" + i + "\">Section " + i + "</a></li>").collect(Collectors.joining()) + "</ul><a href=\"/prev\">Previous topic</a>"
                    + " <a href=\"/next\">Next topic</a> <a href=\"/bugs\">Report a bug</a></div><main><h1>datelamp</h1><div class=\"admonition tip\"><p"
                    + " class=admonition-title>Tip</p><p>Skip to the format codes.</p></div>" + IntStream.rangeClosed(1, 8).mapToObj(i -> "<h2 id=s" + i
                    + ">Section " + i + "</h2>" + prose).collect(Collectors.joining()) + "</main>";
            // a full-width player sized to a short window, and a lazy picture far down that nothing scrolls to
            case "/r5/hero" -> "<title>hero</title><main><div class=player style=\"width:1300px;height:400px\"><video width=1300 height=400 style=\"width:1300px;"
                    + "height:400px;background:#000\"></video></div><h1>The lamp, in a film</h1>" + prose + "<div style=\"height:30000px\"></div>"
                    + "<img loading=lazy src=\"/pic.png?far\" width=300 height=200 alt=\"A far lamp\">" + prose + "</main>";
            // a shop's grid with a run of a carousel tile's leftovers (delivery lines, Add to cart, a count) between its cards
            case "/r5/debris" -> {
                String tiles = IntStream.rangeClosed(1, 8).mapToObj(i -> "<div class=tile><a href=\"/p/" + i + "\"><img src=\"/pic.png\" width=200 height=150"
                        + " alt=\"\"></a><a href=\"/p/" + i + "\">Brass desk lamp number " + i + "</a><span>$" + (20 + i) + ".99</span> <a href=\"/p/" + i
                        + "#reviews\" aria-label=\"" + (4 + i) + " reviews\"><span>" + (4 + i) + "</span></a></div>").collect(Collectors.joining());
                yield "<title>desk lamp : Shop</title><main><h1>Results for desk lamp</h1><div style=\"display:grid;grid-template-columns:repeat(4,220px);gap:12px\">"
                        + tiles + "</div><ul><li>Join Prime to get FREE delivery Fri, Nov 13</li><li>Or Non-members get FREE delivery Mon, Nov 16</li>"
                        + "<li><button>Add to cart</button></li><li><a href=\"/p/x#reviews\">(1)</a></li></ul><div style=\"display:grid;grid-template-columns:"
                        + "repeat(4,220px);gap:12px\">" + tiles.replace("number ", "model ") + "</div></main>";
            }
            // a newsletter's post: the site's name as a heading over the post's own title, and its reaction counts as buttons
            // with no word; a shop's row labelled Sponsored, and its filters as links that each apply one
            case "/r5/post" -> "<title>Your lamp review</title><meta property=\"og:site_name\" content=\"Lamp Letters\"><main><h1>Lamp Letters</h1>"
                    + "<h1>Your lamp review</h1><p><button>189</button> <button>200</button> <button>11</button> <button>Table of Contents</button></p>"
                    + prose + "<p><button>Previous</button> <button>1</button> <button>2</button> <button>Next</button></p></main>";
            case "/r5/sponsored" -> {
                String ads = IntStream.rangeClosed(1, 3).mapToObj(i -> "<div class=tile><a href=\"/ad" + i + "\"><img src=\"/pic.png\" width=200 height=150 alt=\"\">"
                        + "</a><a href=\"/ad" + i + "\">Promoted lamp of the shop number " + i + "</a><span>$9" + i + ".00</span></div>").collect(Collectors.joining());
                String filters = Stream.of("Wood", "Metal", "Brass").map(f -> "<li><a href=\"/f?m=" + f + "\">" + f + " - apply Popular Filters filter</a></li>")
                        .collect(Collectors.joining());
                yield "<title>desk lamp | Shop</title><main><h1>160,000+ results for desk lamp</h1><p><a href=\"/shop/swanky\">Lamp Shop</a></p><p>Sponsored</p>"
                        + "<p>Ends soon</p><div style=\"display:grid;grid-template-columns:repeat(3,220px);gap:12px\">" + ads + "</div><h2>Popular Filters</h2><ul>"
                        + filters + "</ul>" + results + "</main>";
            }
            default -> "<title>missing</title>";
        };
    }

    /** Round 6's page shapes: listings and engines, and the furniture of pages that read the same (task 47). */
    private String roundSix(String path) {
        String prose = "<p>" + PROSE.repeat(3) + "</p>";
        String b = "http://b.test:" + port;
        String tile = "<li class=p style=\"width:220px\"><a href=\"/p/%1$s\"><img src=\"/pic.png\" width=200 height=150 alt=\"\"></a><h4><a href=\"/p/%1$s\">"
                + "%2$s</a></h4><span>$%3$s.99</span>%4$s</li>";
        return switch (path) {
            // an engine's results under a long answer: its query in bold in each snippet, an address line, a lone path of
            // crumbs, its own AI chat buttons and logo, a sponsored result's toggle, and its "Next" set as a heading
            case "/r6/engine" -> "<title>desk lamp reviews - Lamp Search</title><header><form role=search action=\"/r6/engine\"><input type=search name=q"
                    + " value=\"desk lamp reviews\"></form></header><main><div><a href=\"/\"><img src=\"/pic.png\" width=92 height=30 alt=\"Go to Lamp Search"
                    + " home\"></a></div><h1>desk lamp reviews</h1><div><button>New thread</button> <button>Settings</button></div><div><button>Hide"
                    + " sponsored result</button></div><div>" + prose + prose + prose + "</div><div>" + IntStream.rangeClosed(1, 6).mapToObj(i -> "<div class=r"
                    + " style=\"margin:12px 0\"><h3><a href=\"http://www.b.test:" + port + "/review" + i + "\">The best desk lamps of the year, review " + i
                    + "</a></h3><div><span>Lamp Review</span> <span>www.b.test</span></div><p>The best <b>desk lamps</b> come in many styles to brighten any"
                    + " workspace, and we tested them all, review " + i + ".</p></div>").collect(Collectors.joining())
                    + "<div class=r style=\"margin:12px 0\"><h3><a href=\"" + b + "/r/desks/1\">Need a desk lamp recommendation</a></h3><div>r/desks · Posted 2"
                    + " years ago</div><div>› r › desks › comments › 1g2ql2s › need_a_desk_lamp_recommendation</div></div></div>"
                    + "<h2><a href=\"/r6/engine?q=desk+lamp+reviews&amp;start=10\">Next</a></h2></main>";
            // a shop's listing: its promotion strip over the header, its header's lines after the title, a sponsored carousel
            // by its subtitle (spelled with a format character), filter links named for a screen reader, a grid drawn as
            // rows of short lists, a promotion tile among other results and a promotion line between two runs of them, a
            // deals carousel, tile noise and a card's carousel buttons, a feedback ask and a newsletter
            case "/r6/shop" -> {
                String row1 = IntStream.rangeClosed(1, 4).mapToObj(i -> tile.formatted("a" + i, "Brass desk lamp, row one " + i, "2" + i,
                        i == 1 ? "<span>+4</span><a href=\"/p/a1#price\">Price, product page</a><span>1k+</span> <span>bought in last month</span>"
                                + "<a href=\"/p/a1#reviews\">Rating 4.9 out of 5 stars with 11 reviews</a>" : "")).collect(Collectors.joining());
                String row2 = tile.formatted("b1", "Brass desk lamp, row two 1", "31", "<div><span>$31.99</span><span>or Best Offer</span><span>Free"
                        + " delivery</span><span>Located in Lampland</span><span>46 watchers</span></div>")
                        + tile.formatted("b2", "Sponsored lamp of row two", "32", "<span>Sponsored</span>")
                        + tile.formatted("b3", "Brass desk lamp, row two 3", "33", "");
                String row3 = IntStream.rangeClosed(1, 4).mapToObj(i -> tile.formatted("c" + i, "Brass desk lamp, row three " + i, "4" + i, ""))
                        .collect(Collectors.joining());
                String grid = Stream.of(row1, row2, row3).map(r -> "<div class=row><ul class=g style=\"display:flex;gap:8px;list-style:none\">" + r
                        + "</ul></div>").collect(Collectors.joining());
                String deals = IntStream.rangeClosed(1, 4).mapToObj(i -> "<div class=t style=\"width:220px\"><a href=\"/d/" + i + "\"><img src=\"/pic.png\""
                        + " width=200 height=150 alt=\"\"></a><p>$" + i + "9.99</p><p><a href=\"/d/" + i + "\">Deal lamp number " + i + "</a></p><button>Add to"
                        + " cart</button></div>").collect(Collectors.joining());
                String tg = IntStream.rangeClosed(1, 6).mapToObj(i -> "<div class=tile style=\"width:220px\"><a href=\"/q/" + i + "\"><img src=\"/pic.png\""
                        + " width=200 height=150 alt=\"\"></a><a href=\"/q/" + i + "\">Copper table lamp number " + i + "</a><span>$5" + i + ".00</span>"
                        + (i == 1 ? "<button>Go To End</button><button>Next Page</button>" : "") + "</div>"
                        + (i == 3 ? "<div class=promo style=\"width:100%\"><a href=\"/baking\">Holiday baking from $1</a></div>" : ""))
                        .collect(Collectors.joining());
                yield "<title>desk lamp - Lamp Shop</title><div class=strip><p>Deals for every list. Start early, save early. <a href=\"/deals\">Shop"
                        + " now</a></p></div><header><form role=search action=\"/r6/shop\"><input type=search name=st value=\"desk lamp\"></form></header>"
                        + "<main><h1>\"desk lamp\"</h1><p><button>Ship to 12345</button> <button>Lampville</button> <button>Buy Again</button></p><p><a"
                        + " href=\"/account\">Account</a> <a href=\"/cart\">cart 0 items</a></p><p><a href=\"/c/all\">All Categories</a></p>"
                        + "<h2>Popular Filters</h2><ul>" + Stream.of("Wood", "Metal", "Brass").map(f -> "<li><a href=\"/f?m=" + f + "\">" + f + "<span"
                        + " style=\"position:absolute;width:1px;height:1px;overflow:hidden\"> - apply Popular Filters filter</span></a></li>")
                        .collect(Collectors.joining()) + "</ul><p><button>Save this search</button></p><p>1,000+ results for \"desk lamp\"</p>"
                        + "<section><div><h2>Picked For You</h2><span>Top selling items from trusted sellers | Sp⁧onsored</span></div><button>Go to"
                        + " previous slide - Picked For You</button><ul style=\"display:flex;list-style:none\">" + IntStream.rangeClosed(1, 3)
                        .mapToObj(i -> tile.formatted("pk" + i, "Picked lamp number " + i, "1" + i, "")).collect(Collectors.joining()) + "</ul><button>Go"
                        + " to next slide - Picked For You</button></section><div class=grid>" + grid + "</div><div style=\"display:flex;flex-wrap:wrap;"
                        + "gap:8px\">" + tg + "</div><p><a href=\"/sale\">Lamps on sale from $5</a></p><div style=\"display:flex;flex-wrap:wrap;gap:8px\">"
                        + tg.replace("Copper", "Iron").replace("/q/", "/r/") + "</div><section><h2>Deals based on your search</h2><div"
                        + " style=\"display:flex\">" + deals + "</div></section><div>Tell us about"
                        + " your search experience</div><h3>Get top deals, latest trends, and more.</h3><form action=\"/join\"><p><input type=email"
                        + " aria-label=\"Email address\"></p><p><button>Sign up</button></p></form></main>";
            }
            // an issue list: the section's sibling pages as lines over the title, its Open and Closed tabs, an issue's number in
            // this repository and "opened" with its date, and a footer drawn without a landmark
            case "/r6/repo/issues" -> "<title>Issues · r6/repo</title><header><form role=search action=\"/r6/repo/issues\"><input type=search name=q"
                    + " value=\"is:issue\"></form></header><main><nav aria-label=Repository><ul><li><a href=\"/r6/repo/views\">Views</a></li><li><a"
                    + " href=\"/r6/repo/milestones\">Milestones</a></li><li><a href=\"/r6/repo/labels\">Labels</a></li></ul></nav><div><h1>Issues</h1><ul><li><a href=\"/r6/repo/issues?q=open\">Open 22</a>"
                    + "</li><li><a href=\"/r6/repo/issues?q=closed\">Closed 18,478</a></li></ul><div>" + IntStream.rangeClosed(1, 8).mapToObj(i -> "<div"
                    + " class=issue style=\"margin:8px 0\"><h3><a href=\"/r6/repo/issues/" + (40 + i) + "\">The lamp flickers when the page scrolls, case "
                    + i + "</a></h3><div><span>r6/repo#" + (40 + i) + "</span> <span>opened</span> <span>on Nov 11, 2026</span></div></div>")
                    .collect(Collectors.joining()) + "</div></div></main><div><p><a href=\"/pricing\">Pricing</a> <a href=\"/sales\">Contact sales</a> <a"
                    + " href=\"/demos\">Watch demos</a></p><p>Our support team is here to help, day and night.</p><p>© 2026 Lamp Inc. All rights"
                    + " reserved.</p><p><a href=\"/terms\">Terms</a></p><p><a href=\"/privacy\">Privacy</a></p></div>";
            // a post: its byline as lines of their own under the title, a lone Table of Contents, a word's pronunciation
            // button, a product's swatches as small pictures, and a reference's way back up
            case "/r6/post" -> "<title>Your lamp review</title><main><h1>Your lamp review</h1><h3>Finalist #15 in the lamp review contest</h3><p><a"
                    + " href=\"/@ann\"><img src=\"/pic.png\" width=36 height=36 alt=\"View Ann Writer\"></a></p><p>ANN WRITER</p><p>Nov 06, 2026</p><p>"
                    + "<button>Table of Contents</button></p><p>The Staatliches Lamp (German: [ˈʃtaːtlɪçəs]"
                    + " <button>Play audio</button>) is a lamp. " + PROSE.repeat(3) + "</p><h2>Choose color</h2><p>Dark gray</p><ul><li><a href=\"/c/blue\">"
                    + "<img src=\"/pic.png\" width=40 height=40 alt=\"Light blue\"></a></li><li><a href=\"/c/navy\"><img src=\"/pic.png\" width=40 height=40"
                    + " alt=\"Navy\"></a></li></ul>" + prose + prose + "<ol class=references><li><a href=\"#cite-1\" aria-label=\"Jump up\">^</a> Ann"
                    + " Writer (2002). The lamps of the world. Lamp Press.</li><li><a href=\"#cite-2\" aria-label=\"Jump up\">^</a> Bob Writer (2003). More"
                    + " lamps. Lamp Press.</li></ol></main>";
            // a store's grid that goes blank for a moment while it draws its rows again, at the same length
            case "/r6/redraw" -> "<title>desk lamp - Lamp Grid</title><main><h1>Results for desk lamp</h1><div id=g style=\"min-height:6000px\"></div>"
                    + "</main><script>const g = document.getElementById('g');window.fill = (w) => { g.innerHTML = '<div style=\"display:flex;flex-wrap:wrap;"
                    + "gap:8px\">' + Array.from({ length: 16 }, (_, i) => '<div class=tile style=\"width:220px\"><a href=\"/p/' + i + '\"><img src=\"/pic.png\""
                    + " width=200 height=150 alt=\"\"></a><a href=\"/p/' + i + '\">' + w + ' desk lamp number ' + (i + 1) + '</a><span>$2' + i + '.99</span>"
                    + "</div>').join('') + '</div>'; };window.blank = () => { g.innerHTML = '<div class=skeleton style=\"height:6000px\"></div>'; };"
                    + "fill('Brass');</script>";
            default -> "<title>missing</title>";
        };
    }

    private static String radios(String name, String... labels) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < labels.length; i++) {
            out.append("<label><input type=radio name=").append(name).append(i == 0 ? " checked" : "").append("> ").append(labels[i]).append("</label> ");
        }
        return out.toString();
    }

    private void startChromium() throws IOException {
        // A password manager stand-in, whose in-page menu is a frame of its own page (vault-extension/), on /vault only.
        Path extension = Files.createDirectories(dir.resolve("vault-extension"));
        for (String file : List.of("manifest.json", "content.js", "menu.html")) {
            try (java.io.InputStream in = getClass().getResourceAsStream("/minified/vault-extension/" + file)) {
                Files.write(extension.resolve(file), in.readAllBytes());
            }
        }
        chromium = new ProcessBuilder(
                        System.getenv("DESKD_CHROMIUM_BIN"),
                        "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                        "--noerrdialogs", "--disable-breakpad", "--password-store=basic", "--window-size=1280,800",
                        "--user-data-dir=" + dir.resolve("profile"),
                        "--load-extension=" + extension, "--disable-extensions-except=" + extension,
                        "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=" + cdpPort,
                        "--host-resolver-rules=MAP a.test 127.0.0.1, MAP www.a.test 127.0.0.1, MAP b.test 127.0.0.1, MAP c.test 127.0.0.1, MAP d.test 127.0.0.1, "
                                + "MAP js.stripe.com 127.0.0.1, MAP www.chase.com 127.0.0.1",
                        "about:blank")
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.appendTo(dir.resolve("chromium.log").toFile()))
                .start();
    }

    // ---- helpers

    private static String footer() {
        StringBuilder links = new StringBuilder("<footer><nav>");
        for (String name : List.of("Questions", "Help", "Teams", "Advertising", "Collectives", "Talent", "About", "Press",
                "Work here", "Legal", "Privacy policy", "Terms of service", "Contact us", "Cookie settings", "Cookie policy")) {
            links.append("<a href=\"/").append(name.toLowerCase(java.util.Locale.ROOT).replace(' ', '-')).append("\">").append(name).append("</a> ");
        }
        return links.append("</nav><p>Site design and logo, all rights reserved. User contributions under their own licence.</p></footer>").toString();
    }

    private String consentPage(String words, String box, String buttons) {
        return "<title>consent</title><main><h1>An article</h1><p>" + PROSE.repeat(5) + "</p></main>"
                + "<div style=\"position:fixed;" + box + ";background:#fff;z-index:9999\"><p>" + words + "</p>" + buttons + "</div>";
    }

    private static byte[] png() throws IOException {
        BufferedImage image = new BufferedImage(300, 200, BufferedImage.TYPE_INT_RGB);
        image.setRGB(10, 10, 0xFF8800);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(image, "png", out);
        return out.toByteArray();
    }

    private int hits(String key) {
        AtomicInteger count = hits.get(key);
        return count == null ? 0 : count.get();
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

    private String open(String host, String path) throws Exception {
        Map<String, Object> reply = rig.call(client, "browser.tab.navigate", Map.of("url", "http://" + host + ":" + port + path));
        assertThat(reply).containsEntry("_kind", "RES");
        String tabId = (String) reply.get("tabId");
        await().atMost(Duration.ofSeconds(15)).until(() -> !Boolean.TRUE.equals(tab(tabId).get("loading")));
        return tabId;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> tab(String tabId) throws Exception {
        Map<String, Object> reply = rig.call(client, "browser.tab.list", Map.of(), null);
        return ((List<Map<String, Object>>) reply.get("tabs")).stream().filter(t -> tabId.equals(t.get("tabId"))).findFirst().orElseThrow();
    }

    private Map<String, Object> get(String tabId) throws Exception {
        Map<String, Object> reply = rig.call(client, "browser.minified.get", Map.of("tabId", tabId), null);
        assertThat(reply).containsEntry("_kind", "RES");
        return reply;
    }

    /** The view, once it's simplified. */
    @SuppressWarnings("unchecked")
    private Map<String, Object> mdoc(String tabId) throws Exception {
        Map<String, Object>[] last = new Map[1];
        await().atMost(Duration.ofSeconds(20)).untilAsserted(() -> {
            last[0] = get(tabId);
            assertThat(last[0]).containsEntry("view", "simplified");
        });
        return (Map<String, Object>) last[0].get("mdoc");
    }

    /** Every run and block under a node, depth first, as maps. */
    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> all(Object tree) {
        List<Map<String, Object>> found = new ArrayList<>();
        if (tree instanceof Map<?, ?> map) {
            found.add((Map<String, Object>) map);
            map.values().forEach(v -> found.addAll(all(v)));
        } else if (tree instanceof List<?> list) {
            list.forEach(v -> found.addAll(all(v)));
        }
        return found;
    }

    /** The block a run is in, and the run: the first run of this kind whose text or label contains the words. */
    private static Map<String, Object> find(Map<String, Object> mdoc, String r, String words) {
        for (Map<String, Object> block : blocks(mdoc)) {
            for (Map<String, Object> run : all(block)) {
                if (r.equals(run.get("r")) && Json.bytes(run).length > 0 && new String(Json.bytes(run), StandardCharsets.UTF_8).contains(words)) {
                    Map<String, Object> found = new LinkedHashMap<>(run);
                    found.put("_block", block.get("key"));
                    found.put("_rev", mdoc.get("rev"));
                    return found;
                }
            }
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> blocks(Map<String, Object> mdoc) {
        return (List<Map<String, Object>>) mdoc.get("blocks");
    }

    private Map<String, Object> act(String tabId, Map<String, Object> run, String action, Object value) throws Exception {
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("tabId", tabId);
        params.put("nodeId", run.get("node"));
        params.put("action", action);
        if (value != null) {
            params.put("value", value);
        }
        params.put("fp", run.get("fp"));
        params.put("block", run.get("_block"));
        params.put("rev", run.get("_rev"));
        return rig.call(client, "browser.minified.act", params);
    }

    /** A script in the page's own world, from the test's own debugging socket, as the page itself could run. */
    private String inPage(String targetId, String expression) throws Exception {
        return onPage(targetId, "Runtime.evaluate", Map.of("expression", expression, "returnByValue", true));
    }

    private String onPage(String targetId, String method, Map<String, Object> params) throws Exception {
        return send("ws://127.0.0.1:" + cdpPort + "/devtools/page/" + targetId, method, params);
    }

    private String send(String socketUrl, String method, Map<String, Object> params) throws Exception {
        try (HttpClient http = HttpClient.newHttpClient()) {
            CompletableFuture<String> reply = new CompletableFuture<>();
            StringBuilder text = new StringBuilder();
            WebSocket socket = http.newWebSocketBuilder()
                    .buildAsync(URI.create(socketUrl), new WebSocket.Listener() {
                        @Override
                        public java.util.concurrent.CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
                            text.append(data);
                            if (last) {
                                reply.complete(text.toString());
                            }
                            webSocket.request(1);
                            return null;
                        }
                    })
                    .get(5, TimeUnit.SECONDS);
            socket.sendText(new String(Json.bytes(Map.of("id", 1, "method", method, "params", params)), StandardCharsets.UTF_8), true);
            String answer = reply.get(10, TimeUnit.SECONDS);
            socket.abort();
            return answer;
        }
    }

    // ---- the view

    @Test
    void anArticleIsSimplifiedWithItsImageFromWhatTheTabLoaded() throws Exception {
        String tabId = open("a.test", "/article");
        Map<String, Object> mdoc = mdoc(tabId);
        assertThat(mdoc).containsEntry("v", 1).containsEntry("tabId", tabId).containsEntry("sensitive", false);
        String json = new String(Json.bytes(mdoc), StandardCharsets.UTF_8);
        assertThat(json).contains("Lamps of the world").doesNotContain("/pic.png").doesNotContain("<");

        // T47-5: the image goes by an opaque id, and its bytes are Chromium's copy, with no new fetch.
        Map<String, Object> image = all(mdoc).stream().filter(m -> "image".equals(m.get("t")) || "image".equals(m.get("r")))
                .findFirst().orElseThrow();
        assertThat(image).containsEntry("width", 300).containsEntry("height", 200);
        int fetched = hits("/pic.png");
        assertThat(fetched).isEqualTo(1);
        Map<String, Object> bytes = rig.call(client, "browser.minified.image", Map.of("tabId", tabId, "imageId", image.get("image")), null);
        assertThat(bytes).containsEntry("_kind", "RES").containsEntry("mime", "image/png");
        assertThat(Base64.getDecoder().decode((String) bytes.get("data"))).isEqualTo(png);
        assertThat(hits("/pic.png")).isEqualTo(fetched);

        Map<String, Object> link = find(mdoc, "link", "the next page");
        assertThat(link).containsKey("node").containsKey("fp");
        assertThat((String) link.get("url")).endsWith("/next");
        // On a local server the link's page commits before deskd can ask the old one what it got, which is "navigated":
        // never counted done, as nothing could say so, and never "missed", which would tell the member it didn't land.
        Map<String, Object> clicked = act(tabId, link, "click", null);
        assertThat(clicked).containsEntry("_kind", "RES");
        assertThat(clicked.get("done").equals(true) || "navigated".equals(clicked.get("reason"))).as("%s", clicked).isTrue();
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(tab(tabId)).containsEntry("title", "Next"));
    }

    /**
     * T47-3, reproduced by Security against the prototype: a page that slides another site's frame over a button got 5 of
     * 6 clicks into the frame. Here the frame never gets one, and a click counts only when the button itself got it.
     */
    @Test
    void aFrameSlidUnderTheClickNeverGetsIt() throws Exception {
        String tabId = open("a.test", "/slide");
        Map<String, Object> more = find(mdoc(tabId), "button", "Read more");
        assertThat(more).isNotNull();
        int done = 0;
        List<Object> outcomes = new ArrayList<>();
        for (int i = 0; i < 12; i++) {
            Map<String, Object> reply = act(tabId, more, "click", null);
            outcomes.add(reply.get("_kind").equals("RES") ? reply.get("done") + ":" + reply.get("reason") : reply.get("details"));
            if (Boolean.TRUE.equals(reply.get("done"))) {
                done++;
            }
            Thread.sleep(37);
        }
        int doneClicks = done;
        await().pollDelay(Duration.ofSeconds(1)).atMost(Duration.ofSeconds(10))
                .untilAsserted(() -> assertThat(hits("/hit?more")).isEqualTo(doneClicks));
        assertThat(hits("/hit?allow")).as("clicks that reached the other site's frame: %s", outcomes).isZero();
        assertThat(rig.module.minified().health().get("frames")).as("the frame's own session").isNotEqualTo(0);
    }

    /** T47-2: the same node, reused for another mail, refuses, and only a fresh look acts on the new one. */
    @Test
    void aReusedRowRefusesInsteadOfActingOnAnotherItem() throws Exception {
        String tabId = open("a.test", "/mail");
        Map<String, Object> archive = find(mdoc(tabId), "button", "Archive");
        assertThat(inPage(tabId, "swap()")).doesNotContain("\"error\"");

        Map<String, Object> refused = act(tabId, archive, "click", null);
        assertThat(refused).containsEntry("_kind", "ERR").containsEntry("code", "conflict");
        assertThat(Json.object(refused, "details")).containsEntry("reason", "changed");
        Thread.sleep(500);
        assertThat(hits.keySet()).noneMatch(k -> k.startsWith("/hit?archive"));

        Map<String, Object> fresh = find(mdoc(tabId), "button", "Archive");
        assertThat(fresh.get("fp")).isNotEqualTo(archive.get("fp"));
        assertThat(act(tabId, fresh, "click", null)).containsEntry("done", true);
        await().atMost(Duration.ofSeconds(10)).until(() -> hits("/hit?archive-Mail%20B%20from%20Bob%20about%20money") == 1);
        assertThat(hits.keySet().stream().filter(k -> k.startsWith("/hit?archive")).toList()).hasSize(1);
    }

    /** T47-1: no password, code, card or masked field, and no payment frame, is ever a field in the office. */
    @Test
    void sensitiveFieldsAreNeverFields() throws Exception {
        // A sign-in or payment page is the real page's (a challenge): nothing of it reaches the office at all.
        String signin = open("a.test", "/signin");
        await().atMost(Duration.ofSeconds(20)).untilAsserted(() -> {
            Map<String, Object> view = get(signin);
            assertThat(view).containsEntry("view", "stream").doesNotContainKey("mdoc");
            assertThat(Json.object(view, "fallback")).containsEntry("reason", "challenge");
            assertThat(Json.object(view, "fallback").get("cause")).isIn("sign_in", "payment");
        });
        // The fields that don't make a page a challenge are never fields either (T47-1).
        String tabId = open("a.test", "/signin-box");
        Map<String, Object> mdoc = mdoc(tabId);
        String json = new String(Json.bytes(mdoc), StandardCharsets.UTF_8);
        assertThat(json).doesNotContain("123456", "9876");
        assertThat(mdoc).containsEntry("sensitive", true);
        List<Object> kinds = all(mdoc).stream().filter(m -> "sensitive".equals(m.get("r")) || "sensitive".equals(m.get("t")))
                .map(m -> m.get("kind")).toList();
        assertThat(kinds).contains("one_time_code", "card", "masked");
        List<Map<String, Object>> fields = all(mdoc).stream().filter(m -> "field".equals(m.get("r"))).toList();
        assertThat(fields).extracting(f -> f.get("label")).containsExactly("Name", "Flip");
        assertThat(fields.get(0)).containsKey("node");
        // Review 4: a card's expiry select is the card's, and no select at all reaches the office.
        assertThat(all(mdoc).stream().filter(m -> "select".equals(m.get("r")))).isEmpty();
        // Review 4: a field that turns into a password one as it gets focus is never typed into.
        Map<String, Object> flip = find(mdoc, "field", "Flip");
        // Headless Chromium fires the focus that flips it when the keys come, so either the hit-test call or the guard at the
        // key catches it.
        Map<String, Object> refused = act(tabId, flip, "fill", "hunter3");
        assertThat("forbidden".equals(refused.get("code")) && "sensitive".equals(Json.object(refused, "details").get("reason"))
                || "sensitive".equals(refused.get("reason"))).as("%s", refused).isTrue();
        assertThat(inPage(tabId, "document.getElementById('flip').value")).doesNotContain("hunter3");
    }

    /** Review 3: a row a virtualized list rebinds as it scrolls is checked again after the scroll, and at the press. */
    @Test
    void aRowRebornByTheScrollIsNeverActedOn() throws Exception {
        String tabId = open("a.test", "/virtual");
        Map<String, Object> mdoc = mdoc(tabId);
        Map<String, Object> target = null;
        for (Map<String, Object> block : blocks(mdoc)) {
            if (new String(Json.bytes(block), StandardCharsets.UTF_8).contains("Mail 100 about item 100")) {
                target = all(block).stream().filter(m -> "button".equals(m.get("r"))).findFirst().map(LinkedHashMap::new).orElseThrow();
                target.put("_block", block.get("key"));
                target.put("_rev", mdoc.get("rev"));
                break;
            }
        }
        assertThat(target).isNotNull();
        Map<String, Object> reply = act(tabId, target, "click", null);
        assertThat(reply.get("done")).isNotEqualTo(true);
        Thread.sleep(500);
        assertThat(hits.keySet()).noneMatch(k -> k.startsWith("/hit?archive"));
    }

    @Test
    void typingFillsTheFieldAndIsCheckedThere() throws Exception {
        String tabId = open("a.test", "/form");
        Map<String, Object> field = find(mdoc(tabId), "field", "Search");
        assertThat(act(tabId, field, "fill", "brass lamps")).containsEntry("done", true);
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(tab(tabId)).containsEntry("title", "typed:brass lamps"));
        assertThat(act(tabId, find(mdoc(tabId), "field", "Search"), "fill", "")).containsEntry("done", true);
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(tab(tabId)).containsEntry("title", "typed:"));
    }

    @Test
    void aFrameInAClosedShadowRootNearThePressRefuses() throws Exception {
        String tabId = open("a.test", "/closedframe");
        mdoc(tabId);
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(rig.module.minified().health().get("frames")).isEqualTo(1));
        Map<String, Object> go = find(mdoc(tabId), "button", "Go on");
        Map<String, Object> refused = act(tabId, go, "click", null);
        assertThat(Json.object(refused, "details")).as("%s", refused).containsEntry("reason", "frame_near");
        Thread.sleep(500);
        assertThat(hits("/hit?closed")).isZero();
        assertThat(hits("/hit?allow")).isZero();
    }

    @Test
    void aTitleTheSiteAlsoHidesIsStillShown() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/twotitles"));
        String json = new String(Json.bytes(mdoc), StandardCharsets.UTF_8);
        assertThat(blocks(mdoc)).anySatisfy(b -> assertThat(b).containsEntry("t", "heading"));
        assertThat(json).contains("The lamp makers of the northern valley").doesNotContain("A paragraph the page never shows");
    }

    @Test
    void aFilterRailKnownOnlyByItsShapeFoldsAndARatingNeverNamesACard() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/rail"));
        String json = new String(Json.bytes(mdoc), StandardCharsets.UTF_8);
        // The rail is one folded Filters menu, not checkboxes before the results.
        assertThat(all(blocks(mdoc).get(0))).anySatisfy(m -> assertThat(m).containsEntry("kind", "filters"));
        List<Map<String, Object>> after = blocks(mdoc).subList(1, blocks(mdoc).size());
        assertThat(new String(Json.bytes(after), StandardCharsets.UTF_8)).doesNotContain("Pickup today");
        assertThat(json).contains("The brass reading lamp, small");
        assertThat(all(mdoc)).filteredOn(m -> m.get("title") instanceof Map<?, ?>)
                .allSatisfy(card -> assertThat(String.valueOf(((Map<?, ?>) card.get("title")).get("text"))).doesNotStartWith("Rating"));
    }

    @Test
    void aStorysOpeningStaysAndAHiddenModalOrAFarPromoPlayerDoesntSteerTheView() throws Exception {
        List<Map<String, Object>> blocks = blocks(mdoc(open("a.test", "/chunks")));
        String json = new String(Json.bytes(blocks), StandardCharsets.UTF_8);
        assertThat(json).contains("The opening of the story");
        int title = -1;
        for (int i = 0; i < blocks.size(); i++) {
            if ("heading".equals(blocks.get(i).get("t"))) {
                title = i;
                break;
            }
        }
        assertThat(title).isGreaterThanOrEqualTo(0);
        // The small player far down the page is never hoisted under the title.
        assertThat(blocks.get(title + 1).get("t")).isNotEqualTo("island");
    }

    @Test
    void anInFlowCookieBannerAndShoppingAdsAreHiddenAndNothingIsPressed() throws Exception {
        String tabId = open("a.test", "/inflow");
        Map<String, Object> mdoc = mdoc(tabId);
        String json = new String(Json.bytes(blocks(mdoc)), StandardCharsets.UTF_8);
        assertThat(json).contains("Check the lamp rules").doesNotContain("essential cookies", "Hide sponsored results", "Brass desk lamp from a shop");
        assertThat(String.valueOf(mdoc.get("hidden"))).contains("cookie");
    }

    @Test
    void aKickerSetApartOnItsRightNeverRunsIntoTheHeadline() throws Exception {
        String json = new String(Json.bytes(blocks(mdoc(open("a.test", "/kicker")))), StandardCharsets.UTF_8);
        assertThat(json).contains("The lamp makers win the vote").doesNotContain("sketchThe");
    }

    @Test
    void whatFloatsBesideTheLeadIsReadAfterIt() throws Exception {
        List<String> order = new ArrayList<>();
        for (Map<String, Object> block : blocks(mdoc(open("a.test", "/infobox")))) {
            String text = new String(Json.bytes(block), StandardCharsets.UTF_8);
            for (String mark : List.of("Brass lamps", "opens the lead", "Since 1900", "on a desk in the reading room", "History", "beside the history", "goes on")) {
                if (text.contains(mark) && !order.contains(mark)) {
                    order.add(mark);
                }
            }
        }
        // The lead first, then what floated beside it, before the next section; a float later in the page stays put.
        assertThat(order).containsExactly("Brass lamps", "opens the lead", "Since 1900", "on a desk in the reading room", "History", "beside the history", "goes on");
    }

    @Test
    void aFillPastWhatDeskdsReaderKeepsOfAStringIsStillDone() throws Exception {
        // Review 3: deskd's reader cuts a string at 4096 characters, so the check is by hash and length.
        String tabId = open("a.test", "/form");
        for (int length : new int[] {5000, 65536}) {
            String text = "brass lamps ".repeat(length / 12 + 1).substring(0, length);
            assertThat(act(tabId, find(mdoc(tabId), "field", "Search"), "fill", text)).containsEntry("done", true);
        }
    }

    @Test
    void aFrameInAnotherProcessIsntInItsParentsFrameTreeButIsInChromiumsTargets() throws Exception {
        // Review 6 asked: does Blink's frame tree list a frame of another site, in another process? It doesn't. So
        // PageWorld.frames reads Chromium's frame targets beside the trees, and a frame there that deskd holds no session
        // for refuses the action (MinifiedMethodsTest.aFrameInAnotherProcessWithNoSessionRefuses).
        String tabId = open("a.test", "/slide");
        mdoc(tabId);
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(rig.module.minified().health().get("frames"))
                .as("the b.test frame is in a process of its own, with a session of its own").isEqualTo(1));
        assertThat(onPage(tabId, "Page.getFrameTree", Map.of())).doesNotContain("b.test:" + port + "/allow");
        String targets = onPage(tabId, "Target.getTargets", Map.of("filter", List.of(Map.of("type", "iframe"))));
        assertThat(targets).contains("b.test:" + port + "/allow").contains("\"parentFrameId\"");
        // And deskd still arms it, through its own session: the press goes, or refuses as the frame slides over the button
        // (T47-3), and never lands in the frame.
        Map<String, Object> more = find(mdoc(tabId), "button", "Read more");
        Map<String, Object> reply = act(tabId, more, "click", null);
        assertThat(reply.get("done") != null || "conflict".equals(reply.get("code"))).as("%s", reply).isTrue();
        Thread.sleep(300);
        assertThat(hits("/hit?allow")).isZero();
    }

    @Test
    void aVideoIsAnIslandWithItsBoxClampedToTheViewport() throws Exception {
        String tabId = open("a.test", "/video");
        Map<String, Object> island = all(mdoc(tabId)).stream().filter(m -> "island".equals(m.get("t"))).findFirst().orElseThrow();
        assertThat(island).containsEntry("kind", "video").containsKey("island").containsKey("fp").containsKey("box");
        assertThat(Json.object(island, "media")).containsEntry("paused", true).containsEntry("frame", false).containsKey("poster");
        Map<String, Object> box = rig.call(client, "browser.minified.island", Map.of("tabId", tabId, "islandId", island.get("island")), null);
        assertThat(box).containsEntry("_kind", "RES").containsEntry("kind", "video");
        Map<String, Object> rect = Json.object(box, "rect");
        Map<String, Object> viewport = Json.object(box, "viewport");
        assertThat(((Number) rect.get("width")).intValue()).isEqualTo(640);
        assertThat(((Number) rect.get("x")).intValue() + ((Number) rect.get("width")).intValue())
                .isLessThanOrEqualTo(((Number) viewport.get("width")).intValue());
        long epoch = ((Number) box.get("epoch")).longValue();
        assertThat(epoch).isPositive();
        Map<String, Object> again = rig.call(client, "browser.minified.island", Map.of("tabId", tabId, "islandId", island.get("island")), null);
        assertThat(((Number) again.get("epoch")).longValue()).isEqualTo(epoch);

        // Media verbs wait on Security's yes: off by default.
        Map<String, Object> verb = rig.call(client, "browser.minified.act", Map.of("tabId", tabId, "nodeId", island.get("island"),
                "action", "media", "value", Map.of("verb", "play"), "fp", island.get("fp"), "block", island.get("key"), "rev", 1));
        assertThat(verb).containsEntry("code", "forbidden");
        assertThat(Json.object(verb, "details")).containsEntry("reason", "disabled");
    }

    /** T47D-1: a frame born after deskd's look at the frames, under the button, never gets the member's click. */
    @Test
    void aFrameBornWhileDeskdLooksNeverGetsTheClick() throws Exception {
        List<Object> outcomes = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            String tabId = open("a.test", "/lastframe");
            Map<String, Object> more = find(mdoc(tabId), "button", "Read more");
            assertThat(more).isNotNull();
            Map<String, Object> reply = act(tabId, more, "click", null);
            outcomes.add(reply.containsKey("code") ? Json.object(reply, "details").get("reason") : reply.get("reason"));
            assertThat(hits("/hit?victim")).as("try %d: %s", i, reply).isZero();
        }
        assertThat(hits("/hit?victim")).as("%s", outcomes).isZero();
    }

    @Test
    void aFrameSentToANewPageOfItsSiteDuringTheReReadNeverGetsTheClick() throws Exception {
        List<Object> outcomes = new ArrayList<>();
        for (int i = 0; i < 4; i++) {
            String tabId = open("a.test", "/navframe");
            Map<String, Object> more = find(mdoc(tabId), "button", "Read more");
            assertThat(more).isNotNull();
            Map<String, Object> reply = act(tabId, more, "click", null);
            outcomes.add(reply.containsKey("code") ? Json.object(reply, "details").get("reason") : reply.get("reason"));
            Thread.sleep(300);
            assertThat(hits("/hit?victim")).as("try %d: %s", i, reply).isZero();
        }
        assertThat(hits("/hit?victim")).as("%s", outcomes).isZero();
    }

    /**
     * The consent press, on (Security's Ask 1 and T47X-1): an untrusted click on a cookie banner's exact reject, named in
     * the cookie row; never an OAuth "Deny", a box over half the screen, a link off the site, or a banner with no accept.
     */
    @Test
    void theConsentPressMeetsEachOfSecuritysConditions() throws Exception {
        rig.close();
        rig = new BrowserRig(dir, cdpPort, BrowserRig.timing(Duration.ofMillis(250), Duration.ofMinutes(5)));
        rig.module.enableMinified(dir, Clock.systemUTC(), new MinifiedModule.Timing(
                Duration.ofSeconds(10), Duration.ofSeconds(8), Duration.ofSeconds(20), Duration.ofMillis(24), Duration.ofMillis(100),
                Duration.ofSeconds(30)), MinifiedSwitch.fixed(true, false, true));
        client = rig.connect("cs-a");

        String tabId = open("a.test", "/cookies");
        mdoc(tabId);
        // Condition 1: an untrusted el.click(), no dispatched input; condition 4: the cookie row names it.
        await().atMost(Duration.ofSeconds(15)).until(() -> hits("/hit?reject-false") == 1);
        assertThat(hits("/hit?reject-true")).isZero();
        assertThat(hits("/hit?accept")).isZero();
        await().atMost(Duration.ofSeconds(15)).untilAsserted(() ->
                assertThat(Json.object(Json.object(mdoc(tabId), "hidden"), "done")).containsEntry("cookie", "rejected").containsEntry("label", "Reject all"));

        // T47X-1 and conditions 2 and 3: none of these is a cookie banner deskd may answer.
        for (String page : List.of("/oauth", "/bigcookies", "/offcookies", "/noaccept", "/consentword")) {
            String other = open("a.test", page);
            mdoc(other);
            Thread.sleep(2500);
        }
        assertThat(hits("/hit?deny")).isZero();
        assertThat(hits("/hit?bigreject")).isZero();
        assertThat(hits("/elsewhere")).isZero();
        assertThat(hits("/hit?lonereject")).isZero();
        assertThat(hits("/hit?consentdeny")).isZero();
        assertThat(hits("/hit?allow") + hits("/hit?accept")).isZero();
    }

    /**
     * Media verbs on a video in another site's frame (Security's Ask 2, each condition): run in that frame's own world on
     * the video its half picks (the big one, never one the parent names), the frame found by Chromium from the island's
     * iframe, no input and no user activation, the set closed at five verbs, and a refused play() said so.
     */
    @Test
    void mediaVerbsInAnotherSitesFrameMeetSecuritysConditions() throws Exception {
        rig.close();
        rig = new BrowserRig(dir, cdpPort, BrowserRig.timing(Duration.ofMillis(250), Duration.ofMinutes(5)));
        rig.module.enableMinified(dir, Clock.systemUTC(), new MinifiedModule.Timing(
                Duration.ofSeconds(10), Duration.ofSeconds(8), Duration.ofSeconds(20), Duration.ofMillis(24), Duration.ofMillis(100),
                Duration.ofSeconds(30)), MinifiedSwitch.fixed(true, true, false));
        client = rig.connect("cs-a");
        String tabId = open("a.test", "/framevideo");
        Map<String, Object>[] found = new Map[1];
        await().atMost(Duration.ofSeconds(20)).untilAsserted(() -> {
            found[0] = all(mdoc(tabId)).stream().filter(m -> "island".equals(m.get("t")) && m.get("island") != null).findFirst().orElse(null);
            assertThat(found[0]).isNotNull();
        });
        Map<String, Object> island = found[0];
        Map<String, Object> params = new LinkedHashMap<>(Map.of("tabId", tabId, "nodeId", island.get("island"), "action", "media",
                "fp", island.get("fp"), "block", island.get("key"), "rev", mdoc(tabId).get("rev")));
        params.put("value", Map.of("verb", "volume", "volume", 0.3, "muted", false));
        assertThat(rig.call(client, "browser.minified.act", params)).containsEntry("done", true);
        // Conditions 1 and 3: the frame's own pick (the big video), and no gesture claimed.
        await().atMost(Duration.ofSeconds(5)).until(() -> hits("/hit?vol-0.3-1-false") == 1);
        // Condition 4: the set stays closed.
        params.put("value", Map.of("verb", "fullscreen"));
        assertThat(rig.call(client, "browser.minified.act", params)).containsEntry("code", "bad_request");
        // Condition 3: a play() the page refuses (no source here) says so, for "Play on the real page".
        params.put("value", Map.of("verb", "play"));
        assertThat(rig.call(client, "browser.minified.act", params)).containsEntry("done", false).containsEntry("reason", "play_refused");
        assertThat(hits("/hit?frame-input")).isZero();
    }

    /** T47X-2: the site's own alert and its security notice are in the view with their buttons, which work. */
    @Test
    void aSitesOwnAlertAndSecurityNoticeAreKept() throws Exception {
        String tabId = open("a.test", "/notice");
        Map<String, Object> mdoc = mdoc(tabId);
        String json = new String(Json.bytes(mdoc), StandardCharsets.UTF_8);
        assertThat(json).contains("Your session expires in 2 minutes", "Unusual sign-in activity on your account");
        Map<String, Object> stay = find(mdoc, "button", "Stay signed in");
        assertThat(stay).isNotNull().containsKey("node");
        assertThat(act(tabId, stay, "click", null)).containsEntry("done", true);
        await().atMost(Duration.ofSeconds(5)).until(() -> hits("/hit?stay") == 1);
    }

    /** The round-two policy: nothing hidden or covered on the real page gets into the view, and it ends at a paywall. */
    @Test
    void theViewNeverShowsMoreThanTheRealPage() throws Exception {
        String tabId = open("a.test", "/paywall");
        Map<String, Object> mdoc = mdoc(tabId);
        String json = new String(Json.bytes(mdoc), StandardCharsets.UTF_8);
        assertThat(json).contains("Lamps behind a wall", "before the wall comes")
                .doesNotContain("hidden paragraph", "clipped paragraph", "under the wall", "past the wall too");
        List<Map<String, Object>> blocks = blocks(mdoc);
        assertThat(blocks.get(blocks.size() - 1)).containsEntry("t", "paywall");

        // A box the member can close is a nag, never a wall: nothing ends the view.
        Map<String, Object> nag = mdoc(open("a.test", "/nag"));
        assertThat(blocks(nag)).noneSatisfy(b -> assertThat(b).containsEntry("t", "paywall"));
        assertThat(new String(Json.bytes(nag), StandardCharsets.UTF_8)).contains("The paragraph further down");
        Map<String, Object> donate = mdoc(open("a.test", "/donate"));
        assertThat(blocks(donate)).noneSatisfy(b -> assertThat(b).containsEntry("t", "paywall"));
        assertThat(new String(Json.bytes(donate), StandardCharsets.UTF_8)).contains("The paragraph further down");

        // A terms wall needs the member's own yes: the real page, with its own reason.
        String terms = open("a.test", "/terms");
        await().atMost(Duration.ofSeconds(20)).untilAsserted(() ->
                assertThat(Json.object(get(terms), "fallback")).containsEntry("reason", "terms_wall"));

        // An island with a sign-in box over a corner of its video isn't live: overlays are settled first.
        String video = open("a.test", "/videowall");
        Map<String, Object> island = all(mdoc(video)).stream().filter(m -> "island".equals(m.get("t"))).findFirst().orElseThrow();
        Map<String, Object> box = rig.call(client, "browser.minified.island", Map.of("tabId", video, "islandId", island.get("island")), null);
        assertThat(box).containsEntry("live", false).containsEntry("reason", "covered");
        assertThat(((Number) Json.object(box, "rect").get("width")).intValue()).isEqualTo(640);
    }

    // ---- fallbacks and memory

    @Test
    void pagesThatAreBetterAsTheStreamSaySoWithAReason() throws Exception {
        String blank = (String) ((Map<?, ?>) ((List<?>) rig.call(client, "browser.tab.list", Map.of(), null).get("tabs")).get(0)).get("tabId");
        assertThat(Json.object(get(blank), "fallback")).containsEntry("reason", "not_page");

        String canvas = open("a.test", "/canvas");
        await().atMost(Duration.ofSeconds(20)).untilAsserted(() ->
                assertThat(Json.object(get(canvas), "fallback")).containsEntry("reason", "canvas_app"));

        String bank = open("www.chase.com", "/");
        assertThat(get(bank)).containsEntry("view", "stream");
        assertThat(Json.object(get(bank), "fallback")).containsEntry("reason", "sensitive_site");
    }

    @Test
    void theMembersChoiceIsKeptOnTheDeskAndClearedWithHistory() throws Exception {
        String tabId = open("a.test", "/article");
        mdoc(tabId);
        assertThat(rig.call(client, "browser.minified.site.set", Map.of("tabId", tabId, "view", "stream"), null))
                .containsEntry("host", "a.test").containsEntry("view", "stream");
        assertThat(Json.object(get(tabId), "fallback")).containsEntry("reason", "member_choice");
        await().atMost(Duration.ofSeconds(5)).until(() -> Files.exists(dir.resolve("minified-sites.json")));
        assertThat(Files.readString(dir.resolve("minified-sites.json"))).contains("\"a.test\"");

        assertThat(rig.call(client, "browser.minified.sites.clear", Map.of(), null)).containsEntry("_kind", "RES");
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() ->
                assertThat(Files.readString(dir.resolve("minified-sites.json"))).doesNotContain("a.test"));
        assertThat(mdoc(tabId)).isNotNull();
    }

    @Test
    void subscribersHearOfChangesAsPatches() throws Exception {
        String tabId = open("a.test", "/grows");
        mdoc(tabId);
        Map<String, Object> sub = subscribe("browser.minified:" + tabId);
        assertThat(sub).containsEntry("_kind", "RES");
        Map<String, Object> first = client.nextJson(Channels.EVENTS, FrameKind.EVT);
        assertThat(first).containsEntry("type", "snapshot");
        assertThat(Json.object(first, "data")).containsEntry("view", "simplified");
        inPage(tabId, "grow()");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
            Map<String, Object> event = client.nextJson(Channels.EVENTS, FrameKind.EVT);
            assertThat(event.get("type")).isIn("patch", "changed");
            if ("patch".equals(event.get("type"))) {
                assertThat(new String(Json.bytes(event), StandardCharsets.UTF_8)).contains("A brand new paragraph arrived");
            }
        });
    }

    @Test
    void aSiteSetToTheStreamWakesItsParkedWatcherAtOnce() throws Exception {
        // Review 7: a watcher waiting in a page that doesn't change heard nothing of the member's choice for up to the
        // wait's 20 s, and marking a.test didn't mark a tab on www.a.test.
        String tabId = open("www.a.test", "/article");
        mdoc(tabId);
        assertThat(subscribe("browser.minified:" + tabId)).containsEntry("_kind", "RES");
        assertThat(Json.object(client.nextJson(Channels.EVENTS, FrameKind.EVT), "data")).containsEntry("view", "simplified");
        Thread.sleep(1000);
        long asked = System.nanoTime();
        assertThat(rig.call(client, "browser.minified.site.set", Map.of("host", "a.test", "view", "stream"), null)).containsEntry("_kind", "RES");
        Map<String, Object> event = client.nextJson(Channels.EVENTS, FrameKind.EVT);
        assertThat(Json.object(event, "data")).containsEntry("view", "stream");
        assertThat(Duration.ofNanos(System.nanoTime() - asked)).isLessThan(Duration.ofSeconds(5));
    }

    /**
     * The distiller's security pages for T47X-1 to T47X-3 (its tests/security, run.py's checks), through deskd's own path
     * with the consent press on: boxes that say consent or privacy but aren't cookie banners are never pressed or hidden
     * as one, a real banner gets its Reject all, a site's notices are kept, and a form that clobbers DOM names still reads
     * as a sign-in.
     */
    @Test
    void theDistillersSecurityPagesHoldThroughDeskd() throws Exception {
        rig.close();
        rig = new BrowserRig(dir, cdpPort, BrowserRig.timing(Duration.ofMillis(250), Duration.ofMinutes(5)));
        rig.module.enableMinified(dir, Clock.systemUTC(), new MinifiedModule.Timing(
                Duration.ofSeconds(10), Duration.ofSeconds(8), Duration.ofSeconds(20), Duration.ofMillis(24), Duration.ofMillis(100),
                Duration.ofSeconds(30)), MinifiedSwitch.fixed(true, false, true));
        client = rig.connect("cs-a");
        String record = "window.__pressed = []; document.addEventListener('click', (e) => window.__pressed.push(e.target.textContent), true); 1";

        Map<String, String> kept = new LinkedHashMap<>();
        kept.put("oauth", "wants access");
        kept.put("parental", "parent must approve");
        kept.put("esign", "Electronic disclosure");
        kept.put("aem", "Go paperless");
        kept.put("fixed-esign", "Electronic disclosure");
        for (Map.Entry<String, String> page : kept.entrySet()) {
            String tabId = open("a.test", "/sec/" + page.getKey() + ".html");
            inPage(tabId, record);
            Map<String, Object> mdoc = mdoc(tabId);
            Thread.sleep(2500);
            assertThat(new String(Json.bytes(mdoc(tabId)), StandardCharsets.UTF_8)).as(page.getKey()).contains(page.getValue());
            Map<String, Object> hidden = Json.object(mdoc(tabId), "hidden");
            assertThat(hidden == null ? null : hidden.get("done")).as("%s: not a consent entry", page.getKey()).isNull();
            assertThat(inPage(tabId, "JSON.stringify(window.__pressed)")).as("%s: nothing pressed", page.getKey()).contains("[]");
            assertThat(mdoc).isNotNull();
        }

        String cookie = open("a.test", "/sec/cookie.html");
        inPage(cookie, record);
        mdoc(cookie);
        await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> assertThat(Json.object(Json.object(mdoc(cookie), "hidden"), "done"))
                .containsEntry("cookie", "rejected").containsEntry("label", "Reject all"));
        assertThat(inPage(cookie, "JSON.stringify(window.__pressed)")).contains("Reject all").doesNotContain("Accept");

        Map<String, String> notices = Map.of("notice-bar", "Unusual sign-in activity", "notice-alertdialog", "session expires",
                "notice-dialog", "payment failed");
        for (Map.Entry<String, String> page : notices.entrySet()) {
            String tabId = open("a.test", "/sec/" + page.getKey() + ".html");
            assertThat(new String(Json.bytes(mdoc(tabId)), StandardCharsets.UTF_8)).as(page.getKey()).contains(page.getValue());
        }

        String clobber = open("a.test", "/sec/clobber.html");
        await().atMost(Duration.ofSeconds(20)).untilAsserted(() -> {
            Map<String, Object> view = get(clobber);
            assertThat(view).containsEntry("view", "stream");
            assertThat(Json.object(view, "fallback")).containsEntry("reason", "challenge").containsEntry("cause", "sign_in");
        });
    }

    @Test
    void aTermsWallInAnotherSitesFrameOpensTheRealPage() throws Exception {
        String tabId = open("a.test", "/termsframe");
        await().atMost(Duration.ofSeconds(20)).untilAsserted(() -> {
            Map<String, Object> view = get(tabId);
            assertThat(view).as("%s", view).containsEntry("view", "stream").doesNotContainKey("mdoc");
            assertThat(Json.object(view, "fallback")).containsEntry("reason", "terms_wall");
        });
    }

    /**
     * Person checks the distiller lets through (Stack Overflow's on a desk's network, simplified into one block): each
     * opens the real page as {@code challenge}, {@code person_check}, and a real page about checks is still simplified.
     */
    @Test
    void aPersonCheckTheDistillerMissesOpensTheRealPage() throws Exception {
        for (String path : List.of("/so-check", "/cf-check", "/prompt-check", "/widget-check")) {
            String tabId = open("a.test", path);
            await().atMost(Duration.ofSeconds(20)).untilAsserted(() -> {
                Map<String, Object> view = get(tabId);
                assertThat(view).as("%s %s", path, view).containsEntry("view", "stream").doesNotContainKey("mdoc");
                assertThat(Json.object(view, "fallback")).as(path).containsEntry("reason", "challenge").containsEntry("cause", "person_check");
            });
        }
        Map<String, Object> article = mdoc(open("a.test", "/captcha-article"));
        assertThat(new String(Json.bytes(article), StandardCharsets.UTF_8)).contains("Human verification, explained");
    }

    /** A dialog holds the page and only the stream shows it: deskd says so, and never answers it for the member. */
    @Test
    void aDialogIsNeverAnswered() throws Exception {
        String tabId = open("a.test", "/confirm");
        Map<String, Object> delete = find(mdoc(tabId), "button", "Delete");
        Map<String, Object> reply = act(tabId, delete, "click", null);
        assertThat(reply).containsEntry("done", false).containsEntry("reason", "dialog");
        assertThat(Json.object(get(tabId), "fallback")).containsEntry("reason", "dialog");
        Thread.sleep(1000);
        assertThat(Json.object(get(tabId), "fallback")).containsEntry("reason", "dialog");
        onPage(tabId, "Page.handleJavaScriptDialog", Map.of("accept", false));
    }

    // ---- frames that aren't a web page's (the sign-ins work's finding, Nov 11)

    /**
     * A password manager's in-page menu is a frame of its extension's page, which Chromium attaches before its document is
     * known and which then commits to {@code chrome-extension:}. deskd lets it go and holds no session in it: never armed,
     * walked or read, so nothing of it is in any look at the page, and the page's actions refuse while it's there, as
     * for any frame that can't be guarded (T47-3).
     */
    @Test
    void aPasswordManagersMenuFrameIsNeverArmedWalkedOrRead() throws Exception {
        String tabId = open("a.test", "/vault");
        Map<String, Object> mdoc = mdoc(tabId);
        Map<String, Object> more = find(mdoc, "button", "Read more");
        inPage(tabId, "postMessage('show-vault', '*')");
        await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> {
            Map<String, Object> vault = target(t -> "iframe".equals(t.get("type")) && String.valueOf(t.get("url")).startsWith("chrome-extension://"));
            assertThat(vault).as("the menu's frame").isNotNull().containsEntry("type", "iframe");
            assertThat(vault).as("deskd holds no session in it").containsEntry("attached", false);
        });
        Map<String, Object> health = rig.module.minified().health();
        @SuppressWarnings("unchecked")
        Map<String, Object> left = (Map<String, Object>) health.get("framesLeft");
        // Chrome for Testing 156 attaches it with no URL, held before its document is known: it's let go at its commit.
        assertThat(left).as("%s", health).containsEntry("commit", 1L).containsEntry("attach", 0L);
        assertThat(health).containsEntry("frames", 0).containsEntry("framesPending", 0);
        for (int i = 0; i < 3; i++) {
            Map<String, Object> view = get(tabId);
            assertThat(new String(Json.bytes(view), StandardCharsets.UTF_8)).doesNotContain("ann@example.test").doesNotContain("Lamp shop login");
            Thread.sleep(300);
        }
        Map<String, Object> reply = act(tabId, more, "click", null);
        assertThat(reply.get("done")).as("%s", reply).isNotEqualTo(true);
        Thread.sleep(500);
        assertThat(hits("/hit?more")).isZero();
        Thread.sleep(1000);
        assertThat(target(t -> "iframe".equals(t.get("type")) && String.valueOf(t.get("url")).startsWith("chrome-extension://"))).containsEntry("attached", false);
    }

    /** A page's own frame that starts as about:blank and commits to another site's page is guarded and read as before. */
    @Test
    void aBlankFrameThatCommitsToAWebPageIsGuardedAsBefore() throws Exception {
        String tabId = open("a.test", "/blank-frame");
        Map<String, Object> more = find(mdoc(tabId), "button", "Read more");
        inPage(tabId, "postMessage('go', '*')");
        await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> {
            Map<String, Object> frame = target(t -> String.valueOf(t.get("url")).contains("b.test"));
            assertThat(frame).isNotNull().containsEntry("attached", true);
            assertThat(rig.module.minified().health()).containsEntry("frames", 1).containsEntry("framesPending", 0);
        });
        // Attached with no URL too, and guarded once it committed to the other site's page.
        Map<String, Object> health = rig.module.minified().health();
        assertThat(health).as("%s", health).containsEntry("framesGuardedAtCommit", 1L);
        assertThat(health.get("framesLeft")).isEqualTo(Map.of("attach", 0L, "commit", 0L));
        // Armed with the rest, so the press goes through.
        assertThat(act(tabId, more, "click", null)).containsEntry("done", true);
        await().atMost(Duration.ofSeconds(5)).until(() -> hits("/hit?more") == 1);
        assertThat(hits("/hit?allow")).isZero();
    }

    /** The first of Chromium's targets that matches, from the browser's own endpoint, or null. */
    @SuppressWarnings("unchecked")
    private Map<String, Object> target(java.util.function.Predicate<Map<String, Object>> which) throws Exception {
        String browser;
        try (HttpClient http = HttpClient.newHttpClient()) {
            String version = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + cdpPort + "/json/version")).build(),
                    HttpResponse.BodyHandlers.ofString()).body();
            browser = Json.string(Json.parseObject(version.getBytes(StandardCharsets.UTF_8)), "webSocketDebuggerUrl");
        }
        Map<String, Object> reply = Json.parseObject(send(browser, "Target.getTargets", Map.of()).getBytes(StandardCharsets.UTF_8));
        for (Object info : (List<Object>) Json.object(reply, "result").get("targetInfos")) {
            if (which.test((Map<String, Object>) info)) {
                return (Map<String, Object>) info;
            }
        }
        return null;
    }

    // ---- the pre-scroll (round 3)

    /**
     * What a page loads only as it's scrolled to (a thread's later replies, a lazy picture) is in the view's next look,
     * once deskd has scrolled the real page down and back, once per document: back exactly where it was, with no press,
     * key or focus the page could see, and counted in /health.
     */
    @Test
    void thePreScrollBringsInWhatLoadsAsYouScrollAndPutsThePageBackExactly() throws Exception {
        String tabId = open("a.test", "/lazy");
        await().atMost(Duration.ofSeconds(10)).until(() -> Integer.valueOf(137).equals(pageInt(tabId, "scrollY")));
        Map<String, Object> first = mdoc(tabId);
        assertThat(new String(Json.bytes(first), StandardCharsets.UTF_8)).contains("The lamp makers").doesNotContain("A reply that loads");
        assertThat(hits("/lazy.png")).isZero();

        await().atMost(Duration.ofSeconds(10)).untilAsserted(() ->
                assertThat(rig.module.minified().lastPrescroll(tabId).get("outcome")).isEqualTo("done"));
        Map<String, Object> pre = rig.module.minified().lastPrescroll(tabId);
        assertThat(((Number) pre.get("steps")).intValue()).isBetween(2, MinifiedModule.PRESCROLL_SCREENS);
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(new String(Json.bytes(mdoc(tabId)), StandardCharsets.UTF_8))
                .contains("A reply that loads as you scroll, number 3"));
        assertThat(hits("/lazy.png")).isEqualTo(1);
        assertThat(pageInt(tabId, "scrollY")).isEqualTo(137);
        assertThat(pageInt(tabId, "scrollX")).isZero();
        assertThat(pageInt(tabId, "window.__pressed")).as("presses, keys and focus the page saw").isZero();
        assertThat(pageInt(tabId, "window.__scrolls")).isPositive();

        // Once per document: more looks scroll nothing more.
        int scrolls = pageInt(tabId, "window.__scrolls");
        mdoc(tabId);
        Thread.sleep(1500);
        mdoc(tabId);
        assertThat(pageInt(tabId, "window.__scrolls")).isEqualTo(scrolls);
        assertThat(prescrolls()).containsEntry("done", 1L);
    }

    /** A field with focus, a page with a one-time code field, and a feed that never ends: none scrolled past the rules. */
    @Test
    void thePreScrollSkipsAFocusedFieldAndASensitivePageAndStopsAFeedAtItsCap() throws Exception {
        String focused = open("a.test", "/lazy-focus");
        await().atMost(Duration.ofSeconds(10)).until(() -> Integer.valueOf(1).equals(pageInt(focused, "document.activeElement.id === 'reply' ? 1 : 0")));
        mdoc(focused);
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() ->
                assertThat(rig.module.minified().lastPrescroll(focused).get("outcome")).isEqualTo("skipped_focus"));
        assertThat(pageInt(focused, "window.__scrolls")).isZero();

        String coded = open("a.test", "/lazy-code");
        // The page's own scroll to 137 px, and its scroll event, which comes a frame later: the only one it sees.
        await().atMost(Duration.ofSeconds(10)).until(() -> Integer.valueOf(137).equals(pageInt(coded, "scrollY"))
                && Integer.valueOf(1).equals(pageInt(coded, "window.__scrolls")));
        int own = pageInt(coded, "window.__scrolls");
        assertThat(mdoc(coded)).containsEntry("sensitive", true);
        Thread.sleep(MinifiedModule.PRESCROLL_AFTER.toMillis() + 1500);
        assertThat(rig.module.minified().lastPrescroll(coded)).isEmpty();
        assertThat(pageInt(coded, "window.__scrolls")).isEqualTo(own);
        assertThat(pageInt(coded, "scrollY")).isEqualTo(137);

        // a.test showed a sensitive signal, so it stays sensitive for the session (T47-7): the feed is another site's.
        String feed = open("b.test", "/feed");
        mdoc(feed);
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() ->
                assertThat(rig.module.minified().lastPrescroll(feed).get("outcome")).isEqualTo("capped"));
        Map<String, Object> pre = rig.module.minified().lastPrescroll(feed);
        assertThat(pre).containsEntry("grew", true);
        assertThat(((Number) pre.get("steps")).intValue()).isLessThanOrEqualTo(MinifiedModule.PRESCROLL_SCREENS);
        assertThat(pageInt(feed, "scrollY")).isZero();
        assertThat(pageInt(feed, "window.__pressed")).isZero();
        assertThat(prescrolls()).containsEntry("skipped_focus", 1L).containsEntry("capped", 1L);
    }

    /**
     * Security's S-111 Low 3: a code field that comes in a component's open shadow root after the view's look, before the
     * pre-scroll starts. deskd's view (looked at before) didn't see it, so the page's own check is the gate here: it looks
     * into shadow roots as the view's scan does, and nothing scrolls.
     */
    @Test
    void thePreScrollSeesASensitiveFieldInAShadowRoot() throws Exception {
        String tabId = open("a.test", "/lazy-shadow");
        await().atMost(Duration.ofSeconds(10)).until(() -> Integer.valueOf(137).equals(pageInt(tabId, "scrollY"))
                && Integer.valueOf(1).equals(pageInt(tabId, "window.__scrolls")));
        int own = pageInt(tabId, "window.__scrolls");
        assertThat(mdoc(tabId)).doesNotContainEntry("sensitive", true);
        // At once, well inside PRESCROLL_AFTER, and with no look after it: deskd's own sensitive signal stays false.
        assertThat(pageInt(tabId, "(() => { const r = document.getElementById('host').attachShadow({ mode: 'open' });"
                + " r.innerHTML = '<label>Code <input autocomplete=\"one-time-code\"></label>'; return 1; })()")).isEqualTo(1);
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() ->
                assertThat(rig.module.minified().lastPrescroll(tabId).get("outcome")).isEqualTo("skipped_sensitive"));
        assertThat(pageInt(tabId, "window.__scrolls")).isEqualTo(own);
        assertThat(pageInt(tabId, "scrollY")).isEqualTo(137);
        assertThat(pageInt(tabId, "window.__pressed")).isZero();
    }

    /** The member acts while the page is being scrolled: it goes back at once, and the action runs. */
    @Test
    void anActionStopsThePreScrollAndRunsOnThePageWhereItWas() throws Exception {
        String feed = open("a.test", "/feed");
        Map<String, Object> mark = find(mdoc(feed), "button", "Mark all read");
        await().atMost(Duration.ofSeconds(10)).pollInterval(Duration.ofMillis(20)).until(() -> pageInt(feed, "window.__scrolls") > 0);
        assertThat(act(feed, mark, "click", null)).containsEntry("done", true);
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() ->
                assertThat(rig.module.minified().lastPrescroll(feed).get("outcome")).isEqualTo("stopped"));
        assertThat(((Number) rig.module.minified().lastPrescroll(feed).get("steps")).intValue()).isLessThan(MinifiedModule.PRESCROLL_SCREENS);
        assertThat(pageInt(feed, "window.__marked")).isEqualTo(1);
        assertThat(pageInt(feed, "scrollY")).isZero();
    }

    // ---- round 3's distiller rules

    /** A page's own display settings drop, never Filters; a shop's size picker stays. */
    @Test
    void aPagesOwnDisplaySettingsDropAndASizePickerStays() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/r3/appearance"));
        String json = new String(Json.bytes(mdoc), StandardCharsets.UTF_8);
        assertThat(json).doesNotContain("Automatic").doesNotContain("\"Wide\"").doesNotContain("Standard");
        assertThat(all(mdoc)).anySatisfy(run -> assertThat(run).containsEntry("r", "check").containsEntry("label", "Medium"));
    }

    /** A column of the page's own section links is its Contents, and a CSS filter class names no filters. */
    @Test
    @SuppressWarnings("unchecked")
    void aPagesOwnContentsAndACssFilterClassAreNeverFilters() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/r3/toc"));
        List<Map<String, Object>> menus = new ArrayList<>();
        for (Map<String, Object> block : blocks(mdoc)) {
            if (block.get("menus") instanceof List<?> list) {
                list.forEach(m -> menus.add((Map<String, Object>) m));
            }
        }
        assertThat(menus).as("%s", menus).noneSatisfy(m -> assertThat(m).containsEntry("kind", "filters"));
        assertThat(menus).anySatisfy(m -> assertThat(m).containsEntry("kind", "contents"));
    }

    /** The page's h1 in one tile of a store's grid is that tile's: the rest are still the cards. */
    @Test
    void aGridTileHoldingThePagesTitleLeavesTheRestAsCards() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/r3/grid"));
        int cards = 0;
        for (Map<String, Object> block : blocks(mdoc)) {
            if ("cards".equals(block.get("t")) && block.get("items") instanceof List<?> items) {
                cards += items.size();
            }
        }
        assertThat(cards).as("%s", blocks(mdoc)).isGreaterThanOrEqualTo(8);
    }

    /** An engine's shopping ads, their click ids URL-encoded inside its own redirect, drop as sponsored. */
    @Test
    void shoppingAdsBehindAnEnginesRedirectAreSponsored() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/r3/engine"));
        String json = new String(Json.bytes(mdoc), StandardCharsets.UTF_8);
        assertThat(json).contains("The best desk lamps, review 5").doesNotContain("Shopping ad lamp");
    }

    /** A definition continues its term: one item, the signature and then what it says. */
    @Test
    void aDefinitionContinuesItsTerm() throws Exception {
        List<Map<String, Object>> blocks = blocks(mdoc(open("a.test", "/r3/defs")));
        int term = -1;
        for (int i = 0; i < blocks.size(); i++) {
            if (new String(Json.bytes(blocks.get(i)), StandardCharsets.UTF_8).contains("class datetime.timedelta")) {
                term = i;
            }
        }
        assertThat(term).isNotNegative();
        assertThat(blocks.get(term + 1)).containsEntry("t", "item").containsEntry("cont", true);
        assertThat(new String(Json.bytes(blocks.get(term + 1)), StandardCharsets.UTF_8)).contains("All arguments are optional");
    }

    /** The view's text, as one string: every block's words and links, in order. */
    private static String text(Map<String, Object> mdoc) {
        return new String(Json.bytes(mdoc.get("blocks")), StandardCharsets.UTF_8);
    }

    /**
     * Round 4: a Discourse topic's cloaked posts come back from the topic the page already holds, parsed inert (nothing
     * runs or loads from them), each under its author; never a whisper, and never a post its box doesn't name.
     */
    @Test
    void aForumsCloakedPostsAreReadFromItsOwnTopicAndNothingLoads() throws Exception {
        String tabId = open("a.test", "/t/lamps/123");
        Map<String, Object> mdoc = mdoc(tabId);
        String json = text(mdoc);
        assertThat(json).contains("a reply from the topic's own data", "Bob Day")
                .doesNotContain("A whisper only", "names someone else", "690x388", "lamp.png");
        assertThat(json.indexOf("a reply from the topic's own data")).isGreaterThan(json.indexOf("Which desk lamp lasts?"));
        Thread.sleep(500);
        assertThat(hits("/hit?cooked") + hits("/hit?img") + hits("/hit?onerror")).isZero();
    }

    /**
     * Round 4: a repo's About is its facts (description, website, six topics then "+N", one line of stars, watchers and
     * forks), not its resource links, and its file list shows ten rows, the rest folded; the README follows.
     */
    @Test
    void aReposAboutIsItsFactsAndItsFileListFolds() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/r4/repo"));
        String json = text(mdoc);
        assertThat(json).contains("A kit for lamps of every kind.", "9.9k stars \u00b7 61 watching \u00b7 6.8k forks", " +3", "Show all 15 files")
                .doesNotContain("Resources", "Report repository", "MIT license", "topic-7");
        List<Map<String, Object>> tables = blocks(mdoc).stream().filter(b -> "table".equals(b.get("t")) && !Boolean.TRUE.equals(b.get("grouped"))).toList();
        assertThat(tables).isNotEmpty();
        assertThat((List<?>) tables.get(0).get("rows")).hasSizeLessThanOrEqualTo(11);
        assertThat(json.indexOf("Install")).isGreaterThan(json.indexOf("Show all 15 files"));
    }

    /** Round 4: a forum's announcement banner the member can dismiss is one short line, never its list before the page. */
    @Test
    void aDismissibleBannerIsOneShortLine() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/r4/banner"));
        String json = text(mdoc);
        assertThat(json).contains("Is the lamp safe?", "A security incident").doesNotContain("tool number 7");
        Map<String, Object> line = blocks(mdoc).stream().filter(b -> new String(Json.bytes(b), StandardCharsets.UTF_8).contains("A security incident"))
                .findFirst().orElseThrow();
        assertThat(new String(Json.bytes(line.get("runs")), StandardCharsets.UTF_8).length()).isLessThan(600);
    }

    /** Round 4: a long filter rail at the side folds into Filters, and a heading holding only "Sort by" titles nothing. */
    @Test
    void aLongFilterRailFoldsAndASortControlNeverTitlesThePage() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/r4/rail"));
        List<Map<String, Object>> blocks = blocks(mdoc);
        Map<String, Object> title = blocks.stream().filter(b -> "heading".equals(b.get("t")) && Integer.valueOf(1).equals(b.get("level"))).findFirst().orElseThrow();
        assertThat(new String(Json.bytes(title), StandardCharsets.UTF_8)).contains("results for desk lamp");
        for (Map<String, Object> b : blocks) {
            if (!"filters".equals(b.get("t")) && !"controls".equals(b.get("t")) && !"bar".equals(b.get("t"))) {
                assertThat(new String(Json.bytes(b), StandardCharsets.UTF_8)).as("%s", b).doesNotContain("Filter group 12");
            }
        }
        assertThat(blocks.stream().filter(b -> "cards".equals(b.get("t"))).mapToInt(b -> ((List<?>) b.get("items")).size()).sum()).isGreaterThanOrEqualTo(8);
    }

    /** Round 4: an engine's result that is one link of its site, crumbs and title is a card titled by its own title. */
    @Test
    void anEnginesCrumbedResultIsACardByItsTitle() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/r4/crumbs"));
        List<String> titles = new ArrayList<>();
        for (Map<String, Object> b : blocks(mdoc)) {
            if ("cards".equals(b.get("t"))) {
                for (Object it : (List<?>) b.get("items")) {
                    titles.add(String.valueOf(((Map<?, ?>) ((Map<?, ?>) it).get("title")).get("text")));
                }
            }
        }
        assertThat(titles).hasSizeGreaterThanOrEqualTo(6).contains("The best desk lamps of the year, review 1");
    }

    /** Round 4: a row of cards whose own links carry an ad's click id drops, inside the results' column too. */
    @Test
    void cardsWhoseLinksCarryAnAdsClickIdDrop() throws Exception {
        String json = text(mdoc(open("a.test", "/r4/adrow")));
        assertThat(json).contains("Brass desk lamp number 3").doesNotContain("Shopping ad lamp", "hvadid");
    }

    /** Round 4: a bot check drawn over a page (its own box, "Press & hold") opens the real page, as any person check. */
    @Test
    void aBotCheckDrawnOverAPageIsAPersonCheck() throws Exception {
        String tabId = open("a.test", "/r4/check");
        await().atMost(Duration.ofSeconds(20)).untilAsserted(() -> {
            Map<String, Object> view = get(tabId);
            assertThat(view).containsEntry("view", "stream");
            assertThat(Json.object(view, "fallback")).containsEntry("reason", "challenge").containsEntry("cause", "person_check");
        });
    }

    /** Round 4: a long page of which the view keeps almost nothing (placeholders still drawing) opens as the real page. */
    @Test
    void aLongPageTheViewKeepsAlmostNothingOfFallsBack() throws Exception {
        String tabId = open("a.test", "/r4/skeleton");
        await().atMost(Duration.ofSeconds(20)).untilAsserted(() -> {
            Map<String, Object> view = get(tabId);
            assertThat(view).containsEntry("view", "stream");
            assertThat(Json.object(view, "fallback")).containsEntry("reason", "low_confidence");
        });
    }

    /** Round 4: a player that draws its own poster over a video with none gives the island that poster. */
    @Test
    void aPlayersOwnDrawnPosterIsTheIslandsStill() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/r4/player"));
        Map<String, Object> island = blocks(mdoc).stream().filter(b -> "island".equals(b.get("t"))).findFirst().orElseThrow();
        assertThat(Json.object(island, "media")).containsKey("poster");
    }

    /**
     * Round 4: a docs page's breadcrumbs are one line, and its Copy page button, its own contents list and its headings'
     * anchors stay out of the reading; code drawn a box per line reads once per line.
     */
    @Test
    void aDocsPagesFurnitureStaysOutOfItsReading() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/r4/docs"));
        List<Map<String, Object>> blocks = blocks(mdoc);
        String reading = new String(Json.bytes(blocks.stream().filter(b -> !Set.of("controls", "bar", "filters").contains(b.get("t"))).toList()),
                StandardCharsets.UTF_8);
        assertThat(reading).contains("useLamp", "API Reference", "Hooks").doesNotContain("Link for", "Copy page", "Troubleshooting", "Updating a lamp");
        Map<String, Object> crumbs = blocks.stream().filter(b -> new String(Json.bytes(b), StandardCharsets.UTF_8).contains("API Reference")).findFirst().orElseThrow();
        assertThat(new String(Json.bytes(crumbs), StandardCharsets.UTF_8)).contains("Hooks");
        Map<String, Object> code = blocks.stream().filter(b -> "code".equals(b.get("t"))).findFirst().orElseThrow();
        assertThat((String) code.get("text")).contains("line one\nline two").doesNotContain("line one\n\nline two");
    }

    /**
     * Round 4: a listing's popular filters (pictured links back to the listing) are filters, a "Popular filters" heading
     * titles nothing, and a carousel of deals whose pictures haven't drawn yet is still cards.
     */
    @Test
    void aStoresFiltersAreFiltersAndItsUndrawnDealsAreCards() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/r4/store"));
        List<String> titles = new ArrayList<>();
        for (Map<String, Object> b : blocks(mdoc)) {
            if ("cards".equals(b.get("t"))) {
                for (Object it : (List<?>) b.get("items")) {
                    titles.add(String.valueOf(((Map<?, ?>) ((Map<?, ?>) it).get("title")).get("text")));
                }
            }
        }
        assertThat(titles).contains("Ceramic table lamp number 3 with a linen shade", "Brass desk lamp number 5").noneMatch(t -> t.startsWith("Brand chip"));
        Map<String, Object> title = blocks(mdoc).stream().filter(b -> "heading".equals(b.get("t")) && Integer.valueOf(1).equals(b.get("level"))).findFirst().orElseThrow();
        assertThat(new String(Json.bytes(title), StandardCharsets.UTF_8)).contains("desk lamp").doesNotContain("Popular filters", "Deals based");
    }

    /** Round 4: an engine's related searches and its feedback line, each a list labeled by its first item, drop. */
    @Test
    void anEnginesRelatedSearchesAndFeedbackDrop() throws Exception {
        String json = text(mdoc(open("a.test", "/r4/related")));
        assertThat(json).contains("The best desk lamps, review 5").doesNotContain("related lamp search 3", "Was this helpful");
    }

    /** The view's reading: every block but the site's row and its menus, as one string. */
    private static String reading(Map<String, Object> mdoc) {
        return new String(Json.bytes(blocks(mdoc).stream().filter(b -> !Set.of("controls", "bar", "filters").contains(b.get("t"))).toList()),
                StandardCharsets.UTF_8);
    }

    /** The site row's menus, as one string. */
    private static String menus(Map<String, Object> mdoc) {
        return new String(Json.bytes(blocks(mdoc).stream().filter(b -> "controls".equals(b.get("t"))).map(b -> b.get("menus")).toList()),
                StandardCharsets.UTF_8);
    }

    /**
     * Round 5: a site's header drawn with no landmarks (Hacker News' table row) joins the menu, its Sign in the site row;
     * a comment's lone ▲ is the vote control; and a list of the site's sections just after a title joins the menu too,
     * as a player's controls drawn as links to the page itself drop.
     */
    @Test
    void aSitesHeaderWithoutLandmarksJoinsTheMenu() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/r5/header"));
        assertThat(reading(mdoc)).contains("A lamp that lasts", "288 points").doesNotContain("\"past\"", "\"newest\"", "/login");
        assertThat(menus(mdoc)).contains("past", "ask");
        assertThat(new String(Json.bytes(blocks(mdoc).stream().filter(b -> "controls".equals(b.get("t"))).map(b -> b.get("runs")).toList()),
                StandardCharsets.UTF_8)).contains("login");
        assertThat(all(mdoc.get("blocks"))).anyMatch(r -> "vote".equals(r.get("r")) && r.containsKey("up") && "".equals(r.get("score")));

        Map<String, Object> nav = mdoc(open("a.test", "/r5/navlist"));
        assertThat(reading(nav)).contains("Big Lamp").doesNotContain("BLOG", "JOBS", "Click to mute", "Fullscreen view");
        assertThat(menus(nav)).contains("BLOG");
    }

    /**
     * Round 5: a list's own tools are filters or drop: a row of menu buttons over the results is Filters, its density
     * switches go, a results module's chips led by All are filters, and an engine's Copy, Feedback and app promo go.
     */
    @Test
    void aListsOwnToolsAreFiltersOrDrop() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/r5/listing"));
        assertThat(reading(mdoc)).contains("The best desk lamps of the year, review 3").doesNotContain("Milestones", "display density", "r/desks", "More boards",
                "Copy to clipboard", "Share Feedback", "Scan to get the app");
        assertThat(menus(mdoc)).contains("Milestones", "r/desks");
    }

    /**
     * Round 5: a shop's product reads as it shows: the price drawn for the eye once (never its screen-reader twin), the
     * gallery's first photo at its size, swatches by their colour, no read time, and a read-only rich text box as text.
     */
    @Test
    void aProductReadsAsItShows() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/r5/product"));
        String reading = reading(mdoc);
        assertThat(reading).contains("$19.99", "\"Navy\"", "\"Mist\"", "A review that reads as text").doesNotContain("Price $ 19.99", "Navy swatch");
        assertThat(reading.indexOf("$19.99")).isEqualTo(reading.lastIndexOf("$19.99"));
        assertThat(blocks(mdoc).stream().filter(b -> "image".equals(b.get("t")))).hasSize(1);
        assertThat(all(mdoc.get("blocks"))).noneMatch(r -> "field".equals(r.get("r")));
        assertThat(mdoc).doesNotContainKey("article");
    }

    /**
     * Round 5: a forecast reads in its own order: the current conditions floated beside the title stay before the days,
     * and the days, tiles that sell nothing, are a list each with its picture and its line.
     */
    @Test
    void aForecastsConditionsComeFirstAndItsDaysAreAList() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/r5/forecast"));
        String reading = reading(mdoc);
        assertThat(reading.indexOf("57°F")).isPositive().isLessThan(reading.indexOf("Extended Forecast"));
        assertThat(reading.indexOf("Humidity")).isLessThan(reading.indexOf("Detailed Forecast"));
        Map<String, Object> days = blocks(mdoc).stream().filter(b -> "cards".equals(b.get("t"))).findFirst().orElseThrow();
        assertThat(days).containsEntry("layout", "list");
        Map<?, ?> first = (Map<?, ?>) ((List<?>) days.get("items")).get(0);
        assertThat(first.containsKey("image")).isTrue();
        assertThat(String.valueOf(first.get("meta"))).contains("High: 61");
    }

    /**
     * Round 5: a front page's story reads once: its covering link goes and its headline is the link, its kicker is a
     * quiet line, a lone comment count goes, and a fundraiser's ask with amounts to pick is hidden.
     */
    @Test
    void aFrontPagesStoryReadsOnce() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/r5/front"));
        String reading = reading(mdoc);
        String headline = "Headline number 2 about the lamps of the world";
        assertThat(reading.indexOf(headline)).isPositive().isEqualTo(reading.lastIndexOf(headline));
        assertThat(reading).doesNotContain("2315", "Support once", "no paywall here");
        Map<String, Object> h = blocks(mdoc).stream().filter(b -> "heading".equals(b.get("t")) && new String(Json.bytes(b), StandardCharsets.UTF_8)
                .contains(headline)).findFirst().orElseThrow();
        assertThat(all(h.get("runs"))).anyMatch(r -> "link".equals(r.get("r")));
        assertThat(blocks(mdoc)).noneMatch(b -> "heading".equals(b.get("t")) && new String(Json.bytes(b), StandardCharsets.UTF_8).contains("\"Lamps\""));
    }

    /**
     * Round 5: a recipe's rating, times and yield stay under its title, out of the folded story; its cooks' photos with
     * no names are a row of pictures, never a card titled "4,927"; and a lone Filter button is no Filters menu.
     */
    @Test
    void aRecipesFactsStayOutOfTheStory() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/r5/recipe"));
        String reading = reading(mdoc);
        assertThat(reading).contains("\u2605 4.6 (19,336) \u00b7 Prep 20 min \u00b7 Cook 10 min \u00b7 Total 30 min \u00b7 Serves 48");
        assertThat(reading.indexOf("Prep 20 min")).isLessThan(reading.indexOf("The story before the recipe"));
        assertThat(blocks(mdoc)).noneMatch(b -> "cards".equals(b.get("t")));
        assertThat(menus(mdoc)).doesNotContain("Filters");
    }

    /**
     * Round 5: a link aggregator's stories keep their score, tags once, by-line and comment count, and its "Page 2" in a nav
     * of its own is the page's next link at the list's end.
     */
    @Test
    void storiesKeepTheirScoreAndCountsAndTheListItsNextPage() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/r5/stories"));
        Map<String, Object> cards = blocks(mdoc).stream().filter(b -> "cards".equals(b.get("t"))).findFirst().orElseThrow();
        Map<?, ?> first = (Map<?, ?>) ((List<?>) cards.get("items")).get(0);
        assertThat(String.valueOf(first.get("meta"))).contains("\u25b2 31", "authored by ann", "11 comments").doesNotContain("[ask,", ", devops,");
        assertThat(all(mdoc.get("blocks"))).anyMatch(r -> "link".equals(r.get("r")) && Boolean.TRUE.equals(r.get("next")));
    }

    /**
     * Round 5: an engine's result reads its snippet, never its address line; an ad module's searches drop; its own
     * answer among the results, named by its source's domain, is its answer, not a result; and its AI overview, a sentence
     * broken into lines around a link, is one answer block.
     */
    @Test
    void anEnginesSnippetsAnswerAndAdSearchesReadRight() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/r5/engine"));
        String reading = reading(mdoc);
        assertThat(reading).doesNotContain("Find related products", "https://b.test ›");
        assertThat(blocks(mdoc)).anyMatch(b -> "answer".equals(b.get("t")) && new String(Json.bytes(b), StandardCharsets.UTF_8).contains("wide coverage"));
        Map<String, Object> cards = blocks(mdoc).stream().filter(b -> "cards".equals(b.get("t"))).findFirst().orElseThrow();
        Map<?, ?> first = (Map<?, ?>) ((List<?>) cards.get("items")).get(0);
        assertThat(String.valueOf(first.get("snippet"))).contains("reading rooms");
        Map<String, Object> overview = blocks(mdoc).stream().filter(b -> "answer".equals(b.get("t")) && "AI Overview".equals(b.get("label"))).findFirst().orElseThrow();
        assertThat(new String(Json.bytes(overview.get("runs")), StandardCharsets.UTF_8)).contains("The", "BenQ e-Reading lamp", "is widely ranked")
                .doesNotContain("Show more");
    }

    /** Round 5: a side menu's links to the page's own sections are its Contents, and a callout's title leads its words. */
    @Test
    void aSideMenusOwnSectionsAreContentsAndACalloutLeadsItsWords() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/r5/docs"));
        Map<String, Object> controls = blocks(mdoc).stream().filter(b -> "controls".equals(b.get("t"))).findFirst().orElseThrow();
        assertThat((List<?>) controls.get("menus")).anyMatch(m -> "contents".equals(((Map<?, ?>) m).get("kind"))
                && new String(Json.bytes(m), StandardCharsets.UTF_8).contains("Section 3"));
        assertThat(reading(mdoc)).contains("Tip:").doesNotContain("\"Tip\"");
    }

    /** Round 5: a page's full-width player in a short window is its island; a lazy picture nothing will scroll to is no box. */
    @Test
    void aWidePlayerIsAnIslandAndAPictureThatWontLoadIsNoBox() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/r5/hero"));
        assertThat(blocks(mdoc)).anyMatch(b -> "island".equals(b.get("t")));
        assertThat(reading(mdoc)).doesNotContain("A far lamp");
    }

    /**
     * Round 5: a run of a shop tile's leftovers between a listing's cards (delivery lines, Add to cart, a count) goes, and a
     * card's bare count says what it counts by its own label ("5 reviews").
     */
    @Test
    void aShopTilesLeftoversBetweenItsCardsGo() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/r5/debris"));
        assertThat(reading(mdoc)).contains("Brass desk lamp model 3", "5 reviews").doesNotContain("Join Prime", "Non-members", "Add to cart");
    }

    /**
     * Round 5: the site's name as a heading over a post's title is the site row's; a post's reaction counts with no word
     * drop, as a list's page numbers stay; a shop's row labelled Sponsored drops with its advertiser; and links that each
     * apply a filter are Filters.
     */
    @Test
    void aMastheadReactionCountsSponsoredRowAndFilterLinksLeaveTheReading() throws Exception {
        Map<String, Object> post = mdoc(open("a.test", "/r5/post"));
        // (round 6: and its lone Table of Contents goes)
        assertThat(reading(post)).contains("Your lamp review", "\"Next\"", "\"2\"").doesNotContain("Lamp Letters", "\"189\"", "\"200\"", "Table of Contents");
        Map<String, Object> shop = mdoc(open("a.test", "/r5/sponsored"));
        assertThat(reading(shop)).contains("The best desk lamps of the year, review 2").doesNotContain("Promoted lamp", "Lamp Shop", "apply Popular Filters");
        assertThat(menus(shop)).contains("Wood - apply Popular Filters filter");
    }

    /**
     * Round 6: an engine's results under a long answer are a listing, never an article; each result's snippet is whole
     * with its query's bold words, its address line and a lone path of crumbs are no snippet or meta, and the engine's
     * own chat buttons, logo, sponsored toggle and a "Next" set as a heading leave the reading.
     */
    @Test
    void anEnginesResultsUnderALongAnswerAreCardsWithWholeSnippets() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/r6/engine?q=desk+lamp+reviews"));
        assertThat(mdoc).containsEntry("kind", "page");
        List<?> items = (List<?>) blocks(mdoc).stream().filter(b -> "cards".equals(b.get("t"))).findFirst().orElseThrow().get("items");
        Map<?, ?> first = (Map<?, ?>) items.get(0);
        assertThat(String.valueOf(first.get("snippet"))).startsWith("The best desk lamps come in many styles");
        assertThat(String.valueOf(first.get("meta"))).contains("Lamp Review").doesNotContain("www.b.test");
        assertThat(first.containsKey("chips")).isFalse();
        Map<?, ?> forum = (Map<?, ?>) items.stream().filter(x -> String.valueOf(x).contains("Need a desk lamp")).findFirst().orElseThrow();
        assertThat(String.valueOf(forum)).doesNotContain("need_a_desk_lamp_recommendation");
        assertThat(reading(mdoc)).doesNotContain("New thread", "Settings", "Hide sponsored result", "Go to Lamp Search home");
        assertThat(blocks(mdoc)).noneMatch(b -> "heading".equals(b.get("t")) && String.valueOf(b.get("runs")).contains("Next"));
    }

    /**
     * Round 6: a shop's listing reads as its results: its grid drawn as rows of short lists is one grid of every product
     * but the sponsored one; a carousel whose subtitle says it's sponsored (spelled with a format character), a promotion
     * strip, tile and line, a deals carousel, its header's lines, its filter heading and links named for a screen reader,
     * its tools, a feedback ask, a newsletter, a tile's noise and a card's carousel buttons leave the reading, and a
     * product's facts are its meta.
     */
    @Test
    void aShopsListingIsItsResults() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/r6/shop?st=desk+lamp"));
        String reading = reading(mdoc);
        assertThat(reading).contains("Brass desk lamp, row one 1", "Brass desk lamp, row two 1", "Brass desk lamp, row three 4", "Copper table lamp number 6",
                "Iron table lamp number 1")
                .doesNotContain("Deals for every list", "Ship to 12345", "cart 0 items", "Popular Filters", "apply Popular Filters", "Save this search",
                        "Picked For You", "Picked lamp", "Top selling items", "previous slide", "Sponsored lamp", "Holiday baking", "Deals based on your search",
                        "Deal lamp", "Tell us about your search", "Get top deals", "Sign up", "Price, product page", "bought in last month", "Rating 4.9 out of 5",
                        "\"+4\"", "\"1k+\"", "Go To End", "Next Page", "Lamps on sale");
        assertThat(menus(mdoc)).contains("Wood", "Ship to 12345");
        List<Map<String, Object>> grids = blocks(mdoc).stream().filter(b -> "cards".equals(b.get("t")) && String.valueOf(b.get("items")).contains("Brass desk lamp")).toList();
        assertThat(grids).hasSize(1);
        assertThat((List<?>) grids.get(0).get("items")).hasSize(10);
        Map<?, ?> facts = (Map<?, ?>) ((List<?>) grids.get(0).get("items")).stream().filter(x -> String.valueOf(x).contains("row two 1")).findFirst().orElseThrow();
        assertThat(String.valueOf(facts.get("meta"))).contains("or Best Offer", "Free delivery");
        assertThat(facts.containsKey("snippet")).isFalse();
        List<Map<String, Object>> copper = blocks(mdoc).stream().filter(b -> "cards".equals(b.get("t")) && String.valueOf(b.get("items")).contains("Copper")).toList();
        assertThat(copper).hasSize(1);
        assertThat((List<?>) copper.get(0).get("items")).hasSize(6);
    }

    /**
     * Round 6: an issue list's sibling pages are no breadcrumbs, its Open and Closed tabs are one line, an issue's number
     * in this repository and "opened" read with its date, and a footer drawn without a landmark joins the menu.
     */
    @Test
    void anIssueListsTabsAndMetaReadAsOneLineAndItsFooterJoinsTheMenu() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/r6/repo/issues"));
        assertThat(blocks(mdoc)).noneMatch(b -> "meta".equals(b.get("t")) && String.valueOf(b.get("runs")).contains("Milestones"));
        assertThat(blocks(mdoc)).anyMatch(b -> "para".equals(b.get("t")) && String.valueOf(b.get("runs")).contains("Open 22") && String.valueOf(b.get("runs")).contains("Closed 18,478"));
        Map<?, ?> first = (Map<?, ?>) ((List<?>) blocks(mdoc).stream().filter(b -> "cards".equals(b.get("t"))).findFirst().orElseThrow().get("items")).get(0);
        assertThat(String.valueOf(first.get("meta"))).contains("#41", "opened on Nov 11, 2026");
        assertThat(reading(mdoc)).doesNotContain("r6/repo#41", "All rights reserved", "Contact sales", "day and night");
        assertThat(menus(mdoc)).contains("Contact sales", "Privacy");
    }

    /**
     * Round 6: a post's byline lines are one quiet line, its lone Table of Contents and a word's pronunciation button go,
     * a product's swatches are one line of their colours, and a reference's way back up goes.
     */
    @Test
    void aPostsBylineSwatchesAndReferencesReadQuietly() throws Exception {
        Map<String, Object> mdoc = mdoc(open("a.test", "/r6/post"));
        assertThat(blocks(mdoc)).anyMatch(b -> "meta".equals(b.get("t")) && String.valueOf(b.get("runs")).contains("ANN WRITER") && String.valueOf(b.get("runs")).contains("Nov 06, 2026"));
        assertThat(blocks(mdoc)).anyMatch(b -> String.valueOf(b.get("runs")).contains("Light blue") && String.valueOf(b.get("runs")).contains("Navy"));
        assertThat(reading(mdoc)).contains("The lamps of the world").doesNotContain("Table of Contents", "Play audio", "Jump up", "View Ann Writer");
    }

    /**
     * Round 6: a store's grid that goes blank for a moment while it draws its rows again, at the same length, keeps the view
     * it had (never the real page for "too little"), and the view follows the grid when it's drawn again.
     */
    @Test
    void aGridDrawingItsRowsAgainKeepsItsView() throws Exception {
        String tabId = open("a.test", "/r6/redraw");
        assertThat(reading(mdoc(tabId))).contains("Brass desk lamp number 3");
        inPage(tabId, "blank()");
        Thread.sleep(3000);
        Map<String, Object> held = get(tabId);
        assertThat(held).containsEntry("view", "simplified");
        assertThat(reading(Json.object(held, "mdoc"))).contains("Brass desk lamp number 3");
        inPage(tabId, "fill('Copper')");
        await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> assertThat(reading(mdoc(tabId))).contains("Copper desk lamp number 3"));
    }

    /**
     * S-111: a view held for a long page gone blank goes, to the real page, as the app moves to another route in the same
     * document, by the History API or by its fragment alone, long before the hold's cap: never the last route's view.
     */
    @Test
    void aHeldViewGoesWithAnAppsRouteChange() throws Exception {
        aHeldViewGoesWith("history.pushState({}, '', '/r6/redraw?route=2')");
    }

    @Test
    void aHeldViewGoesWithARouteChangeByFragment() throws Exception {
        aHeldViewGoesWith("location.hash = '#/sent'");
    }

    private void aHeldViewGoesWith(String routeChange) throws Exception {
        String tabId = open("a.test", "/r6/redraw");
        assertThat(reading(mdoc(tabId))).contains("Brass desk lamp number 3");
        // Watched, so a get answers what deskd holds without a look of its own.
        assertThat(subscribe("browser.minified:" + tabId)).containsEntry("_kind", "RES");
        inPage(tabId, "blank()");
        Thread.sleep(1000);
        assertThat(get(tabId)).containsEntry("view", "simplified");

        // The hold's cap would end it some 4 s from here: this is the route change's doing.
        long changed = System.nanoTime();
        inPage(tabId, routeChange);
        await().atMost(Duration.ofSeconds(10)).until(() -> !"simplified".equals(get(tabId).get("view")));
        assertThat(Duration.ofNanos(System.nanoTime() - changed)).isLessThan(Duration.ofMillis(2500));
        assertThat(get(tabId)).containsEntry("view", "stream");
    }

    /** S-111: a route change before the page goes blank leaves no view to hold, as that view was of the last route. */
    @Test
    void aViewOfTheLastRouteIsNeverHeld() throws Exception {
        String tabId = open("a.test", "/r6/redraw");
        assertThat(reading(mdoc(tabId))).contains("Brass desk lamp number 3");
        inPage(tabId, "history.pushState({}, '', '/r6/redraw?route=2')");
        inPage(tabId, "blank()");
        Thread.sleep(1000);
        Map<String, Object> after = get(tabId);
        assertThat(after).containsEntry("view", "stream");
        assertThat(Json.object(after, "fallback")).containsEntry("reason", "low_confidence");
    }

    /** S-111: a page that stays blank, unchanged, gets the real page once the hold's 5 s are up, with nothing else to say so. */
    @Test
    void aHeldViewLastsFiveSecondsAtMost() throws Exception {
        String tabId = open("a.test", "/r6/redraw");
        assertThat(reading(mdoc(tabId))).contains("Brass desk lamp number 3");
        assertThat(subscribe("browser.minified:" + tabId)).containsEntry("_kind", "RES");
        long blanked = System.nanoTime();
        inPage(tabId, "blank()");
        Thread.sleep(1500);
        assertThat(get(tabId)).containsEntry("view", "simplified");
        await().atMost(Duration.ofSeconds(15)).until(() -> "stream".equals(get(tabId).get("view")));
        Duration held = Duration.ofNanos(System.nanoTime() - blanked);
        assertThat(held).isGreaterThan(Duration.ofSeconds(4)).isLessThan(Duration.ofSeconds(9));
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> prescrolls() {
        return (Map<String, Object>) rig.module.minified().health().get("prescroll");
    }

    /** A number the page's own world says, or null. */
    private Integer pageInt(String tabId, String expression) throws Exception {
        Map<String, Object> reply = Json.parseObject(inPage(tabId, expression).getBytes(StandardCharsets.UTF_8));
        Object value = Json.object(Json.object(reply, "result"), "result").get("value");
        return value instanceof Number n ? n.intValue() : null;
    }

    private Map<String, Object> subscribe(String topic) throws Exception {
        long id = 77_000;
        client.sendJson(Channels.RPC, FrameKind.SUB, id, Map.of("topic", topic, "params", Map.of()));
        return client.nextReply();
    }
}
