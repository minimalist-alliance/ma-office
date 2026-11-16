package com.minimalistalliance.desk.deskd.docs;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Documents' methods on a real Files tree (API.md §25): intake, places, copies, versions, changes, taps, search, tidy. */
class DocsModuleTest {

    @TempDir
    Path dir;
    DocsRig rig;

    static final String V1_P3 = "Payment\nPayment is due on 15 November 2026.\nSigned [sign]";
    static final String V2_P3 = "Payment\nPayment is due on 1 December 2026.\nSigned [sign]";

    static byte[] contract(String p3) {
        return FakeDocsSandbox.pdf("Agreement\nClause 1", "Terms\nClause 2", p3, "End");
    }

    @BeforeEach
    void start() throws Exception {
        rig = new DocsRig(dir);
    }

    @AfterEach
    void stop() throws Exception {
        rig.close();
    }

    @Test
    void filesAreIndexedAndPlacedByCode() throws Exception {
        // Saved from mail (Courier/), so not the member's own: its empty signature field makes it a Maybe.
        rig.put("Courier/Contract v1.pdf", contract(V1_P3));
        rig.put("notes.txt", "Shopping list".getBytes(StandardCharsets.UTF_8));
        rig.put("setup.exe", new byte[] {'M', 'Z', 0, 1, 2, 3});
        rig.put("Downloads/report.pdf", FakeDocsSandbox.pdf("Report\nNumbers"));
        rig.scan("");
        rig.scan("Courier");
        rig.scan("Downloads");
        Map<String, Object> contract = rig.doc(rig.idOf("Courier/Contract v1.pdf"));
        assertThat(contract.get("place")).isEqualTo("needs");
        assertThat(contract.get("maybe")).isEqualTo(true);
        assertThat(((Map<?, ?>) contract.get("reason")).get("text")).isEqualTo("Has empty signature fields");
        assertThat((String) contract.get("title")).isEqualTo("12 Nov · You · Contract");
        assertThat(contract.get("pageCount")).isEqualTo(4);
        assertThat(contract.get("origName")).isEqualTo("Contract v1.pdf");
        Map<String, Object> notes = rig.doc(rig.idOf("notes.txt"));
        assertThat(notes.get("place")).isEqualTo("read");
        assertThat(notes.get("type")).isEqualTo("text");
        Map<String, Object> exe = rig.doc(rig.idOf("setup.exe"));
        assertThat(exe.get("place")).isEqualTo("records");
        assertThat(exe.get("danger")).isEqualTo("program");
        assertThat(exe.get("viewable")).isEqualTo(false);
        assertThat(((Map<?, ?>) exe.get("reason")).get("text")).isEqualTo("Program. Maia won\u2019t open this.");
        Map<String, Object> dl = rig.doc(rig.idOf("Downloads/report.pdf"));
        assertThat(dl.get("kind")).isEqualTo("download");
        assertThat(dl.get("place")).isEqualTo("working");
        // A danger is never drawn or read.
        String exeId = (String) exe.get("id");
        assertThatThrownBy(() -> rig.call("docs.page", Map.of("id", exeId, "page", 1, "width", 800)))
                .isInstanceOf(RpcException.class).hasFieldOrPropertyWithValue("code", "forbidden");
        assertThatThrownBy(() -> rig.call("docs.text", Map.of("id", exeId))).isInstanceOf(RpcException.class);
        assertThat(rig.sandbox.reads.get()).isEqualTo(3);
    }

    @Test
    void theListIsNeedsYouThenMaybeAndEndsCalmly() throws Exception {
        rig.put("Courier/Contract.pdf", contract(V1_P3));
        rig.put("Lease.pdf", FakeDocsSandbox.pdf("Lease\nTerms"));
        rig.scan("");
        rig.scan("Courier");
        Map<String, Object> listed = rig.call("docs.list", Map.of("place", "needs"));
        List<Map<String, Object>> items = rig.items(listed);
        assertThat(items).isNotEmpty();
        assertThat(items).allMatch(i -> "needs".equals(i.get("place")));
        assertThat(listed.get("end")).isEqualTo("That\u2019s all for now.");
        Map<?, ?> counts = (Map<?, ?>) listed.get("counts");
        assertThat(((Number) counts.get("maybe")).intValue()).isGreaterThanOrEqualTo(1);
    }

