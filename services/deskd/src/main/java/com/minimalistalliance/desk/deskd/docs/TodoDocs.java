package com.minimalistalliance.desk.deskd.docs;

import com.minimalistalliance.desk.deskd.todo.TodoModule;
import com.minimalistalliance.desk.deskd.todo.TodoStore;

/** To-do's open items that point at a document's copy (API.md §25, step 4 of the place): a file path or a message. */
public final class TodoDocs {

    private TodoDocs() {}

    public static Docs.TodoLinks of(TodoModule todo) {
        return (sourceKind, ref) -> {
            TodoStore store = todo.store();
            if (store == null || ref == null) {
                return null;
            }
            try {
                if (ref.startsWith("f:")) {
                    return store.openDueFor("files", "path", ref.substring(2));
                }
                if (ref.startsWith("m:")) {
                    int hash = ref.indexOf('#');
                    return store.openDueFor("courier", "messageId", ref.substring(2, hash < 0 ? ref.length() : hash));
                }
            } catch (java.sql.SQLException | RuntimeException e) {
                return null;
            }
            return null;
        };
    }
}
