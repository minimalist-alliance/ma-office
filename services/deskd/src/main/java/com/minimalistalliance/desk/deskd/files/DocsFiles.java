package com.minimalistalliance.desk.deskd.files;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.function.Consumer;

/**
 * Documents' narrow way into Files (deskd {@code API.md} §25, the draft ADR "Documents" decision 1): list a folder, read a
 * file's bytes (up to a cap) with its SHA-256, and hear folder changes. It reads only; moving to the trash ("Tidy up"),
 * renaming on the member's tap and restoring a version go through Files' own agent door ({@link #files()}), so the trash,
 * quota and change feed stay Files'. The trash and the uploads' staging are never listed.
 */
public final class DocsFiles {

    private final SafeTree tree;
    private final ChangeFeed feed;
    private final AgentFiles files;

    DocsFiles(SafeTree tree, ChangeFeed feed, AgentFiles files) {
        this.tree = tree;
        this.feed = feed;
        this.files = files;
    }

    /** A folder's entry: a name, whether it's a folder, its size and modified time. */
    public record Entry(String name, boolean dir, long size, long mtimeMs) {}

    /** A file's bytes and their SHA-256, or {@code null} bytes when the file is over the cap (the hash is still whole). */
    public record Bytes(byte[] bytes, String sha256, long size, long mtimeMs) {}

    /** Hears each folder whose listing changed ({@code ""} for the root, null for "the trash changed"). */
    public void listen(Consumer<String> folder) {
        feed.listen(folder);
    }

    /** A folder's entries (at most {@code max}), never the root's reserved ones (the trash, uploads). */
    public List<Entry> list(String path, int max) throws IOException {
        String[] comps = comps(path);
        List<Entry> out = new ArrayList<>();
        SafeTree.Entry after = null;
        try {
            while (out.size() < max) {
                SafeTree.Page page = tree.list(comps, after, Math.min(500, max - out.size()), true);
                for (SafeTree.Entry e : page.entries()) {
                    out.add(new Entry(e.name(), e.dir(), e.size(), e.mtimeMs()));
                }
                if (page.next() == null || page.entries().isEmpty()) {
                    break;
                }
                after = page.entries().get(page.entries().size() - 1);
            }
        } catch (SafeTree.TreeException e) {
            throw new IOException("list");
        }
        return out;
    }

    /** One file's size and modified time, or null when it isn't there (or is a folder). */
    public Entry stat(String path) throws IOException {
        try {
            SafeTree.Entry e = tree.stat(comps(path));
            return e == null || e.dir() ? null : new Entry(e.name(), false, e.size(), e.mtimeMs());
        } catch (SafeTree.TreeException e) {
            throw new IOException("stat");
        }
    }

    /** The file's bytes up to {@code cap} (null past it) and the SHA-256 of all of it, read once with no-follow. */
    public Bytes read(String path, long cap) throws IOException {
        SafeTree.Opened opened;
        try {
            opened = tree.openRead(comps(path));
        } catch (SafeTree.TreeException e) {
            throw new IOException("open");
        }
        try (FileChannel ch = opened.channel()) {
            long size = opened.size();
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            boolean keep = size <= cap;
            byte[] all = keep ? new byte[(int) size] : null;
            ByteBuffer buf = ByteBuffer.allocate(64 * 1024);
            long at = 0;
            while (true) {
                buf.clear();
                int n = ch.read(buf, at);
                if (n < 0) {
                    break;
                }
                digest.update(buf.array(), 0, n);
                if (keep) {
                    if (at + n > all.length) {
                        // It grew while it was read: hash what's there, keep nothing.
                        keep = false;
                        all = null;
                    } else {
                        System.arraycopy(buf.array(), 0, all, (int) at, n);
                    }
                }
                at += n;
            }
            if (keep && at != all.length) {
                all = java.util.Arrays.copyOf(all, (int) at);
            }
            return new Bytes(all, HexFormat.of().formatHex(digest.digest()), at, opened.mtimeMs());
        } catch (NoSuchAlgorithmException e) {
            throw new IOException("sha256");
        }
    }

    /** Files' agent door, for the member-tapped changes (trash, rename, restore), which keep Files' own rules. */
    public AgentFiles files() {
        return files;
    }

    /** Files' own grammar (the member's names, whatever they hold), never the trash or the uploads' staging. */
    private static String[] comps(String path) throws IOException {
        try {
            return PathRules.parse(path == null || path.equals("/") ? "" : path, true, "path");
        } catch (com.minimalistalliance.desk.deskd.rpc.RpcException e) {
            throw new IOException("path");
        }
    }
}
