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
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
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
            if (path.equals("/pic.png")) {
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
        return switch (path) {
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

    private void startChromium() throws IOException {
        chromium = new ProcessBuilder(
                        System.getenv("DESKD_CHROMIUM_BIN"),
                        "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                        "--noerrdialogs", "--disable-breakpad", "--password-store=basic", "--window-size=1280,800",
                        "--user-data-dir=" + dir.resolve("profile"),
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
        try (HttpClient http = HttpClient.newHttpClient()) {
            CompletableFuture<String> reply = new CompletableFuture<>();
            StringBuilder text = new StringBuilder();
            WebSocket socket = http.newWebSocketBuilder()
                    .buildAsync(URI.create("ws://127.0.0.1:" + cdpPort + "/devtools/page/" + targetId), new WebSocket.Listener() {
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

    private Map<String, Object> subscribe(String topic) throws Exception {
        long id = 77_000;
        client.sendJson(Channels.RPC, FrameKind.SUB, id, Map.of("topic", topic, "params", Map.of()));
        return client.nextReply();
    }
}
