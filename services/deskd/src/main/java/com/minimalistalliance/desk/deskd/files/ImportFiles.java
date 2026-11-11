package com.minimalistalliance.desk.deskd.files;

import com.minimalistalliance.desk.deskd.rpc.RpcException;

/**
 * What the Browser's import ({@code browser.import} of bookmarks, API.md section 10, "Signing in") may do with a member's
 * Files: read one file whole, by its Files path. Nothing else of the tree is reachable through this, the path goes through
 * the same rules as every {@code files.*} call (files.md section 0), and nothing is ever changed or removed. A passwords
 * file never comes this way: it's sent over the session into deskd's memory, and one a member put in Files is left alone.
 */
public interface ImportFiles {

    /** A file as it was read: its bytes, and its size and time when it was opened. */
    record Read(byte[] bytes, long size, long mtimeMs) {}

    /**
     * The whole file.
     *
     * @throws RpcException {@code not_found}; {@code invalid} with the path's reason, or {@code is_a_folder};
     *     {@code too_large} with {@code limit}; {@code unavailable} with {@code reason: tree} if the tree can't be used
     */
    Read read(String path, long maxBytes) throws RpcException;
}
