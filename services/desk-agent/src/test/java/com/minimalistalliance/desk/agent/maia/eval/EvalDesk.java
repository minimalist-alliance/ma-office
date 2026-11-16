package com.minimalistalliance.desk.agent.maia.eval;

import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.agent.maia.MaiaAgent;
import com.minimalistalliance.desk.agent.maia.MaiaMode;
import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.service.Caller;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.testing.FakeProvider;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A desk with Maia Mode on, for the evals (the maia test package's {@code MaiaDesk}, copied for package access): the
 * real agent service on temporary files ({@link TeamDesk}), a scripted stand-in model, {@link EvalDeskd} as deskd, and
 * Maia Mode turned on as the room's first-run sheet does it.
 *
 * <p><b>The stand-in model is shared</b> by her runs and her note-taker's side call, which run at once. So the note
 * taker's request waits until her run's scripted steps are all taken ({@link #routeTaker}): the taker always gets the
 * last step scripted (or the stand-in's default text, which holds no notes), and her run the ones before it.
 */
public final class EvalDesk implements AutoCloseable {

    public static final String TAB = "tab-maia";
    public static final String HOME = "d-home1";
    public static final String WORK = "d-work1";
    public static final String PERSONAL = "d-pers1";

    public final TeamDesk desk;
    public final EvalDeskd deskd = new EvalDeskd();

    public EvalDesk(Path data, MutableClock clock) throws Exception {
        this.desk = new TeamDesk(data, clock);
        // Her model: deskd's relay and her service on Minimalist Alliance's account, answered by the scripted model.
        deskd.service = new com.minimalistalliance.desk.agent.testing.FakeMaiaService(desk.provider);
        desk.service.deskLink(deskd);
        routeTaker(desk.provider);
    }

    public EvalDesk(Path data) throws Exception {
        this(data, new MutableClock(Rig.START));
    }

    /** Her note-taker's request takes the last scripted step only once her run's steps are taken. */
    static void routeTaker(FakeProvider provider) {
        provider.onChat = request -> {
            if (request.system().startsWith("You take notes")) {
                await().atMost(Duration.ofSeconds(15)).until(() -> provider.pending() <= 1);
            }
        };
    }

    /** Maia Mode on and her access saved: the first-run sheet. Her model is the company's: no key. */
    public void on() throws Exception {
        java.nio.file.Files.writeString(desk.data.resolve(MaiaMode.SWITCH_FILE), "on\n");
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

    public Map<String, Object> call(String method, Object... pairs) throws Exception {
        return desk.service.call(method, TeamDesk.m(pairs), Caller.OWNER);
    }

    public RpcError refused(String method, Object... pairs) {
        try {
            desk.service.call(method, TeamDesk.m(pairs), Caller.OWNER);
        } catch (RpcError e) {
            return e;
        } catch (Exception e) {
            throw new AssertionError(e);
        }
        throw new AssertionError(method + " wasn't refused");
    }

    public Map<String, Object> room() {
        return desk.service.snapshotFor(MaiaMode.TOPIC).get();
    }

    @SuppressWarnings("unchecked")
    public static List<Map<String, Object>> items(Map<String, Object> room) {
        return (List<Map<String, Object>>) ((Map<String, Object>) room.get("todo")).get("items");
    }

    public void grant(String deskId, String name, boolean keeps, String... scopes) throws Exception {
        call("agent.maia.grant.set", "deskId", deskId, "deskName", name, "scopes", List.of(scopes), "keepsToItself",
                keeps);
    }

    /** Her runs' model requests (not her note-taker's), oldest first. */
    public List<ChatRequest> herRequests() {
        List<ChatRequest> out = new ArrayList<>();
        for (ChatRequest r : desk.provider.requests()) {
            if (r.system().startsWith("The member's home desk adds")) {
                out.add(r);
            }
        }
        return out;
    }

    public ChatRequest lastOfHers() {
        List<ChatRequest> all = herRequests();
        return all.get(all.size() - 1);
    }

    /** Her note-taker's requests, oldest first. */
    public List<ChatRequest> takerRequests() {
        List<ChatRequest> out = new ArrayList<>();
        for (ChatRequest r : desk.provider.requests()) {
            if (r.system().startsWith("You take notes")) {
                out.add(r);
            }
        }
        return out;
    }

    /** Waits until her note-taker has been asked {@code n} times (it runs after each of the member's messages). */
    public void awaitTaker(int n) {
        await().atMost(Duration.ofSeconds(15)).until(() -> takerRequests().size() >= n);
    }

    @Override
    public void close() {
        desk.close();
    }
}