    @Test
    void anExactCopyStacksAndTidyKeepsTheMembersPlace() throws Exception {
        byte[] bytes = contract(V1_P3);
        rig.put("Contracts/Contract.pdf", bytes);
        rig.put("Inbox/Contract (1).pdf", bytes);
        rig.scan("Contracts");
        rig.scan("Inbox");
        String a = rig.idOf("Contracts/Contract.pdf");
        String b = rig.idOf("Inbox/Contract (1).pdf");
        assertThat(b).isEqualTo(a);
        Map<String, Object> got = rig.call("docs.get", Map.of("id", a));
        assertThat((List<?>) got.get("copies")).hasSize(2);
        assertThat(got.get("copiesText")).isEqualTo("2 copies: Files, Files");
        rig.advance(Duration.ofDays(31));
        Map<String, Object> tidy = rig.call("docs.tidy", Map.of());
        assertThat(tidy.get("copies")).isEqualTo(1);
        assertThat((String) tidy.get("text")).startsWith("Tidy up? 1 extra copy and 0 downloads");
        Map<String, Object> done = rig.call("docs.tidy.apply", Map.of());
        assertThat(done.get("moved")).isEqualTo(1);
        // One copy stays where the member put it; nothing is ever deleted outright.
        long left = Files.exists(rig.files.root().resolve("Contracts/Contract.pdf")) ? 1 : 0;
        left += Files.exists(rig.files.root().resolve("Inbox/Contract (1).pdf")) ? 1 : 0;
        assertThat(left).isEqualTo(1);
    }

    @Test
    void aNewVersionMarksTheChangedPage() throws Exception {
        rig.put("Contract.pdf", contract(V1_P3));
        rig.scan("");
        String id = rig.idOf("Contract.pdf");
        rig.call("docs.seen", Map.of("id", id, "page", 2, "ms", 4000));
        rig.advance(Duration.ofMinutes(5));
        rig.put("Contract.pdf", contract(V2_P3));
        rig.scan("");
        assertThat(rig.idOf("Contract.pdf")).isEqualTo(id);
        Map<String, Object> doc = rig.doc(id);
        assertThat(doc.get("changedPages")).isEqualTo(List.of(3));
        assertThat(doc.get("versions")).isEqualTo(2L);
        assertThat(doc.get("lastPage")).isEqualTo(2);
        Map<String, Object> changes = rig.call("docs.changes", Map.of("id", id));
        assertThat(changes.get("pages")).isEqualTo(List.of(3));
        assertThat(changes.get("line")).isEqualTo("Page 3 changed");
        Map<String, Object> got = rig.call("docs.get", Map.of("id", id));
        List<?> versions = (List<?>) got.get("versions");
        assertThat(versions).hasSize(2);
        // The old bytes are kept for Versions and Restore.
        assertThat(((Map<?, ?>) versions.get(1)).get("restorable")).isEqualTo(true);
        // Restore puts the old bytes back as a new version, and says so.
        String old = (String) ((Map<?, ?>) versions.get(1)).get("id");
        Map<String, Object> restored = rig.call("docs.restore", Map.of("id", id, "version", old));
        assertThat(((Map<?, ?>) restored.get("toast")).get("text")).isEqualTo("Restored. The newer one is kept as a version.");
        assertThat(new String(Files.readAllBytes(rig.files.root().resolve("Contract.pdf")), StandardCharsets.UTF_8)).contains("15 November");
    }

