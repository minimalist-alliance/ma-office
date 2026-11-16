package com.minimalistalliance.desk.deskd.docs;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * The passages that bear on the member's question, picked by code from the document's lines (API.md §25 {@code docs_ask}):
 * the lines sharing the most of the question's words, with a line either side, at most 1,200 characters in all, each
 * labelled with its page. Only after the member's tap; fenced as data by the tool.
 */
final class Passages {

    private Passages() {}

    static List<String> pick(DocText t, String question, int max) {
        Set<String> words = new HashSet<>();
        for (String w : SimHash.normal(question).split(" ")) {
            if (w.length() >= 3) {
                words.add(w);
            }
        }
        record Hit(int page, List<String> lines, int at, int score) {}
        List<Hit> hits = new ArrayList<>();
        for (DocText.Page p : t.pages()) {
            List<String> lines = p.lineTexts();
            for (int i = 0; i < lines.size(); i++) {
                int score = 0;
                for (String w : SimHash.normal(lines.get(i)).split(" ")) {
                    if (words.contains(w)) {
                        score++;
                    }
                }
                if (score > 0) {
                    hits.add(new Hit(p.n(), lines, i, score));
                }
            }
        }
        int s = 0;
        for (DocText.Section sec : t.sections()) {
            s++;
            int score = 0;
            for (String w : SimHash.normal(sec.text()).split(" ")) {
                if (words.contains(w)) {
                    score++;
                }
            }
            if (score > 0) {
                hits.add(new Hit(0, List.of(sec.text()), 0, score));
            }
        }
        hits.sort(Comparator.comparingInt(Hit::score).reversed().thenComparingInt(Hit::page).thenComparingInt(Hit::at));
        List<String> out = new ArrayList<>();
        int used = 0;
        for (Hit h : hits) {
            StringBuilder b = new StringBuilder(h.page() > 0 ? "(p. " + h.page() + ") " : "");
            for (int i = Math.max(0, h.at() - 1); i <= Math.min(h.lines().size() - 1, h.at() + 1); i++) {
                b.append(h.lines().get(i)).append(' ');
            }
            String piece = b.toString().strip();
            if (used + piece.length() > max) {
                piece = piece.substring(0, Math.max(0, max - used));
            }
            if (piece.isEmpty() || out.contains(piece)) {
                continue;
            }
            out.add(piece);
            used += piece.length();
            if (used >= max || out.size() >= 6) {
                break;
            }
        }
        return out;
    }
}
