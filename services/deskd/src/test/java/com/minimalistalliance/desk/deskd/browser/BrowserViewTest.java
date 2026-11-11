package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.FakeCdp;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The phone view ({@link BrowserView}, API.md section 10, "On a phone"): which session the tabs follow, what's set on them
 * over CDP and when, the field the topic tells of, a pinch and a tap's question. The whole Browser module, through clients'
 * frames, against FakeCdp, which answers deskd's scripts as this test says.
 */
class BrowserViewTest {

    private static final BrowserView.Timing QUICK =
            new BrowserView.Timing(Duration.ofMillis(100), Duration.ofMillis(500), Duration.ofMillis(200), Duration.ofMillis(800));
    private static final Map<String, Object> PHONE = Map.of("kind", "phone", "width", 390, "height", 844);
    /** 1080 / 844, to two places, down: what 390x844 gets on a 1920x1080 window. */
    private static final double SCALE = 1.27;
    private static final Duration A_WHILE = Duration.ofSeconds(10);
    private static final String METRICS = "Emulation.setDeviceMetricsOverride";
    private static final String CLEAR = "Emulation.clearDeviceMetricsOverride";
    private static final String TOUCH = "Emulation.setTouchEmulationEnabled";
    private static final String MOUSE_AS_TOUCH = "Emulation.setEmitTouchEventsForMouse";
    private static final String CALL = "Runtime.callFunctionOn";

    @TempDir
    Path dir;

