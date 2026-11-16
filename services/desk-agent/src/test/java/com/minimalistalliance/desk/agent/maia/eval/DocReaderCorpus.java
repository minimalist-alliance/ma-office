package com.minimalistalliance.desk.agent.maia.eval;

import com.minimalistalliance.desk.agent.maia.DocReader;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Ten synthetic documents with their gold facts, for Documents' reader evals (the concept's E4: "due exact" at least
 * 90%, "page correct" at least 95%, "schema valid after code" 100%). Every name, company and figure is made up. The
 * scores are taken on what {@link DocReader#read} hands deskd, after code's checks.
 */
final class DocReaderCorpus {

    /** What a reading should find. {@code pages} is ask to page; {@code due} null when nothing is due. */
    record Gold(String what, List<String> asks, String due, Map<String, Integer> pages, boolean sensitive) {}

    /** One document: an id, deskd's title, its pages, and the gold facts. */
    record Doc(String key, String docId, String title, List<String> pages, Gold gold) {
        Map<String, Object> request() {
            Map<String, Object> p = new LinkedHashMap<>();
            p.put("docId", docId);
            p.put("versionSha256", String.format("%064x", key.hashCode() & 0xffffffffL));
            p.put("title", title);
            List<Map<String, Object>> list = new ArrayList<>();
            for (int i = 0; i < pages.size(); i++) {
                list.add(Map.of("n", i + 1, "text", pages.get(i)));
            }
            p.put("pages", list);
            return p;
        }

        Set<Integer> pageNumbers() {
            Set<Integer> out = new LinkedHashSet<>();
            for (int i = 1; i <= pages.size(); i++) {
                out.add(i);
            }
            return out;
        }
    }

    static final List<Doc> DOCS = List.of(
            new Doc("invoice-northwind", "d_01JD0000000000000000000001", "3 Nov · Northwind Supply · Invoice", List.of(
                    "NORTHWIND SUPPLY CO. Invoice INV-20931. Bill to: the member. Issued 3 November 2026."
                            + " Amount due: 1,240.00. Payment due by 1 December 2026. Pay by bank transfer"
                            + " quoting INV-20931.",
                    "Line items: 40 boxes of printer paper, 12 toner cartridges. Subtotal 1,127.27, tax 112.73."),
                    new Gold("invoice", List.of("pay"), "2026-12-01", Map.of("pay", 1), false)),
            new Doc("invoice-water", "d_01JD0000000000000000000002", "5 Nov · Valley Water · Invoice", List.of(
                    "Valley Water District. Your water bill for October 2026. Account 4410-22."
                            + " Usage 14 units. Total 86.15.",
                    "Payment slip. Please pay 86.15 by 28 November 2026. Detach and return this slip with"
                            + " your payment."),
                    new Gold("invoice", List.of("pay"), "2026-11-28", Map.of("pay", 2), false)),
            new Doc("contract-services", "d_01JD0000000000000000000003", "12 Nov · Rosa Ortiz · Contract", List.of(
                    "Services Agreement between Ortiz Design Studio and the member, dated 12 November 2026.",
                    "1. Scope. The studio will design a logo and a two-page leaflet.",
                    "2. Fees. 1,800 in two parts.",
                    "3. Term. The work runs from 20 November 2026 to 20 January 2027.",
                    "4. General terms.",
                    "Signatures. Please sign and return by 20 November 2026. Client signature: ________ Date: ____"),
                    new Gold("contract", List.of("sign"), "2026-11-20", Map.of("sign", 6), false)),
            new Doc("contract-nda", "d_01JD0000000000000000000004", "14 Nov · Brightline Labs · Contract", List.of(
                    "Mutual Non-Disclosure Agreement between Brightline Labs and the member.",
                    "Each party keeps the other's confidential information private for two years.",
                    "Signed for Brightline Labs: J. Park. Signed for the member: ____________"),
                    new Gold("contract", List.of("sign"), null, Map.of("sign", 3), false)),
            new Doc("receipt-hardware", "d_01JD0000000000000000000005", "8 Nov · Corner Hardware · Receipt", List.of(
                    "CORNER HARDWARE. Receipt 0042-118. 8 Nov 2026 14:02. Wood screws 6.49, wall plugs 3.99,"
                            + " drill bit set 24.00. Total 34.48. Paid by card. Thank you!"),
                    new Gold("receipt", List.of(), null, Map.of(), false)),
            new Doc("receipt-online", "d_01JD0000000000000000000006", "10 Nov · Paperleaf · Receipt", List.of(
                    "Paperleaf Books. Order 77-5521 confirmed and paid. 2 items: a field guide and a notebook."
                            + " Total charged 41.20 on 10 November 2026. This is your receipt; nothing more is"
                            + " needed from you."),
                    new Gold("receipt", List.of(), null, Map.of(), false)),
            new Doc("newsletter-garden", "d_01JD0000000000000000000007", "9 Nov · Garden Club · Report", List.of(
                    "Garden Club monthly news, November 2026. The autumn plant swap raised 320 for the community"
                            + " orchard. Next month: pruning fruit trees.",
                    "Members' corner: three new members joined. Photos from the swap are on the notice board."),
                    new Gold("report", List.of(), null, Map.of(), false)),
            new Doc("newsletter-company", "d_01JD0000000000000000000008", "11 Nov · Harbor Co-op · Report", List.of(
                    "Harbor Co-op quarterly update, Q3 2026. Revenue grew 6%. The new warehouse opened in"
                            + " September. No action is needed from members."),
                    new Gold("report", List.of(), null, Map.of(), false)),
            new Doc("letter-clinic", "d_01JD0000000000000000000009", "13 Nov · Lakeside Clinic · Letter", List.of(
                    "Lakeside Clinic. Dear patient, your blood test results from 6 November 2026 are enclosed."
                            + " Your doctor has reviewed them. Cholesterol is slightly raised; the details are on"
                            + " the next page.",
                    "Results table. Total cholesterol 5.9. HDL 1.2. LDL 3.9."),
                    new Gold("letter", List.of(), null, Map.of(), true)),
            new Doc("letter-collections", "d_01JD000000000000000000000A", "15 Nov · Crestview Recovery · Letter",
                    List.of("Crestview Recovery Services. Notice of an overdue balance of 412.60 on account 88-0193."
                            + " Please pay the full balance by 15 December 2026 to avoid further action."),
                    new Gold("letter", List.of("pay"), "2026-12-15", Map.of("pay", 1), true)));

    /** One run's scores: each a count over its own denominator. */
    record Scores(int dueExact, int dueOf, int pageCorrect, int pageOf, int schemaValid, int schemaOf, List<String> misses) {
        double due() {
            return dueOf == 0 ? 1 : dueExact / (double) dueOf;
        }

        double page() {
            return pageOf == 0 ? 1 : pageCorrect / (double) pageOf;
        }

        double schema() {
            return schemaOf == 0 ? 1 : schemaValid / (double) schemaOf;
        }

        String line(String who) {
            return String.format("DocReader %s over %d documents: due exact %d/%d (%.0f%%, target 90%%), page correct"
                    + " %d/%d (%.0f%%, target 95%%), schema valid after code %d/%d (%.0f%%, target 100%%)%s", who,
                    schemaOf, dueExact, dueOf, due() * 100, pageCorrect, pageOf, page() * 100, schemaValid, schemaOf,
                    schema() * 100, misses.isEmpty() ? "" : "; misses: " + String.join(", ", misses));
        }
    }

    private DocReaderCorpus() {}

    /**
     * Reads every document once through the reader and scores what code kept. "Due exact": every document, the kept
     * due equal to the gold one (null to null counts). "Page correct": the documents whose gold has a page, the kept
     * pages equal to the gold ones. "Schema valid": every document, the oracle finds nothing, and it wasn't skipped.
     */
    static Scores score(DocReader reader) throws InterruptedException {
        int dueExact = 0;
        int pageCorrect = 0;
        int pageOf = 0;
        int schemaValid = 0;
        List<String> misses = new ArrayList<>();
        for (Doc doc : DOCS) {
            Map<String, Object> facts = reader.read(doc.request());
            List<String> problems = DocReaderOracle.problems(facts, doc.pageNumbers(), false);
            if (problems.isEmpty() && !facts.containsKey("skipped")) {
                schemaValid++;
            } else {
                misses.add(doc.key() + " schema " + (problems.isEmpty() ? facts : problems));
            }
            if (java.util.Objects.equals(facts.get("due"), doc.gold().due())) {
                dueExact++;
            } else {
                misses.add(doc.key() + " due " + facts.get("due"));
            }
            if (!doc.gold().pages().isEmpty()) {
                pageOf++;
                if (doc.gold().pages().equals(facts.get("pages"))) {
                    pageCorrect++;
                } else {
                    misses.add(doc.key() + " pages " + facts.get("pages"));
                }
            }
        }
        return new Scores(dueExact, DOCS.size(), pageCorrect, pageOf, schemaValid, DOCS.size(), misses);
    }
}
