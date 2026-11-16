package com.minimalistalliance.desk.deskd.docs;

import com.minimalistalliance.desk.deskd.notebook.NotebookCalls;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Notebook's pages for the index (API.md §25 "Intake"): deskd's own calls to desk-notebook as the owner, the ones the
 * Agent's Notebook tools use ({@code notebook.outline}, {@code notebook.page.markdown}). Reads only. Nothing on a desk
 * without desk-notebook, or while it's away.
 */
public final class NotebookDocs {

    /** A page's Markdown is read up to this many characters for the index (its search and reading view). */
    static final int PAGE_CHARS = 1_000_000;

    private NotebookDocs() {}

    public static Intake.NotebookSource of(NotebookCalls calls) {
        if (calls == null || !calls.configured()) {
            return null;
        }
        return new Intake.NotebookSource() {
            @Override
            public List<Page> pages() throws Exception {
                Map<?, ?> outline = call(calls, "notebook.outline", Map.of());
                if (outline == null || Boolean.TRUE.equals(outline.get("more")) || !(outline.get("notebooks") instanceof List<?> books)) {
                    return null;
                }
                List<Page> out = new ArrayList<>();
                for (Object b : books) {
                    if (!(b instanceof Map<?, ?> book) || !(book.get("tabs") instanceof List<?> tabs)) {
                        continue;
                    }
                    for (Object t : tabs) {
                        if (!(t instanceof Map<?, ?> tab) || !(tab.get("tabId") instanceof String tabId)) {
                            continue;
                        }
                        String tabTitle = tab.get("title") instanceof String s ? s : null;
                        Integer from = 0;
                        while (from != null) {
                            Map<?, ?> part = call(calls, "notebook.outline", Map.of("tabId", tabId, "from", from));
                            if (part == null || !(part.get("pages") instanceof List<?> pages)) {
                                return null;
                            }
                            for (Object p : pages) {
                                if (p instanceof Map<?, ?> page && page.get("pageId") instanceof String id) {
                                    out.add(new Page(id, page.get("title") instanceof String s ? s : null, tabTitle,
                                            page.get("updatedAt") instanceof Number n ? n.longValue() : 0L));
                                    if (out.size() >= Intake.NOTEBOOK_MAX) {
                                        return out;
                                    }
                                }
                            }
                            Integer next = part.get("next") instanceof Number n ? n.intValue() : null;
                            // A cursor that doesn't move on ends the tab (DOC2-I3): the outline isn't whole then.
                            if (next != null && next <= from) {
                                return null;
                            }
                            from = next;
                        }
                    }
                }
                return out;
            }

            @Override
            public Body page(String pageId) throws Exception {
                StringBuilder md = new StringBuilder();
                String title = null;
                boolean untrusted = false;
                Integer from = 0;
                while (from != null && md.length() < PAGE_CHARS) {
                    Map<?, ?> part = call(calls, "notebook.page.markdown", Map.of("pageId", pageId, "from", from));
                    if (part == null) {
                        return null;
                    }
                    if (Boolean.TRUE.equals(part.get("trashed"))) {
                        return null;
                    }
                    if (title == null && part.get("title") instanceof String t) {
                        title = t;
                    }
                    untrusted |= Boolean.TRUE.equals(part.get("untrusted"));
                    if (part.get("markdown") instanceof String m) {
                        md.append(m);
                    }
                    Integer next = part.get("next") instanceof Number n ? n.intValue() : null;
                    from = next != null && next > from ? next : null;
                }
                return new Body(title, md.length() > PAGE_CHARS ? md.substring(0, PAGE_CHARS) : md.toString(), untrusted);
            }

            @Override
            public boolean gone(String pageId) throws Exception {
                return NotebookDocs.gone(calls, pageId);
            }
        };
    }

    /** Notebook's own word that a page is gone: {@code not_found}, or the page in the Trash. Anything else says nothing. */
    static boolean gone(NotebookCalls calls, String pageId) throws InterruptedException {
        try {
            Object r = calls.call(Caller.THE_OWNER, "notebook.page.markdown", Map.of("pageId", pageId, "from", 0, "max", 1), false);
            return r instanceof Map<?, ?> m && Boolean.TRUE.equals(m.get("trashed"));
        } catch (RpcException e) {
            return RpcException.NOT_FOUND.equals(e.code()) && !"notebook".equals(e.details() == null ? null : e.details().get("reason"));
        }
    }

    private static Map<?, ?> call(NotebookCalls calls, String method, Map<String, Object> params) throws InterruptedException {
        try {
            return calls.call(Caller.THE_OWNER, method, params, false) instanceof Map<?, ?> m ? m : null;
        } catch (RpcException e) {
            return null;
        }
    }
}