    @Test
    void notImportantMakesARuleWithUndo() throws Exception {
        rig.put("Courier/Contract.pdf", contract(V1_P3));
        rig.scan("Courier");
        String id = rig.idOf("Courier/Contract.pdf");
        Map<String, Object> tapped = rig.call("docs.tap", Map.of("id", id, "chip", "not_important"));
        Map<?, ?> toast = (Map<?, ?>) tapped.get("toast");
        assertThat((String) toast.get("text")).isEqualTo("Not important: Contracts go to Records now.");
        assertThat(((Map<?, ?>) tapped.get("doc")).get("place")).isEqualTo("records");
        List<?> rules = (List<?>) rig.call("docs.rules", Map.of()).get("rules");
        assertThat(rules).hasSize(1);
        assertThat(((Map<?, ?>) rules.get(0)).get("text")).isEqualTo("Contracts → Records");
        rig.call("docs.undo", Map.of("token", toast.get("undo")));
        assertThat(rig.doc(id).get("place")).isEqualTo("needs");
        assertThat((List<?>) rig.call("docs.rules", Map.of()).get("rules")).isEmpty();
    }

    @Test
    void notNowHoldsUntilTheNextCatchUpAndDoneLeaves() throws Exception {
        rig.put("Courier/Contract.pdf", contract(V1_P3));
        rig.scan("Courier");
        String id = rig.idOf("Courier/Contract.pdf");
        Map<String, Object> held = rig.call("docs.tap", Map.of("id", id, "chip", "not_now"));
        assertThat((String) ((Map<?, ?>) held.get("toast")).get("text")).isEqualTo("Held until 1:00 pm");
        assertThat(rig.items(rig.call("docs.list", Map.of("place", "needs")))).isEmpty();
        rig.advance(Duration.ofHours(3));
        assertThat(rig.items(rig.call("docs.list", Map.of("place", "needs")))).hasSize(1);
        rig.call("docs.tap", Map.of("id", id, "chip", "done"));
        assertThat(rig.items(rig.call("docs.list", Map.of("place", "needs")))).isEmpty();
        assertThat(rig.doc(id).get("state")).isEqualTo("handled");
    }

    @Test
    void theFrontIsWhatTheShieldTakesIdsAndPlacesOnly() throws Exception {
        rig.put("Courier/Contract.pdf", contract(V1_P3));
        rig.put("Lease.pdf", FakeDocsSandbox.pdf("Lease\nTerms"));
        rig.scan("");
        rig.scan("Courier");
        String contract = rig.idOf("Courier/Contract.pdf");
        Map<String, Object> front = rig.call("docs.feed", Map.of("front", true));
        List<Map<String, Object>> items = rig.items(front);
        assertThat(items).extracting(i -> i.get("docId")).contains(contract);
        // Structure only: never a title, a name, a reason's words or text.
        assertThat(items).allSatisfy(i -> assertThat(i.keySet()).containsOnly("docId", "place", "dueAt", "changed", "at"));
        assertThat(items).allMatch(i -> List.of("needs_you", "maybe", "read_later", "records", "working").contains(i.get("place")));
        // Held is out of the front until it comes back; handled leaves it.
        rig.call("docs.tap", Map.of("id", contract, "chip", "not_now"));
        assertThat(rig.items(rig.call("docs.feed", Map.of("front", true)))).extracting(i -> i.get("docId")).doesNotContain(contract);
        rig.advance(Duration.ofHours(3));
        assertThat(rig.items(rig.call("docs.feed", Map.of("front", true)))).extracting(i -> i.get("docId")).contains(contract);
        rig.call("docs.tap", Map.of("id", contract, "chip", "done"));
        assertThat(rig.items(rig.call("docs.feed", Map.of("front", true)))).extracting(i -> i.get("docId")).doesNotContain(contract);
        assertThatThrownBy(() -> rig.call("docs.feed", Map.of("front", true, "since", 0))).isInstanceOf(RpcException.class);
        assertThatThrownBy(() -> rig.call("docs.feed", Map.of("front", "yes"))).isInstanceOf(RpcException.class);
    }

