package com.minimalistalliance.desk.agent.maia;

import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.agent.service.Caller;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * A desk with Maia Mode for tests: the real {@code AgentService} and {@code Team} on temporary files ({@link TeamDesk}),
 * a scripted model behind her service ({@code FakeMaiaService}), and {@link MaiaDeskd} as deskd. {@link #on()} turns
 * Maia Mode on as the room's first-run sheet does: the setting with the disclosure and her access saved from the member's
 * session. She needs no key.
 */
final class MaiaDesk implements AutoCloseable {

    static final String TAB = "tab-maia";
    static final String HOME = "d-home1";
    static final String WORK = "d-work1";
    static final String PERSONAL = "d-pers1";

    final TeamDesk desk;
    final MaiaDeskd deskd = new MaiaDeskd();
    final List<Map<String, Object>> rooms = new CopyOnWriteArrayList<>();
    final Path data;

    MaiaDesk(Path data, MutableClock clock) throws Exception {
        this.data = data;
        this.desk = new TeamDesk(data, clock);
        // Her model: deskd's relay and her service on Minimalist Alliance's account, answered by the scripted model.
        deskd.service = new com.minimalistalliance.desk.agent.testing.FakeMaiaService(desk.provider);
        desk.service.deskLink(deskd);
        desk.topics.subscribe(77, MaiaMode.TOPIC, Map::of, (topic, seq, type, room) -> {
            if (!room.isEmpty()) {
                rooms.add(room);
            }
        });
    }

    MaiaDesk(Path data) throws Exception {
        this(data, new MutableClock(Rig.START));
    }

    /** Maia Mode on and her access saved: the first-run sheet. Her model is the company's: no key. */
    void on() throws Exception {
        list();
        call("agent.maia.set", "on", true, "disclosure", MaiaMode.DISCLOSURE, "notesTabId", TAB, "homeDeskId", HOME);
        Map<String, Object> apps = new LinkedHashMap<>();
        apps.put("notebook", true);
        apps.put("files", false);
        apps.put("browser", false);
        apps.put("courier", false);
        apps.put("todos", true);
        Map<String, Object> auto = new LinkedHashMap<>();
        auto.put("notebook", Map.of("tabId", TAB));
        auto.put("files", null);
        auto.put("todos", true);
        desk.service.call("agent.access.set", Map.of("agentId", MaiaAgent.ID, "apps", apps, "auto", auto),
                Caller.OWNER);
    }

    /** This desk listed for Maia Mode: its switch says on (API.md §23; the owner's desk's rollout writes it). */
    void list() throws java.io.IOException {
        java.nio.file.Files.writeString(data.resolve(MaiaMode.SWITCH_FILE), "on\n");
    }

    Map<String, Object> call(String method, Object... pairs) throws Exception {
        return desk.service.call(method, TeamDesk.m(pairs), Caller.OWNER);
    }

    RpcError refused(String method, Object... pairs) {
        try {
            desk.service.call(method, TeamDesk.m(pairs), Caller.OWNER);
        } catch (RpcError e) {
            return e;
        } catch (Exception e) {
            throw new AssertionError(e);
        }
        throw new AssertionError(method + " wasn't refused");
    }

    /** One desk as the office would observe it. */
    static Map<String, Object> deskSeen(String deskId, String name, Object... more) {
        Map<String, Object> d = TeamDesk.m("deskId", deskId, "name", name, "kind", "work", "state", "running",
                "link", "open");
        d.putAll(TeamDesk.m(more));
        return d;
    }

    void observe(Map<String, Object>... desks) throws Exception {
        call("agent.maia.observe", "desks", List.of(desks));
    }

    Map<String, Object> room() throws Exception {
        return desk.service.snapshotFor(MaiaMode.TOPIC).get();
    }

    @SuppressWarnings("unchecked")
    static List<Map<String, Object>> items(Map<String, Object> room) {
        return (List<Map<String, Object>>) ((Map<String, Object>) room.get("todo")).get("items");
    }

    /** Maia's grant for a desk, as the member's grant sheet makes it. */
    void grant(String deskId, String name, boolean keeps, String... scopes) throws Exception {
        call("agent.maia.grant.set", "deskId", deskId, "deskName", name, "scopes", List.of(scopes), "keepsToItself",
                keeps);
    }

    void awaitQuiet() {
        await().pollDelay(Duration.ofMillis(50)).atMost(Duration.ofSeconds(15)).until(() -> true);
    }

    @Override
    public void close() {
        desk.close();
    }
}
