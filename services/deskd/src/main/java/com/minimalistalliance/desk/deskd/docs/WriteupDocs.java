package com.minimalistalliance.desk.deskd.docs;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Desk Maia's write-ups for the index (API.md §25 "Intake"; Phase 2's {@code desk_writeups}): the full write-ups agents on
 * this desk left for her briefs, read from desk-agent over deskd's own link ({@code desk.docs.writeups}, never relayed for a
 * client). Nothing while desk-agent can't be reached.
 */
public final class WriteupDocs {

    /** desk-agent's side: {@code desk.docs.writeups} with its params, its answer. */
    public interface Link {
        Map<String, Object> call(Map<String, Object> params) throws Exception;
    }

    private WriteupDocs() {}

    public static Intake.WriteupSource of(Link link) {
        if (link == null) {
            return null;
        }
        return new Intake.WriteupSource() {
            @Override
            public List<Writeup> after(long at, String id, int n) throws Exception {
                Map<String, Object> p = new LinkedHashMap<>();
                p.put("after", at);
                p.put("afterId", id == null ? "" : id);
                p.put("limit", n);
                return items(answer(p));
            }

            /** The last answer to {@code {kept: true}}: both lists come in one call. */
            private volatile Map<String, Object> lastKept;

            @Override
            public Set<String> kept() throws Exception {
                Map<String, Object> a = answer(Map.of("kept", true));
                lastKept = a;
                return ids(a, "kept");
            }

            @Override
            public Set<String> readable() {
                Map<String, Object> a = lastKept;
                lastKept = null;
                return ids(a, "readable");
            }

            @Override
            public Writeup one(String id) throws Exception {
                List<Writeup> l = items(answer(Map.of("id", id)));
                return l == null || l.isEmpty() ? null : l.get(0);
            }

            private Map<String, Object> answer(Map<String, Object> p) throws Exception {
                try {
                    return link.call(p);
                } catch (InterruptedException e) {
                    throw e;
                } catch (Exception e) {
                    return null;
                }
            }
        };
    }

    /** One of the answer's id lists, each id checked; null when it isn't there. */
    static Set<String> ids(Map<String, Object> a, String field) {
        if (a == null || !(a.get(field) instanceof List<?> ids)) {
            return null;
        }
        Set<String> out = new HashSet<>();
        for (Object o : ids) {
            if (o instanceof String s && s.matches("wu-[a-z2-7]{1,40}")) {
                out.add(s);
            }
        }
        return out;
    }

    /** desk-agent's items, each field checked; anything off is skipped. Null for no answer. */
    static List<Intake.WriteupSource.Writeup> items(Map<String, Object> a) {
        if (a == null || !(a.get("items") instanceof List<?> items)) {
            return null;
        }
        List<Intake.WriteupSource.Writeup> out = new ArrayList<>();
        for (Object o : items) {
            if (!(o instanceof Map<?, ?> m) || !(m.get("id") instanceof String id) || !id.matches("wu-[a-z2-7]{1,40}")
                    || !(m.get("at") instanceof Number at) || !(m.get("text") instanceof String text)) {
                continue;
            }
            out.add(new Intake.WriteupSource.Writeup(id, m.get("agentId") instanceof String s ? s : null,
                    m.get("agentName") instanceof String s ? s : null, at.longValue(), Boolean.TRUE.equals(m.get("readable")), text));
        }
        return out;
    }
}