    @Test
    void aSeenDocumentThatChangesComesBackToTheFront() throws Exception {
        rig.put("Contract.pdf", contract(V1_P3));
        rig.scan("");
        String id = rig.idOf("Contract.pdf");
        rig.call("docs.seen", Map.of("id", id, "page", 2, "ms", 4000));
        rig.advance(Duration.ofMinutes(5));
        rig.put("Contract.pdf", contract(V2_P3));
        rig.scan("");
        Map<String, Object> mine = rig.items(rig.call("docs.feed", Map.of("front", true))).stream()
                .filter(i -> id.equals(i.get("docId"))).findFirst().orElseThrow();
        assertThat(mine.get("changed")).isEqualTo(true);
    }

    @Test
    void searchFindsByWordsAndInsideOnlyWhenAsked() throws Exception {
        rig.put("Lease agreement.pdf", FakeDocsSandbox.pdf("The landlord Harbor Properties\nRent is due monthly"));
        rig.put("Holiday photos.txt", "Beach and mountains".getBytes(StandardCharsets.UTF_8));
        rig.scan("");
        List<?> byName = (List<?>) rig.call("docs.search", Map.of("q", "lease")).get("items");
        assertThat(byName).hasSize(1);
        assertThat((List<?>) rig.call("docs.search", Map.of("q", "landlord")).get("items")).isEmpty();
        List<?> inside = (List<?>) rig.call("docs.search", Map.of("q", "landlord", "inText", true)).get("items");
        assertThat(inside).hasSize(1);
        assertThat(((Map<?, ?>) inside.get(0)).get("matchedText")).isEqualTo(true);
        // The same query, the same order.
        assertThat(rig.call("docs.search", Map.of("q", "a"))).isEqualTo(rig.call("docs.search", Map.of("q", "a")));
    }

    @Test
    void aNearCopyIsAskedOnce() throws Exception {
        String body = "Quarterly findings: revenue, costs and the outlook for the next quarter. ".repeat(12);
        rig.put("report.txt", body.getBytes(StandardCharsets.UTF_8));
        rig.put("report edited.txt", (body + " One more line.").getBytes(StandardCharsets.UTF_8));
        rig.scan("");
        List<?> qs = (List<?>) rig.call("docs.questions", Map.of()).get("questions");
        Map<?, ?> near = (Map<?, ?>) qs.stream().filter(q -> "near".equals(((Map<?, ?>) q).get("kind"))).findFirst().orElseThrow();
        assertThat((String) near.get("text")).startsWith("This looks like ");
        rig.call("docs.answer", Map.of("questionId", near.get("id"), "choice", "same"));
        assertThat((List<?>) rig.call("docs.questions", Map.of()).get("questions"))
                .noneMatch(q -> "near".equals(((Map<?, ?>) q).get("kind")));
    }

    @Test
    void theSandboxBeingDownLeavesItPendingThenReadsIt() throws Exception {
        rig.sandbox.unavailable = true;
        rig.put("Contract.pdf", contract(V1_P3));
        rig.scan("");
        String id = rig.idOf("Contract.pdf");
        assertThatThrownBy(() -> rig.call("docs.text", Map.of("id", id))).isInstanceOf(RpcException.class)
                .hasFieldOrPropertyWithValue("code", "unavailable");
        rig.sandbox.unavailable = false;
        rig.module.intake().retryPending();
        assertThat(rig.doc(id).get("pageCount")).isEqualTo(4);
        assertThat(rig.call("docs.text", Map.of("id", id))).containsKey("pages");
    }

