package com.minimalistalliance.desk.deskd.data;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** What an export session may do, through the real method table, and a desk without desk-data. */
class DataScopeTest {

    @TempDir
    Path dir;

    private DataRig rig;

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            rig.close();
        }
    }

    @Test
    void anExportSessionGetsNeitherVideoNorInputInDeskRtc() throws Exception {
        rig = new DataRig(dir);
        rig.export("cs-1");
        Map<String, Object> create = rig.fake.awaitJson("session.create");
        assertThat(Json.object(create, "permissions")).isEqualTo(Map.of("video", false, "input", false));
    }

    @Test
    void anExportSessionIsRefusedEverythingButStatusAndData() throws Exception {
        rig = new DataRig(dir);
        TestClient client = rig.export("cs-1");
        for (String method : List.of(
                "browser.stream.set",
                "browser.tab.list",
                "browser.tab.navigate",
                "browser.text.insert",
                "browser.clipboard.read",
                "browser.clipboard.write",
                "no.such.method")) {
            Map<String, Object> reply = rig.call(client, method, Map.of("state", "off", "url", "https://example.com/", "text", "x"));
            assertThat(reply).as(method).containsEntry("_kind", "ERR").containsEntry("code", "forbidden");
            assertThat(Json.object(reply, "details")).as(method).containsEntry("reason", "scope");
        }
        for (String topic : List.of("browser.tabs", "browser.clipboard", "summary")) {
            Map<String, Object> reply = rig.subscribe(client, topic);
            assertThat(reply).as(topic).containsEntry("_kind", "ERR").containsEntry("code", "forbidden");
        }
        assertThat(rig.call(client, "desk.status.get", Map.of())).containsEntry("_kind", "RES").containsEntry("deskId", "d-test");
        assertThat(rig.call(client, "data.parts.list", Map.of())).containsEntry("_kind", "RES");
        // Nothing the refused calls asked for reached the units.
        assertThat(rig.units.requests()).isEmpty();
    }

    @Test
    void anOwnerSessionKeepsItsMethodsAndGetsDataToo() throws Exception {
        rig = new DataRig(dir);
        TestClient client = rig.owner("cs-1");
        assertThat(rig.call(client, "no.such.method", Map.of())).containsEntry("code", "not_found");
        assertThat(rig.call(client, "browser.stream.set", Map.of("state", "off"))).containsEntry("_kind", "RES");
        assertThat(rig.subscribe(client, "browser.tabs")).containsEntry("_kind", "RES");
        assertThat(rig.call(client, "data.parts.list", Map.of())).containsEntry("_kind", "RES");
    }

    @Test
    void withoutTheHelperEveryDataCallIsUnavailableWithReasonHelper() throws Exception {
        rig = new DataRig(dir, 9, false, DataRig.FAST);
        TestClient client = rig.export("cs-1");
        for (Map.Entry<String, Map<String, Object>> call : List.of(
                Map.entry("data.parts.list", Map.<String, Object>of()),
                Map.entry("data.manifest", Map.<String, Object>of("part", "files")),
                Map.entry("data.read", Map.<String, Object>of("part", "files", "path", "a", "offset", 0)))) {
            Map<String, Object> reply = rig.call(client, call.getKey(), call.getValue());
            assertThat(reply).as(call.getKey()).containsEntry("code", "unavailable");
            assertThat(Json.object(reply, "details")).as(call.getKey()).isEqualTo(Map.of("reason", "helper"));
        }
        assertThat(rig.data.transfers().count("cs-1")).isZero();
    }
}
