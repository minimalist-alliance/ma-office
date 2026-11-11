package com.minimalistalliance.desk.deskd.files;

import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.util.Arrays;
import java.util.Map;

/**
 * {@link ImportFiles} over the tree: one read through {@link SafeTree#openRead}. Logs no path or name.
 */
final class TreeImports implements ImportFiles {

    private final SafeTree tree;

    TreeImports(SafeTree tree) {
        this.tree = tree;
    }

    @Override
    public Read read(String path, long maxBytes) throws RpcException {
        String[] comps = PathRules.parse(path, false, "path");
        SafeTree.Opened opened;
        try {
            opened = tree.openRead(comps);
        } catch (SafeTree.TreeException e) {
            if (e.kind() == SafeTree.Kind.NOT_A_DIR) {
                throw Errs.invalid("is_a_folder");
            }
            throw Errs.of(e);
        }
        try (FileChannel channel = opened.channel()) {
            if (opened.size() > maxBytes) {
                throw new RpcException(RpcException.TOO_LARGE, "The file is too large to import", Map.of("limit", maxBytes));
            }
            ByteBuffer into = ByteBuffer.allocate((int) opened.size());
            while (into.hasRemaining()) {
                if (channel.read(into) < 0) {
                    break;
                }
            }
            // A file that grew while it was read is taken as it was when opened.
            byte[] bytes = into.position() == into.capacity() ? into.array() : Arrays.copyOf(into.array(), into.position());
            return new Read(bytes, opened.size(), opened.mtimeMs());
        } catch (IOException e) {
            throw Errs.io(e);
        }
    }
}