    @Test
    void theReadersFactsAreCheckedAgainAndKept() throws Exception {
        rig.put("Invoice 4471.pdf", FakeDocsSandbox.pdf("Northwind\nInvoice 4471\nAmount due"));
        rig.scan("");
        String id = rig.idOf("Invoice 4471.pdf");
        rig.module.readerThrough(params -> Map.of("what", "invoice", "asks", List.of("pay", "hack"), "due", "2026-11-14",
                "pages", Map.of("pay", 1), "line", "An invoice for 1,240 USD due 14 Nov", "sensitive", false), () -> true);
        Map<String, Object> asked = rig.call("docs.read", Map.of("id", id));
        assertThat(asked.get("asked")).isEqualTo(true);
        long until = System.nanoTime() + 5_000_000_000L;
        while (rig.doc(id).get("summary") == null && System.nanoTime() < until) {
            Thread.onSpinWait();
        }
        Map<String, Object> doc = rig.doc(id);
        Map<?, ?> summary = (Map<?, ?>) doc.get("summary");
        assertThat(summary.get("asks")).isEqualTo(List.of("pay"));
        assertThat(summary.get("line")).isEqualTo("An invoice for 1,240 USD due 14 Nov");
        assertThat(doc.get("place")).isEqualTo("needs");
        assertThat((String) doc.get("title")).isEqualTo("12 Nov · You · Invoice 4471");
    }

    @Test
    void aGuildDeskAndTheSwitchRefuse() throws Exception {
        rig.guild.set(true);
        assertThatThrownBy(() -> rig.call("docs.list", Map.of())).isInstanceOf(RpcException.class)
                .hasFieldOrPropertyWithValue("code", "forbidden");
        rig.guild.set(false);
        Files.writeString(rig.desk.resolve(DocsModule.SWITCH_FILE), "off");
        assertThatThrownBy(() -> rig.call("docs.list", Map.of())).isInstanceOf(RpcException.class)
                .hasFieldOrPropertyWithValue("code", "unavailable");
    }

    @Test
    void paramsAreCheckedStrictly() {
        assertThatThrownBy(() -> rig.call("docs.list", Map.of("place", "everything"))).isInstanceOf(RpcException.class);
        assertThatThrownBy(() -> rig.call("docs.get", Map.of("id", "../../etc"))).isInstanceOf(RpcException.class);
        assertThatThrownBy(() -> rig.call("docs.tap", Map.of("id", "d_01JCZZZZZZZZZZZZZZZZZZZZZZ", "chip", "delete")))
                .isInstanceOf(RpcException.class);
        assertThatThrownBy(() -> rig.call("docs.list", Map.of("extra", 1))).isInstanceOf(RpcException.class);
    }

    @Test
    void theExportCarriesRulesLinksMilestonesAndSummaries() throws Exception {
        Map<String, Object> out = rig.call("docs.export", Map.of());
        assertThat(out).containsKeys("rules", "links", "milestones", "summaries", "projects");
    }

    @Test
    void aTrashedDocumentIsNeitherDrawnNorReadAndItsKeptBytesGo() throws Exception {
        rig.put("Contract.pdf", contract(V1_P3));
        rig.scan("");
        String id = rig.idOf("Contract.pdf");
        rig.files.files().agentAccess().trash("Contract.pdf");
        rig.scan("");
        assertThatThrownBy(() -> rig.call("docs.text", Map.of("id", id))).isInstanceOf(RpcException.class)
                .hasFieldOrPropertyWithValue("code", "not_found");
        assertThatThrownBy(() -> rig.call("docs.page", Map.of("id", id, "page", 1, "width", 400))).isInstanceOf(RpcException.class)
                .hasFieldOrPropertyWithValue("code", "not_found");
        try (var s = Files.list(rig.desk.resolve("versions"))) {
            assertThat(s.filter(p -> !p.getFileName().toString().startsWith(".")).count()).isZero();
        }
    }

    @Test
    void whatsThisIsAReadAndAsksOnce() throws Exception {
        rig.put("Invoice 1.pdf", FakeDocsSandbox.pdf("Invoice 1"));
        rig.scan("");
        String id = rig.idOf("Invoice 1.pdf");
        assertThat(com.minimalistalliance.desk.deskd.rpc.RpcTestCalls.registered(rig.dispatcher, "docs.read")).isTrue();
        assertThat(rig.call("docs.read", Map.of("id", id)).get("asked")).isEqualTo(false);
        rig.module.readerThrough(p -> Map.of("skipped", "maia_off"), () -> true);
        assertThat(rig.call("docs.read", Map.of("id", id)).get("asked")).isEqualTo(true);
    }
}
