package com.minimalistalliance.desk.courier.testkit;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.util.Base64;
import java.util.List;
import java.util.SplittableRandom;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * Attachment bodies for the generator: real small PNGs (stored deflate, so the bytes don't depend on the JDK's zlib),
 * the usual 1x1 GIF, real ZIPs (stored entries, fixed times), and files of a type's leading bytes followed by filler.
 */
final class Blobs {

    private Blobs() {
    }

    /** The 1x1 transparent GIF every tracking pixel uses. */
    static final byte[] PIXEL_GIF = Base64.getDecoder().decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");

    /** A real PNG, {@code w} by {@code h} RGB, its pixels from {@code rnd}. */
    static byte[] png(SplittableRandom rnd, int w, int h) {
        ByteArrayOutputStream raw = new ByteArrayOutputStream();
        for (int y = 0; y < h; y++) {
            raw.write(0);
            for (int x = 0; x < w * 3; x++) {
                raw.write(rnd.nextInt(256));
            }
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.writeBytes(new byte[] {(byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'});
        ByteArrayOutputStream ihdr = new ByteArrayOutputStream();
        int32(ihdr, w);
        int32(ihdr, h);
        ihdr.writeBytes(new byte[] {8, 2, 0, 0, 0});
        chunk(out, "IHDR", ihdr.toByteArray());
        chunk(out, "IDAT", zlibStored(raw.toByteArray()));
        chunk(out, "IEND", new byte[0]);
        return out.toByteArray();
    }

    private static void chunk(ByteArrayOutputStream out, String type, byte[] data) {
        int32(out, data.length);
        byte[] t = type.getBytes(StandardCharsets.US_ASCII);
        out.writeBytes(t);
        out.writeBytes(data);
        CRC32 crc = new CRC32();
        crc.update(t);
        crc.update(data);
        int32(out, (int) crc.getValue());
    }

    /** zlib with stored (uncompressed) deflate blocks: the same bytes on any JDK. */
    private static byte[] zlibStored(byte[] data) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(0x78);
        out.write(0x01);
        int pos = 0;
        do {
            int len = Math.min(65535, data.length - pos);
            boolean last = pos + len >= data.length;
            out.write(last ? 1 : 0);
            out.write(len & 0xff);
            out.write(len >> 8);
            out.write(~len & 0xff);
            out.write((~len >> 8) & 0xff);
            out.write(data, pos, len);
            pos += len;
        } while (pos < data.length);
        int a = 1;
        int b = 0;
        for (byte x : data) {
            a = (a + (x & 0xff)) % 65521;
            b = (b + a) % 65521;
        }
        int32(out, (b << 16) | a);
        return out.toByteArray();
    }

    private static void int32(ByteArrayOutputStream out, int v) {
        out.write(v >>> 24);
        out.write(v >>> 16);
        out.write(v >>> 8);
        out.write(v);
    }

    /** One entry of a ZIP: a path and its bytes. */
    record Entry(String path, byte[] data) {
    }

    /** A real ZIP of stored entries, every time 2026-01-01 00:00, so it's the same bytes on any JDK. */
    static byte[] zip(List<Entry> entries) {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(bytes, StandardCharsets.UTF_8)) {
            for (Entry e : entries) {
                ZipEntry z = new ZipEntry(e.path());
                z.setMethod(ZipEntry.STORED);
                z.setSize(e.data().length);
                z.setCompressedSize(e.data().length);
                CRC32 crc = new CRC32();
                crc.update(e.data());
                z.setCrc(crc.getValue());
                z.setTimeLocal(LocalDateTime.of(2026, 1, 1, 0, 0));
                zip.putNextEntry(z);
                zip.write(e.data());
                zip.closeEntry();
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        return bytes.toByteArray();
    }

    /** {@code size} bytes: {@code magic}, then filler from {@code rnd}. */
    static byte[] stub(SplittableRandom rnd, byte[] magic, int size) {
        byte[] out = new byte[Math.max(size, magic.length)];
        System.arraycopy(magic, 0, out, 0, magic.length);
        for (int i = magic.length; i < out.length; i++) {
            out[i] = (byte) rnd.nextInt(256);
        }
        return out;
    }

    /** Text of about {@code size} bytes, lines of a CSV. */
    static byte[] csv(SplittableRandom rnd, int size) {
        StringBuilder s = new StringBuilder("date,item,amount\r\n");
        while (s.length() < size) {
            s.append("2026-").append(1 + rnd.nextInt(12)).append('-').append(1 + rnd.nextInt(28)).append(",item ")
                    .append(rnd.nextInt(1000)).append(',').append(rnd.nextInt(100_000) / 100.0).append("\r\n");
        }
        return s.toString().getBytes(StandardCharsets.US_ASCII);
    }

    static byte[] ascii(String s) {
        return s.getBytes(StandardCharsets.US_ASCII);
    }
}
