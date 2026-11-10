package com.minimalistalliance.desk.agent.icon;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.CRC32;
import java.util.zip.Deflater;

/** A small PNG writer for tests: every colour type and bit depth, palette, tRNS, Adam7, all five filters, extras. */
final class TestPng {

    static final byte[] SIGNATURE = {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10};
    private static final int[] X0 = {0, 4, 0, 2, 0, 1, 0};
    private static final int[] Y0 = {0, 0, 4, 0, 2, 0, 1};
    private static final int[] DX = {8, 8, 4, 4, 2, 2, 1};
    private static final int[] DY = {8, 8, 8, 4, 4, 2, 2};

    int width;
    int height;
    int depth;
    int type;
    boolean interlace;
    /** samples[y * width + x][channel], each in 0 .. 2^depth - 1. */
    int[][] samples;
    byte[] palette;
    byte[] trns;
    /** -1: rotate through the five filters row by row; else that filter for every row. */
    int filter = -1;
    /** IDAT is cut into pieces of this many bytes; 0 for one chunk. */
    int idatSplit;
    final List<byte[]> afterIhdr = new ArrayList<>();
    final List<byte[]> afterIdat = new ArrayList<>();

    TestPng(int width, int height, int type, int depth, boolean interlace) {
        this.width = width;
        this.height = height;
        this.type = type;
        this.depth = depth;
        this.interlace = interlace;
    }

    static int channels(int type) {
        return switch (type) {
            case 2 -> 3;
            case 4 -> 2;
            case 6 -> 4;
            default -> 1;
        };
    }

    byte[] ihdr() {
        byte[] d = new byte[13];
        putInt(d, 0, width);
        putInt(d, 4, height);
        d[8] = (byte) depth;
        d[9] = (byte) type;
        d[12] = (byte) (interlace ? 1 : 0);
        return d;
    }

    /** The image data before filtering and deflating... after filtering: what the zlib stream holds. */
    byte[] filteredStream() {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int bitsPerPixel = channels(type) * depth;
        int bpp = Math.max(1, bitsPerPixel / 8);
        int rowNo = 0;
        int passes = interlace ? 7 : 1;
        for (int p = 0; p < passes; p++) {
            int x0 = interlace ? X0[p] : 0;
            int y0 = interlace ? Y0[p] : 0;
            int dx = interlace ? DX[p] : 1;
            int dy = interlace ? DY[p] : 1;
            byte[] prev = null;
            for (int y = y0; y < height; y += dy) {
                int pixels = 0;
                for (int x = x0; x < width; x += dx) {
                    pixels++;
                }
                if (pixels == 0) {
                    continue;
                }
                byte[] row = new byte[(pixels * bitsPerPixel + 7) / 8];
                int bit = 0;
                for (int x = x0; x < width; x += dx) {
                    for (int s : samples[y * width + x]) {
                        for (int b = depth - 1; b >= 0; b--) {
                            if (((s >> b) & 1) != 0) {
                                row[bit >> 3] |= (byte) (0x80 >> (bit & 7));
                            }
                            bit++;
                        }
                    }
                }
                int ft = filter >= 0 ? filter : rowNo % 5;
                rowNo++;
                out.write(ft);
                byte[] f = new byte[row.length];
                for (int i = 0; i < row.length; i++) {
                    int a = i >= bpp ? row[i - bpp] & 0xff : 0;
                    int b = prev == null ? 0 : prev[i] & 0xff;
                    int c = i >= bpp && prev != null ? prev[i - bpp] & 0xff : 0;
                    int x = row[i] & 0xff;
                    int pred = switch (ft) {
                        case 0 -> 0;
                        case 1 -> a;
                        case 2 -> b;
                        case 3 -> (a + b) >> 1;
                        default -> paeth(a, b, c);
                    };
                    f[i] = (byte) (x - pred);
                }
                out.writeBytes(f);
                prev = row;
            }
        }
        return out.toByteArray();
    }

    private static int paeth(int a, int b, int c) {
        int p = a + b - c;
        int pa = Math.abs(p - a);
        int pb = Math.abs(p - b);
        int pc = Math.abs(p - c);
        return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
    }

    byte[] build() {
        return build(zlib(filteredStream()));
    }

    /** The whole file with the given zlib stream as the image data. */
    byte[] build(byte[] zlibData) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.writeBytes(SIGNATURE);
        out.writeBytes(chunk("IHDR", ihdr()));
        afterIhdr.forEach(out::writeBytes);
        if (palette != null) {
            out.writeBytes(chunk("PLTE", palette));
        }
        if (trns != null) {
            out.writeBytes(chunk("tRNS", trns));
        }
        if (idatSplit > 0) {
            for (int i = 0; i < zlibData.length; i += idatSplit) {
                int n = Math.min(idatSplit, zlibData.length - i);
                out.writeBytes(chunk("IDAT", java.util.Arrays.copyOfRange(zlibData, i, i + n)));
            }
        } else {
            out.writeBytes(chunk("IDAT", zlibData));
        }
        afterIdat.forEach(out::writeBytes);
        out.writeBytes(chunk("IEND", new byte[0]));
        return out.toByteArray();
    }

    // ------------------------------------------------------------ pieces

    static byte[] chunk(String type, byte[] data) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] t = type.getBytes(StandardCharsets.US_ASCII);
        byte[] len = new byte[4];
        putInt(len, 0, data.length);
        out.writeBytes(len);
        out.writeBytes(t);
        out.writeBytes(data);
        CRC32 crc = new CRC32();
        crc.update(t);
        crc.update(data);
        byte[] c = new byte[4];
        putInt(c, 0, (int) crc.getValue());
        out.writeBytes(c);
        return out.toByteArray();
    }

    static byte[] zlib(byte[] raw) {
        Deflater d = new Deflater(6);
        d.setInput(raw);
        d.finish();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        while (!d.finished()) {
            out.write(buf, 0, d.deflate(buf));
        }
        d.end();
        return out.toByteArray();
    }

    static byte[] concat(byte[]... parts) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] p : parts) {
            out.writeBytes(p);
        }
        return out.toByteArray();
    }

    static void putInt(byte[] b, int off, int v) {
        b[off] = (byte) (v >>> 24);
        b[off + 1] = (byte) (v >>> 16);
        b[off + 2] = (byte) (v >>> 8);
        b[off + 3] = (byte) v;
    }

    /** The chunk types of a PNG file, in order, and their data. */
    static List<String> chunkTypes(byte[] png) {
        List<String> out = new ArrayList<>();
        int pos = 8;
        while (pos < png.length) {
            int len = ((png[pos] & 0xff) << 24) | ((png[pos + 1] & 0xff) << 16) | ((png[pos + 2] & 0xff) << 8)
                    | (png[pos + 3] & 0xff);
            out.add(new String(png, pos + 4, 4, StandardCharsets.US_ASCII));
            pos += 12 + len;
        }
        return out;
    }
}