    private FakeCdp cdp;
    private BrowserRig rig;
    private volatile Object pageScale = 1;
    private volatile Object tapFinds;

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            rig.close();
        }
        if (cdp != null) {
            cdp.close();
        }
    }

    private void start(BrowserView.Timing timing, String... pages) throws Exception {
        cdp = new FakeCdp();
        for (String page : pages) {
            cdp.addPage(page, "https://example.com/" + page, "Title " + page);
        }
        cdp.answer("Browser.getWindowForTarget", command -> Map.of(
                "windowId", 1, "bounds", Map.of("left", 0, "top", 0, "width", 1920, "height", 1080, "windowState", "fullscreen")));
        cdp.answer(CALL, this::script);
        rig = new BrowserRig(dir, cdp.port(), BrowserRig.FAST);
        rig.module.view().timing(timing);
    }

    /** What deskd's scripts answer in the page, by which constant it sent. */
    private Object script(FakeCdp.Command command) {
        String function = Json.string(command.params(), "functionDeclaration");
        Object value = null;
        if (ViewScripts.SAVE.equals(function)) {
            value = true;
        } else if (ViewScripts.RESTORE.equals(function)) {
            value = "anchor";
        } else if (ViewScripts.ARM.equals(function)) {
            value = "armed";
        } else if (ViewScripts.PAGE_SCALE.equals(function)) {
            value = pageScale;
        } else if (ViewScripts.AT.equals(function)) {
            value = tapFinds;
        }
        Map<String, Object> result = new HashMap<>();
        result.put("type", value == null ? "object" : "string");
        result.put("value", value);
        return Map.of("result", result);
    }

    private void looks(TestClient client, boolean seen, Map<String, Object> device) throws Exception {
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("seen", seen);
        if (device != null) {
            params.put("device", device);
        }
        assertThat(rig.call(client, "desk.attention.set", params, null)).containsEntry("_kind", "RES");
    }

    private void stream(TestClient client, String state) throws Exception {
        assertThat(rig.call(client, "browser.stream.set", Map.of("state", state), null))
                .containsEntry("_kind", "RES")
                .containsEntry("state", state);
    }

    /** A phone, live, looking, with its device: the start of most of these. */
    private TestClient phoneLooks() throws Exception {
        TestClient phone = rig.connect("cs-phone");
        stream(phone, "live");
        looks(phone, true, PHONE);
        return phone;
    }

    private List<FakeCdp.Command> on(String method, String tab) {
        String session = FakeCdp.sessionOf(tab);
        return cdp.commands(method).stream().filter(command -> session.equals(command.sessionId())).toList();
    }

    private List<FakeCdp.Command> scripts(String constant, String tab) {
        return on(CALL, tab).stream().filter(command -> constant.equals(Json.string(command.params(), "functionDeclaration"))).toList();
    }

    private void awaitPhoneOn(String... tabs) {
        await().atMost(A_WHILE).untilAsserted(() -> {
            for (String tab : tabs) {
                assertThat(on(METRICS, tab)).isNotEmpty();
                assertThat(on(MOUSE_AS_TOUCH, tab)).isNotEmpty();
            }
        });
    }

    /** Every tab has the phone's view, which the topic says only once it's so. */
    private void awaitShown() {
        await().atMost(A_WHILE).until(() -> "phone".equals(rig.module.view().state().get("mode")));
    }

    private void awaitDeskOn(String... tabs) {
        await().atMost(A_WHILE).untilAsserted(() -> {
            for (String tab : tabs) {
                assertThat(on(CLEAR, tab)).isNotEmpty();
            }
        });
    }

    /** The next browser.view snapshot that matches, passing over the rest. */
    private Map<String, Object> awaitView(TestClient client, Predicate<Map<String, Object>> wanted) throws Exception {
        long deadline = System.nanoTime() + A_WHILE.toNanos();
        while (System.nanoTime() < deadline) {
            Frame frame = rig.fake.pollFrame(client.handle(), Channels.EVENTS, 100);
            if (frame == null) {
                continue;
            }
            Map<String, Object> data = Json.object(TestClient.parse(frame.payload()), "data");
            if (data != null && data.containsKey("mode") && wanted.test(data)) {
                return data;
            }
        }
        throw new AssertionError("no such browser.view");
    }

    private static boolean phoneMode(Map<String, Object> view) {
        return "phone".equals(view.get("mode"));
    }

    private static boolean deskMode(Map<String, Object> view) {
        return "desktop".equals(view.get("mode"));
    }

    private void bindingFrom(String tab, String payload) {
        cdp.event("Runtime.bindingCalled", Map.of("name", ViewScripts.BINDING, "payload", payload, "executionContextId", 9),
                FakeCdp.sessionOf(tab));
    }

    private void input(String sessionId) {
        rig.fake.sendJson(Map.of("t", "input.activity", "sessionId", sessionId, "at", Instant.now().toString()));
    }

    private static Map<String, Object> described(String kind, String enterKey) {
        Map<String, Object> field = new HashMap<>();
        field.put("kind", kind);
        field.put("enterKey", enterKey);
        return field;
    }

    private static int norm(double pixels, int side) {
        return (int) Math.round(65535 * pixels / side);
    }

    // ---- a phone joining and leaving

    @Test
    void aPhoneThatLooksGetsItsViewOnEveryTabAndTheTopicSaysWhere() throws Exception {
        start(QUICK, "a", "b");
        TestClient phone = rig.connect("cs-phone");
        assertThat(phone.subscribe("browser.view", null)).containsEntry("_kind", "RES");
        assertThat(awaitView(phone, BrowserViewTest::deskMode)).containsEntry("field", null);
        stream(phone, "live");
        looks(phone, true, PHONE);

        Map<String, Object> view = awaitView(phone, BrowserViewTest::phoneMode);
        assertThat(view)
                .containsEntry("sessionId", "cs-phone")
                .containsEntry("width", 390)
                .containsEntry("height", 844)
                .containsEntry("scale", SCALE)
                .containsEntry("region", Map.of("x", 0, "y", 0, "width", 495, "height", 1072))
                .containsEntry("screen", Map.of("width", 1920, "height", 1080));
        awaitPhoneOn("a", "b");
        Map<String, Object> metrics = on(METRICS, "a").get(0).params();
        assertThat(metrics)
                .containsEntry("width", 390)
                .containsEntry("height", 844)
                .containsEntry("deviceScaleFactor", SCALE)
                .containsEntry("scale", SCALE)
                .containsEntry("mobile", true)
                .containsEntry("screenWidth", 390)
                .containsEntry("screenHeight", 844)
                .containsEntry("screenOrientation", Map.of("type", "portraitPrimary", "angle", 0));
        assertThat(on(TOUCH, "b").get(0).params()).containsEntry("enabled", true).containsEntry("maxTouchPoints", 5);
        assertThat(on(MOUSE_AS_TOUCH, "b").get(0).params()).containsEntry("enabled", true).containsEntry("configuration", "mobile");
        // The focus watch is in each tab's world, with the binding added to that world alone.
        await().atMost(A_WHILE).untilAsserted(() -> {
            for (String tab : List.of("a", "b")) {
                assertThat(scripts(ViewScripts.ARM, tab)).isNotEmpty();
                // The Browser's own protected-media watch adds a binding of its own to the tab too.
                assertThat(on("Runtime.addBinding", tab))
                        .filteredOn(command -> ViewScripts.BINDING.equals(command.params().get("name")))
                        .isNotEmpty()
                        .allSatisfy(command -> assertThat(command.params()).containsKey("executionContextId"));
            }
        });
        // Only the tab on screen keeps its place, and it says so around the change.
        String onScreen = scripts(ViewScripts.SAVE, "a").isEmpty() ? "b" : "a";
        assertThat(scripts(ViewScripts.SAVE, onScreen)).hasSize(1);
        assertThat(scripts(ViewScripts.RESTORE, onScreen)).hasSize(1);
        assertThat(scripts(ViewScripts.SAVE, onScreen.equals("a") ? "b" : "a")).isEmpty();
        assertThat(cdp.commands("Emulation.setUserAgentOverride")).isEmpty();
        assertThat(((Map<?, ?>) rig.module.health().get("browser")).get("view")).isEqualTo("phone");
    }

    @Test
    void thePhoneLeavingGivesTheDeskItsOwnViewBack() throws Exception {
        start(QUICK, "a", "b");
        TestClient desk = rig.connect("cs-desk");
        assertThat(desk.subscribe("browser.view", null)).containsEntry("_kind", "RES");
        stream(desk, "live");
        looks(desk, true, null);
        phoneLooks();
        awaitView(desk, BrowserViewTest::phoneMode);
        awaitPhoneOn("a", "b");

        rig.sessions.close("cs-phone", 1000, "closed_by_client");

        awaitView(desk, BrowserViewTest::deskMode);
        awaitDeskOn("a", "b");
        assertThat(on(TOUCH, "a")).last().satisfies(command -> assertThat(command.params()).containsEntry("enabled", false));
        assertThat(on(MOUSE_AS_TOUCH, "a")).last().satisfies(command -> assertThat(command.params()).containsEntry("enabled", false));
    }

    @Test
    void aPhoneThatTurnsToTheSimplifiedViewOrLooksAwayLetsTheDeskHaveItsView() throws Exception {
        start(QUICK, "a");
        TestClient desk = rig.connect("cs-desk");
        stream(desk, "live");
        looks(desk, true, null);
        TestClient phone = phoneLooks();
        awaitShown();

        // warm is the simplified view, which reads the desk's own layout, so it doesn't vote.
        stream(phone, "warm");
        awaitDeskOn("a");

        cdp.clearCommands();
        stream(phone, "live");
        awaitPhoneOn("a");
        awaitShown();

        cdp.clearCommands();
        looks(phone, false, PHONE);
        awaitDeskOn("a");
    }

    @Test
    void withNobodyLeftLookingTheViewIsTheDesksAndNoConnectionIsMadeForIt() throws Exception {
        start(QUICK, "a");
        TestClient phone = phoneLooks();
        assertThat(phone.subscribe("browser.view", null)).containsEntry("_kind", "RES");
        awaitView(phone, BrowserViewTest::phoneMode);
        int connections = cdp.upgrades();

        looks(phone, false, PHONE);

        awaitView(phone, BrowserViewTest::deskMode);
        // Nothing wants Chromium now, so the connection goes, and the sessions Chromium drops take the view with them.
        await().atMost(A_WHILE).until(() -> !cdp.isConnected());
        assertThat(cdp.upgrades()).isEqualTo(connections);
    }

    @Test
    void aTabOpenedWhileThePhoneLooksGetsItsView() throws Exception {
        start(QUICK, "a");
        TestClient phone = phoneLooks();
        awaitPhoneOn("a");
        Map<String, Object> opened = rig.call(phone, "browser.tab.open", Map.of("url", "https://example.com/new"));
        String tabId = (String) opened.get("tabId");
        awaitPhoneOn(tabId);
        await().atMost(A_WHILE).untilAsserted(() -> assertThat(scripts(ViewScripts.ARM, tabId)).isNotEmpty());
        // A new tab isn't the one the member was reading, so there's no place to keep.
        assertThat(scripts(ViewScripts.SAVE, tabId)).isEmpty();
    }

    @Test
    void aLostConnectionPutsTheViewBackOnTheTabsThatReturn() throws Exception {
        start(QUICK, "a");
        phoneLooks();
        awaitPhoneOn("a");
        cdp.clearCommands();

        // Chromium drops what each session had set, so deskd sets it again on the new ones.
        cdp.dropConnections();

        awaitPhoneOn("a");
        assertThat(on(CLEAR, "a")).isEmpty();
    }

    // ---- a desktop taking over

    @Test
    void aDesktopsInputTakesTheViewBackButOnlyAfterTheGap() throws Exception {
        BrowserView.Timing gap = new BrowserView.Timing(Duration.ofMillis(100), Duration.ofMillis(1500), Duration.ofMillis(200), Duration.ofMillis(800));
        start(gap, "a");
        TestClient desk = rig.connect("cs-desk");
        stream(desk, "live");
        looks(desk, true, Map.of("kind", "desktop"));
        TestClient phone = phoneLooks();
        assertThat(phone.subscribe("browser.view", null)).containsEntry("_kind", "RES");
        awaitView(phone, BrowserViewTest::phoneMode);
        awaitPhoneOn("a");

        // The desktop saying again what it said before is nothing new.
        looks(desk, true, Map.of("kind", "desktop"));
        input("cs-desk");

        await().during(Duration.ofMillis(600)).atMost(Duration.ofSeconds(5)).until(() -> on(CLEAR, "a").isEmpty());
        awaitView(phone, BrowserViewTest::deskMode);
        awaitDeskOn("a");

        // And the phone's next touch takes it back.
        cdp.clearCommands();
        input("cs-phone");
        awaitView(phone, BrowserViewTest::phoneMode);
        awaitPhoneOn("a");
    }

    @Test
    void aDesktopThatOnlySaysItLooksDoesntTakeItFromThePhoneThatLookedLater() throws Exception {
        start(QUICK, "a");
        TestClient desk = rig.connect("cs-desk");
        stream(desk, "live");
        looks(desk, true, null);
        phoneLooks();
        awaitPhoneOn("a");

        looks(desk, true, null);

        await().during(Duration.ofMillis(600)).atMost(Duration.ofSeconds(5)).until(() -> on(CLEAR, "a").isEmpty());
    }

    // ---- debouncing

    @Test
    void flipsWithinTheSettleTimeComeToOneChangeOnEachTab() throws Exception {
        BrowserView.Timing slow = new BrowserView.Timing(Duration.ofMillis(700), Duration.ofMillis(500), Duration.ofMillis(200), Duration.ofMillis(800));
        start(slow, "a", "b");
        TestClient phone = rig.connect("cs-phone");
        stream(phone, "live");
        // A phone turned on its side and back, quickly.
        looks(phone, true, PHONE);
        looks(phone, true, Map.of("kind", "phone", "width", 844, "height", 390));
        looks(phone, true, PHONE);

        awaitPhoneOn("a", "b");
        await().during(Duration.ofMillis(800)).atMost(Duration.ofSeconds(5)).until(() -> on(METRICS, "a").size() == 1);
        assertThat(on(METRICS, "a").get(0).params()).containsEntry("width", 390).containsEntry("height", 844);
        assertThat(on(METRICS, "b")).hasSize(1);
    }

    @Test
    void aTurnOnItsSideIsANewSizeAtANewScaleWithNoGap() throws Exception {
        BrowserView.Timing gap = new BrowserView.Timing(Duration.ofMillis(100), Duration.ofSeconds(30), Duration.ofMillis(200), Duration.ofMillis(800));
        start(gap, "a");
        TestClient phone = phoneLooks();
        awaitPhoneOn("a");

        looks(phone, true, Map.of("kind", "phone", "width", 844, "height", 390));

        await().atMost(A_WHILE).until(() -> on(METRICS, "a").size() == 2);
        // min(1920 / 844, 1080 / 390) is 2.27.
        assertThat(on(METRICS, "a").get(1).params())
                .containsEntry("width", 844)
                .containsEntry("height", 390)
                .containsEntry("deviceScaleFactor", 2.27)
                .containsEntry("screenOrientation", Map.of("type", "landscapePrimary", "angle", 90));
    }

    @Test
    void aBadDeviceIsRefusedAndChangesNothing() throws Exception {
        start(QUICK, "a");
        TestClient phone = rig.connect("cs-phone");
        for (Object device : List.of(
                Map.of("kind", "phone", "width", 10, "height", 844),
                Map.of("kind", "phone", "width", 390),
                Map.of("kind", 7),
                "phone")) {
            Map<String, Object> reply = rig.call(phone, "desk.attention.set", Map.of("seen", true, "device", device), null);
            assertThat(reply).containsEntry("_kind", "ERR").containsEntry("code", "bad_request");
            assertThat(reply.get("details")).isEqualTo(Map.of("reason", "device"));
        }
        assertThat(rig.call(phone, "desk.attention.set", Map.of("seen", false), null)).containsEntry("seen", false);
        // Any other kind is the desk's own view, so a client can say what it is.
        looks(phone, true, Map.of("kind", "tablet", "width", 1024, "height", 768));
        stream(phone, "live");
        await().during(Duration.ofMillis(500)).atMost(Duration.ofSeconds(5)).until(() -> cdp.commands(METRICS).isEmpty());
    }

    // ---- touch: a pinch, and what a tap would focus

    @Test
    void aPinchGoesToTheTabOnScreenAtThePhonesScaleAndThePagesZoom() throws Exception {
        start(QUICK, "a");
        TestClient phone = phoneLooks();
        awaitShown();
        pageScale = 0.5;

        Map<String, Object> reply = rig.call(phone, "browser.pinch", Map.of("x", 32768, "y", 16384, "scale", 2));

        assertThat(reply).containsEntry("_kind", "RES");
        List<FakeCdp.Command> pinches = on("Input.synthesizePinchGesture", "a");
        assertThat(pinches).hasSize(1);
        Map<String, Object> gesture = pinches.get(0).params();
        assertThat(((Number) gesture.get("x")).doubleValue()).isCloseTo(32768.0 / 65535 * 1920 / SCALE / 0.5, within(0.01));
        assertThat(((Number) gesture.get("y")).doubleValue()).isCloseTo(16384.0 / 65535 * 1080 / SCALE / 0.5, within(0.01));
        assertThat(gesture).containsEntry("scaleFactor", 2.0).containsEntry("gestureSourceType", "mouse");
    }

    @Test
    void aPinchOnTheDesksOwnViewIsInScreenPixels() throws Exception {
        start(QUICK, "a");
        TestClient desk = rig.connect("cs-desk");
        stream(desk, "live");
        looks(desk, true, null);

        assertThat(rig.call(desk, "browser.pinch", Map.of("x", 65535, "y", 0, "scale", 0.5))).containsEntry("_kind", "RES");

        Map<String, Object> gesture = on("Input.synthesizePinchGesture", "a").get(0).params();
        assertThat(((Number) gesture.get("x")).doubleValue()).isCloseTo(1920, within(0.01));
        assertThat(((Number) gesture.get("y")).doubleValue()).isCloseTo(0, within(0.01));
        assertThat(gesture).containsEntry("scaleFactor", 0.5).doesNotContainKey("relativeSpeed");
    }

    // ---- the simplified view

    @Test
    void theSimplifiedViewInUseGetsTheDesksOwnViewAtOnceAndThePhonesComesBackAfter() throws Exception {
        BrowserView.Timing gap = new BrowserView.Timing(Duration.ofMillis(100), Duration.ofSeconds(30), Duration.ofMillis(200), Duration.ofMillis(800));
        start(gap, "a");
        phoneLooks();
        awaitShown();

        // It reads the desk's own layout and clicks with CDP's mouse, so it can't wait out the 30 s gap.
        rig.module.view().simplified(true);
        awaitDeskOn("a");

        cdp.clearCommands();
        rig.module.view().simplified(false);
        rig.module.view().timing(QUICK);
        awaitPhoneOn("a");
    }

    @Test
    void aPinchNeedsInputAndSaneNumbers() throws Exception {
        start(QUICK, "a");
        TestClient phone = phoneLooks();
        TestClient watcher = rig.connect("cs-watch", true, false);
        assertThat(rig.call(watcher, "browser.pinch", Map.of("x", 1, "y", 1, "scale", 2)))
                .containsEntry("code", "forbidden");
        assertThat(rig.call(phone, "browser.pinch", Map.of("x", 1, "y", 1, "scale", 9)))
                .containsEntry("code", "bad_request")
                .containsEntry("details", Map.of("reason", "scale"));
        assertThat(rig.call(phone, "browser.pinch", Map.of("x", 70000, "y", 1, "scale", 2)))
                .containsEntry("details", Map.of("reason", "x"));
        assertThat(rig.call(phone, "browser.pinch", Map.of("x", 1, "y", 1.5, "scale", 2)))
                .containsEntry("details", Map.of("reason", "y"));
        assertThat(cdp.commands("Input.synthesizePinchGesture")).isEmpty();
    }

    @Test
    void fieldAtSaysWhatATapWouldFocusInTheViewsOwnPixels() throws Exception {
        start(QUICK, "a");
        TestClient phone = phoneLooks();
        awaitShown();
        tapFinds = Map.of("k", "email_address", "e", "next");

        Map<String, Object> reply = rig.call(phone, "browser.field.at", Map.of("x", 32768, "y", 65535), null);

        assertThat(reply).containsEntry("_kind", "RES").containsEntry("field", Map.of("kind", "email_address", "enterKey", "next"));
        List<?> args = (List<?>) scripts(ViewScripts.AT, "a").get(0).params().get("arguments");
        assertThat(((Number) ((Map<?, ?>) args.get(0)).get("value")).doubleValue()).isCloseTo(32768.0 / 65535 * 1920 / SCALE, within(0.01));
        assertThat(((Number) ((Map<?, ?>) args.get(1)).get("value")).doubleValue()).isCloseTo(1080 / SCALE, within(0.01));

        tapFinds = null;
        assertThat(rig.call(phone, "browser.field.at", Map.of("x", 1, "y", 1), null)).containsEntry("field", null);
        // A page can't put a word of its own through.
        tapFinds = Map.of("k", "<b>", "e", "next");
        assertThat(rig.call(phone, "browser.field.at", Map.of("x", 1, "y", 1), null)).containsEntry("field", null);
        tapFinds = Map.of("k", "plain", "e", "launch");
        assertThat(rig.call(phone, "browser.field.at", Map.of("x", 1, "y", 1), null))
                .containsEntry("field", described("plain", null));
        assertThat(rig.call(phone, "browser.field.at", Map.of("x", -1, "y", 1), null)).containsEntry("code", "bad_request");
        TestClient blind = rig.connect("cs-blind", false, true);
        assertThat(rig.call(blind, "browser.field.at", Map.of("x", 1, "y", 1), null)).containsEntry("code", "forbidden");
    }

    // ---- the focus event

    @Test
    void aFocusedFieldInTheTabOnScreenIsToldOnTheTopic() throws Exception {
        start(QUICK, "a", "b");
        TestClient phone = phoneLooks();
        assertThat(phone.subscribe("browser.view", null)).containsEntry("_kind", "RES");
        awaitView(phone, BrowserViewTest::phoneMode);
        awaitPhoneOn("a", "b");

        bindingFrom("a", "{\"v\":1,\"f\":{\"k\":\"email_address\",\"e\":\"next\",\"b\":[10,100,300,40]}}");

        Map<String, Object> view = awaitView(phone, data -> data.get("field") != null);
        assertThat(view.get("field")).isEqualTo(Map.of(
                "tabId", "a",
                "kind", "email_address",
                "enterKey", "next",
                "box", Map.of(
                        "x", norm(10 * SCALE, 1920),
                        "y", norm(100 * SCALE, 1080),
                        "width", norm(300 * SCALE, 1920),
                        "height", norm(40 * SCALE, 1080))));

        // A hidden tab's word doesn't touch it, and neither does a call that isn't deskd's binding.
        bindingFrom("b", "{\"v\":0,\"f\":null}");
        cdp.event("Runtime.bindingCalled", Map.of("name", "other", "payload", "{\"v\":1,\"f\":null}", "executionContextId", 9),
                FakeCdp.sessionOf("a"));
        bindingFrom("a", "not json");
        bindingFrom("a", "{\"v\":1,\"f\":{\"k\":\"plain\",\"e\":null,\"b\":[1,2,3]}}".repeat(20));
        assertThat(rig.fake.pollFrame(phone.handle(), Channels.EVENTS, 400)).isNull();

        // Focus leaving the field says so.
        bindingFrom("a", "{\"v\":1,\"f\":null}");
        awaitView(phone, data -> phoneMode(data) && data.get("field") == null);

        // A new page in the tab ends what was focused, and the watch goes into the new document.
        bindingFrom("a", "{\"v\":1,\"f\":{\"k\":\"plain\",\"e\":null,\"b\":[0,0,10,10]}}");
        awaitView(phone, data -> data.get("field") != null);
        int armed = scripts(ViewScripts.ARM, "a").size();
        cdp.navigateInPage("a", "https://example.com/next", "Next");
        awaitView(phone, data -> phoneMode(data) && data.get("field") == null);
        await().atMost(A_WHILE).until(() -> scripts(ViewScripts.ARM, "a").size() > armed);
    }

    @Test
    void noFieldIsToldWithTheDesksOwnView() throws Exception {
        start(QUICK, "a");
        TestClient desk = rig.connect("cs-desk");
        assertThat(desk.subscribe("browser.view", null)).containsEntry("_kind", "RES");
        awaitView(desk, BrowserViewTest::deskMode);
        stream(desk, "live");
        looks(desk, true, null);
        await().atMost(A_WHILE).until(() -> !cdp.commands("Target.attachToTarget").isEmpty());

        bindingFrom("a", "{\"v\":1,\"f\":{\"k\":\"plain\",\"e\":null,\"b\":[0,0,10,10]}}");

        assertThat(rig.fake.pollFrame(desk.handle(), Channels.EVENTS, 400)).isNull();
        assertThat(rig.module.view().state()).containsEntry("mode", "desktop").containsEntry("field", null);
    }

    @Test
    void theTopicNeedsVideo() throws Exception {
        start(QUICK, "a");
        TestClient blind = rig.connect("cs-blind", false, true);
        assertThat(blind.subscribe("browser.view", null)).containsEntry("_kind", "ERR").containsEntry("code", "forbidden");
    }
}
