package com.minimalistalliance.desk.deskd.docs;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * What changed between two versions (deskd {@code API.md} §25): each version's lines per page from the sandbox, diffed
 * by code. A page whose normalised lines differ is changed; within it, the lines of the newer version that the older one
 * hasn't are marked. For documents with no pages (docx), the sections that changed. No model reads either version.
 */
final class PageDiff {

    private PageDiff() {}

    /** Pages changed (1-based, ascending) and, per page, the indexes of its changed lines in the newer version. */
    record Result(List<Integer> pages, Map<Integer, Set<Integer>> lines, List<Integer> sections) {}

    static Result diff(DocText before, DocText after) {
        List<Integer> pages = new ArrayList<>();
        Map<Integer, Set<Integer>> lines = new java.util.LinkedHashMap<>();
        int n = Math.max(before.pages().size(), after.pages().size());
        for (int i = 0; i < n; i++) {
            DocText.Page a = i < before.pages().size() ? before.pages().get(i) : null;
            DocText.Page b = i < after.pages().size() ? after.pages().get(i) : null;
            if (b == null) {
                // A page the newer version doesn't have: the last page it has changed.
                if (!after.pages().isEmpty() && !pages.contains(after.pages().size())) {
                    pages.add(after.pages().size());
                }
                continue;
            }
            List<String> la = a == null ? List.of() : norm(a.lineTexts());
            List<String> lb = norm(b.lineTexts());
            if (la.equals(lb) && (a == null ? b.text().isBlank() : SimHash.normal(a.text()).equals(SimHash.normal(b.text())))) {
                continue;
            }
            pages.add(b.n());
            Set<Integer> changed = new TreeSet<>();
            Set<String> old = new HashSet<>(la);
            for (int k = 0; k < lb.size(); k++) {
                if (!old.contains(lb.get(k))) {
                    changed.add(k);
                }
            }
            lines.put(b.n(), changed);
        }
        List<Integer> sections = new ArrayList<>();
        if (after.pages().isEmpty() && !after.sections().isEmpty()) {
            Set<String> old = new HashSet<>();
            for (String s : before.sectionTexts()) {
                old.add(SimHash.normal(s));
            }
            List<String> now = after.sectionTexts();
            for (int k = 0; k < now.size(); k++) {
                if (!old.contains(SimHash.normal(now.get(k)))) {
                    sections.add(k);
                }
            }
        }
        java.util.Collections.sort(pages);
        return new Result(List.copyOf(new TreeSet<>(pages)), lines, sections);
    }

    private static List<String> norm(List<String> lines) {
        List<String> out = new ArrayList<>(lines.size());
        for (String l : lines) {
            String n = SimHash.normal(l);
            if (!n.isEmpty()) {
                out.add(n);
            }
        }
        return out;
    }
}
