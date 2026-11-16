package com.minimalistalliance.desk.deskd.docs;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * One version's text as the sandbox's documents mode read it ({@code docs-read 1}): pages with each line's box, or
 * sections for a reading view, and the form's empty fields. Read strictly from the worker's JSON, every field checked
 * and capped; anything off is refused ({@link IllegalArgumentException}), never half used.
 */
record DocText(String kind, int pageCount, boolean cut, List<Page> pages, List<Section> sections, int signatures,
        int signaturesEmpty, int formEmpty) {

    static final int MAX_PAGES = 500;
    static final int MAX_LINES = 300;
    static final int MAX_SECTIONS = 20_000;
    static final int MAX_ROWS = 200;
    static final int MAX_COLS = 30;

    record Line(String t, double x, double y, double w, double h) {}

    record Page(int n, double w, double h, String text, List<Line> lines) {
        List<String> lineTexts() {
            List<String> out = new ArrayList<>(lines.size());
            for (Line l : lines) {
                out.add(l.t());
            }
            if (out.isEmpty() && !text.isBlank()) {
                out.addAll(List.of(text.split("\n")));
            }
            return out;
        }
    }

    record Section(String kind, String text, List<List<String>> rows) {}

    static final DocText EMPTY = new DocText("other", 0, false, List.of(), List.of(), 0, 0, 0);

    /** All the text, pages first, for the search index and the simhash. */
    String all() {
        StringBuilder b = new StringBuilder();
        for (Page p : pages) {
            b.append(p.text()).append('\n');
        }
        for (Section s : sections) {
            b.append(s.text()).append('\n');
            if (s.rows() != null) {
                for (List<String> r : s.rows()) {
                    b.append(String.join(" ", r)).append('\n');
                }
            }
        }
        return b.toString();
    }

    List<String> sectionTexts() {
        List<String> out = new ArrayList<>();
        for (Section s : sections) {
            StringBuilder b = new StringBuilder(s.text());
            if (s.rows() != null) {
                for (List<String> r : s.rows()) {
                    b.append('\n').append(String.join("\t", r));
                }
            }
            out.add(b.toString());
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    static DocText from(Map<String, Object> m) {
        if (!(m.get("v") instanceof Number v) || v.intValue() != 1) {
            throw new IllegalArgumentException("v");
        }
        String kind = str(m.get("kind"), 8);
        int pageCount = num(m.get("pageCount"), 0, 100_000);
        boolean cut = Boolean.TRUE.equals(m.get("cut"));
        List<Page> pages = new ArrayList<>();
        for (Object o : list(m.get("pages"), MAX_PAGES)) {
            Map<String, Object> p = (Map<String, Object>) o;
            List<Line> lines = new ArrayList<>();
            Object rawLines = p.get("lines");
            if (rawLines != null) {
                for (Object lo : list(rawLines, MAX_LINES)) {
                    Map<String, Object> l = (Map<String, Object>) lo;
                    List<Object> b = list(l.get("b"), 4);
                    if (b.size() != 4) {
                        throw new IllegalArgumentException("box");
                    }
                    lines.add(new Line(str(l.get("t"), 500), unit(b.get(0)), unit(b.get(1)), unit(b.get(2)), unit(b.get(3))));
                }
            }
            double w = p.get("w") instanceof Number pw ? pw.doubleValue() : 0;
            double h = p.get("h") instanceof Number ph ? ph.doubleValue() : 0;
            pages.add(new Page(num(p.get("n"), 1, 100_000), w, h, str(p.get("text"), 250_000), List.copyOf(lines)));
        }
        List<Section> sections = new ArrayList<>();
        for (Object o : list(m.get("sections"), MAX_SECTIONS)) {
            Map<String, Object> s = (Map<String, Object>) o;
            String sk = str(s.get("kind"), 8);
            if (!List.of("p", "h", "table", "slide", "sheet").contains(sk)) {
                throw new IllegalArgumentException("section");
            }
            List<List<String>> rows = null;
            if (s.get("rows") != null) {
                rows = new ArrayList<>();
                for (Object ro : list(s.get("rows"), MAX_ROWS)) {
                    List<String> cells = new ArrayList<>();
                    for (Object c : list(ro, MAX_COLS)) {
                        cells.add(str(c, 2_000));
                    }
                    rows.add(List.copyOf(cells));
                }
            }
            sections.add(new Section(sk, str(s.get("text"), 250_000), rows == null ? null : List.copyOf(rows)));
        }
        Map<String, Object> f = m.get("fields") instanceof Map<?, ?> fm ? (Map<String, Object>) fm : Map.of();
        return new DocText(kind, pageCount, cut, List.copyOf(pages), List.copyOf(sections), num(f.getOrDefault("signatures", 0), 0, 100_000),
                num(f.getOrDefault("signaturesEmpty", 0), 0, 100_000), num(f.getOrDefault("formEmpty", 0), 0, 100_000));
    }

    /** As stored and as {@code docs.text} answers it (pages without boxes, or sections). */
    Map<String, Object> wire(boolean withLines) {
        Map<String, Object> out = new LinkedHashMap<>();
        List<Map<String, Object>> ps = new ArrayList<>();
        for (Page p : pages) {
            Map<String, Object> pm = new LinkedHashMap<>();
            pm.put("n", p.n());
            pm.put("text", p.text());
            if (withLines) {
                pm.put("w", p.w());
                pm.put("h", p.h());
                List<Map<String, Object>> ls = new ArrayList<>();
                for (Line l : p.lines()) {
                    Map<String, Object> lm = new LinkedHashMap<>();
                    lm.put("t", l.t());
                    lm.put("b", List.of(l.x(), l.y(), l.w(), l.h()));
                    ls.add(lm);
                }
                pm.put("lines", ls);
            }
            ps.add(pm);
        }
        List<Map<String, Object>> ss = new ArrayList<>();
        for (Section s : sections) {
            Map<String, Object> sm = new LinkedHashMap<>();
            sm.put("kind", s.kind());
            sm.put("text", s.text());
            if (s.rows() != null) {
                sm.put("rows", s.rows());
            }
            ss.add(sm);
        }
        if (withLines) {
            out.put("v", 1);
            out.put("kind", kind);
            out.put("pageCount", pageCount);
            out.put("cut", cut);
            out.put("pages", ps);
            out.put("sections", ss);
            out.put("fields", Map.of("signatures", signatures, "signaturesEmpty", signaturesEmpty, "formEmpty", formEmpty));
        } else if (!ps.isEmpty()) {
            out.put("pages", ps);
        } else {
            out.put("sections", ss);
        }
        return out;
    }

    private static String str(Object o, int max) {
        if (!(o instanceof String s) || s.length() > max) {
            throw new IllegalArgumentException("string");
        }
        return s;
    }

    private static int num(Object o, int min, int max) {
        if (!(o instanceof Number n) || n.doubleValue() != Math.rint(n.doubleValue()) || n.longValue() < min || n.longValue() > max) {
            throw new IllegalArgumentException("number");
        }
        return n.intValue();
    }

    private static double unit(Object o) {
        if (!(o instanceof Number n) || Double.isNaN(n.doubleValue()) || n.doubleValue() < 0 || n.doubleValue() > 1) {
            throw new IllegalArgumentException("unit");
        }
        return n.doubleValue();
    }

    private static List<Object> list(Object o, int max) {
        if (!(o instanceof List<?> l) || l.size() > max) {
            throw new IllegalArgumentException("list");
        }
        @SuppressWarnings("unchecked")
        List<Object> out = (List<Object>) l;
        return out;
    }
}
