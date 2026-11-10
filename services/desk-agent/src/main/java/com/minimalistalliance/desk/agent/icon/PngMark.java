package com.minimalistalliance.desk.agent.icon;

import com.minimalistalliance.desk.agent.icon.IconException.Reason;
import java.io.ByteArrayOutputStream;
import java.util.zip.CRC32;
import java.util.zip.DataFormatException;
import java.util.zip.Deflater;
import java.util.zip.Inflater;

/**
 * Turns an uploaded PNG into a single-colour mark (docs/multi-agent.md section 7), with {@code java.util.zip} only:
 * no {@code javax.imageio}, so the container never loads AWT's natives.
 *
 * <p>The decode is a real one, strict: the size caps, every chunk's length and CRC-32, IHDR first and legal, PLTE and
 * tRNS where the standard puts them, IDATs consecutive, IEND last with nothing after it, the image data inflated to
 * exactly the size the header implies (a decompression bomb stops at that bound, and too little data is as corrupt
 * as too much) and unfiltered, Adam7 included. Ancillary chunks (text, EXIF, ICC, time, APNG's frames, anything
 * else) are read past and dropped; an unknown critical chunk is corrupt.
 *
 * <p>The mask is each pixel's coverage: its alpha, or with no transparency at all its distance from the border's
 * median brightness (so white on dark works as well as dark on light). Coverage under 24 is dropped, the rest is
 * stretched so its 98th percentile is full (a red logo is a full mark, never a grey one), and the shape is trimmed and
 * centred in a square with an 8% margin. A picture with no shape ({@code NO_SHAPE}) or lines too thin to see at icon
 * size ({@code TOO_THIN}) is refused. The output is a brand-new PNG: gray and alpha, 8 bits, gray always 255, no
 * interlace, and only IHDR, IDAT and IEND, so nothing of the upload's metadata survives.
 *
 * <p>Stateless and thread safe.
 */
public final class PngMark {

    /** Largest upload, in bytes. */
    public static final int MAX_INPUT_BYTES = 262_144;
    /** Largest width or height, in pixels. */
    public static final int MAX_SIDE = 512;
    /** Largest output, in bytes. */
    public static final int MAX_OUTPUT_BYTES = 512 * 1024;
    /** Largest IDAT chunk the output uses. */
    static final int IDAT_MAX = 64 * 1024;

    private static final byte[] SIGNATURE = {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10};
    private static final int IHDR = 0x49484452;
    private static final int PLTE = 0x504C5445;
    private static final int IDAT = 0x49444154;
    private static final int IEND = 0x49454E44;
    private static final int TRNS = 0x74524E53;

    private static final int[] ADAM_X0 = {0, 4, 0, 2, 0, 1, 0};
    private static final int[] ADAM_Y0 = {0, 0, 4, 0, 2, 0, 1};
    private static final int[] ADAM_DX = {8, 8, 4, 4, 2, 2, 1};
    private static final int[] ADAM_DY = {8, 8, 8, 4, 4, 2, 2};

    private PngMark() {}

    /**
     * Decodes {@code png} and answers the mask as a new PNG.
     *
     * @throws IconException {@code NOT_PNG}, {@code TOO_LARGE}, {@code TOO_MANY_PIXELS}, {@code CORRUPT},
     *     {@code NO_SHAPE} or {@code TOO_THIN}
     */
    public static byte[] mask(byte[] png) throws IconException {
        Decoded d = parse(png);
        return encode(d.pixels(), d.header());
    }

    /** What {@link #parse} found. */
    record Decoded(Pixels pixels, Header header) {}

    /** The strict decode alone. */
    static Decoded parse(byte[] png) throws IconException {
        if (png == null) {
            throw new IconException(Reason.NOT_PNG);
        }
        if (png.length > MAX_INPUT_BYTES) {
            throw new IconException(Reason.TOO_LARGE);
        }
        if (png.length < SIGNATURE.length) {
            throw new IconException(Reason.NOT_PNG);
        }
        for (int i = 0; i < SIGNATURE.length; i++) {
            if (png[i] != SIGNATURE[i]) {
                throw new IconException(Reason.NOT_PNG);
            }
        }
        Header h = null;
        byte[] palette = null; // r,g,b triples
        byte[] trns = null;
        boolean sawIdat = false;
        boolean idatDone = false;
        ByteArrayOutputStream idat = new ByteArrayOutputStream();
        int pos = SIGNATURE.length;
        while (true) {
            if (png.length - pos < 12) {
                throw corrupt(); // truncated, or no IEND
            }
            long len = u32(png, pos);
            if (len > png.length - pos - 12L) {
                throw corrupt();
            }
            int l = (int) len;
            int type = (int) u32(png, pos + 4);
            int data = pos + 8;
            CRC32 crc = new CRC32();
            crc.update(png, pos + 4, 4 + l);
            if (crc.getValue() != u32(png, data + l)) {
                throw corrupt();
            }
            for (int i = 0; i < 4; i++) {
                int c = (type >>> (24 - 8 * i)) & 0xff;
                if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'))) {
                    throw corrupt();
                }
            }
            pos += 12 + l;
            if (h == null) {
                if (type != IHDR) {
                    throw corrupt();
                }
                h = header(png, data, l);
                continue;
            }
            if (type == IDAT) {
                if (idatDone) {
                    throw corrupt(); // IDATs must be consecutive
                }
                sawIdat = true;
                idat.write(png, data, l);
                continue;
            }
            if (sawIdat) {
                idatDone = true;
            }
            switch (type) {
                case IHDR -> throw corrupt();
                case PLTE -> {
                    if (sawIdat || palette != null || trns != null || h.colorType == 0 || h.colorType == 4
                            || l == 0 || l % 3 != 0 || l / 3 > 256
                            || (h.colorType == 3 && l / 3 > (1 << h.bitDepth))) {
                        throw corrupt();
                    }
                    palette = java.util.Arrays.copyOfRange(png, data, data + l);
                }
                case TRNS -> {
                    if (sawIdat || trns != null) {
                        throw corrupt();
                    }
                    switch (h.colorType) {
                        case 0 -> {
                            if (l != 2) {
                                throw corrupt();
                            }
                        }
                        case 2 -> {
                            if (l != 6) {
                                throw corrupt();
                            }
                        }
                        case 3 -> {
                            if (palette == null || l > palette.length / 3) {
                                throw corrupt();
                            }
                        }
                        default -> {
                            continue; // not allowed for the alpha types; read past it
                        }
                    }
                    trns = java.util.Arrays.copyOfRange(png, data, data + l);
                }
                case IEND -> {
                    if (l != 0 || !sawIdat || pos != png.length) {
                        throw corrupt();
                    }
                    if (h.colorType == 3 && palette == null) {
                        throw corrupt();
                    }
                    return new Decoded(decode(h, palette, trns, idat.toByteArray()), h);
                }
                default -> {
                    if (((type >>> 24) & 0x20) == 0) {
                        throw corrupt(); // an unknown critical chunk
                    }
                }
            }
        }
    }

    // ---------------------------------------------------------------- header

    record Header(int width, int height, int bitDepth, int colorType, boolean interlaced) {
        int channels() {
            return switch (colorType) {
                case 2 -> 3;
                case 4 -> 2;
                case 6 -> 4;
                default -> 1;
            };
        }

        int bitsPerPixel() {
            return channels() * bitDepth;
        }
    }

    private static Header header(byte[] b, int off, int len) throws IconException {
        if (len != 13) {
            throw corrupt();
        }
        long w = u32(b, off);
        long ht = u32(b, off + 4);
        if (w > MAX_SIDE || ht > MAX_SIDE) {
            throw new IconException(Reason.TOO_MANY_PIXELS);
        }
        if (w == 0 || ht == 0) {
            throw corrupt();
        }
        int depth = b[off + 8] & 0xff;
        int type = b[off + 9] & 0xff;
        boolean legal = switch (type) {
            case 0 -> depth == 1 || depth == 2 || depth == 4 || depth == 8 || depth == 16;
            case 2, 4, 6 -> depth == 8 || depth == 16;
            case 3 -> depth == 1 || depth == 2 || depth == 4 || depth == 8;
            default -> false;
        };
        int interlace = b[off + 12] & 0xff;
        if (!legal || b[off + 10] != 0 || b[off + 11] != 0 || interlace > 1) {
            throw corrupt();
        }
        return new Header((int) w, (int) ht, depth, type, interlace == 1);
    }

    // ---------------------------------------------------------------- decode

    /** Per-pixel alpha and darkness-source luma, 0-255 each, row-major. */
    record Pixels(byte[] alpha, byte[] luma) {}

    private static Pixels decode(Header h, byte[] palette, byte[] trns, byte[] zlib) throws IconException {
        int bpp = h.bitsPerPixel();
        int passes = h.interlaced() ? 7 : 1;
        long expected = 0;
        for (int p = 0; p < passes; p++) {
            int pw = passWidth(h, p);
            int ph = passHeight(h, p);
            if (pw > 0 && ph > 0) {
                expected += (long) ph * (1 + ((long) pw * bpp + 7) / 8);
            }
        }
        byte[] raw = inflateExactly(zlib, (int) expected);

        int w = h.width();
        byte[] alpha = new byte[w * h.height()];
        byte[] luma = new byte[w * h.height()];
        int palCount = palette == null ? 0 : palette.length / 3;
        int keyGray = -1;
        int keyR = -1;
        int keyG = -1;
        int keyB = -1;
        if (trns != null && h.colorType() == 0) {
            keyGray = ((trns[0] & 0xff) << 8) | (trns[1] & 0xff);
        } else if (trns != null && h.colorType() == 2) {
            keyR = ((trns[0] & 0xff) << 8) | (trns[1] & 0xff);
            keyG = ((trns[2] & 0xff) << 8) | (trns[3] & 0xff);
            keyB = ((trns[4] & 0xff) << 8) | (trns[5] & 0xff);
        }
        int depth = h.bitDepth();
        int pixelBytes = Math.max(1, bpp / 8);
        int off = 0;
        for (int p = 0; p < passes; p++) {
            int pw = passWidth(h, p);
            int ph = passHeight(h, p);
            if (pw == 0 || ph == 0) {
                continue;
            }
            int rb = (int) (((long) pw * bpp + 7) / 8);
            byte[] prev = new byte[rb];
            byte[] cur = new byte[rb];
            int x0 = h.interlaced() ? ADAM_X0[p] : 0;
            int y0 = h.interlaced() ? ADAM_Y0[p] : 0;
            int dx = h.interlaced() ? ADAM_DX[p] : 1;
            int dy = h.interlaced() ? ADAM_DY[p] : 1;
            for (int row = 0; row < ph; row++) {
                int ft = raw[off++] & 0xff;
                System.arraycopy(raw, off, cur, 0, rb);
                off += rb;
                unfilter(ft, cur, prev, pixelBytes);
                int y = y0 + row * dy;
                for (int i = 0; i < pw; i++) {
                    int a;
                    int l;
                    switch (h.colorType()) {
                        case 0 -> {
                            int g = sample(cur, i, depth);
                            a = g == keyGray ? 0 : 255;
                            l = scale(g, depth);
                        }
                        case 2 -> {
                            int r = sample(cur, 3 * i, depth);
                            int g = sample(cur, 3 * i + 1, depth);
                            int b = sample(cur, 3 * i + 2, depth);
                            a = (r == keyR && g == keyG && b == keyB) ? 0 : 255;
                            l = luma(scale(r, depth), scale(g, depth), scale(b, depth));
                        }
                        case 3 -> {
                            int idx = sample(cur, i, depth);
                            if (idx >= palCount) {
                                throw corrupt();
                            }
                            a = trns != null && idx < trns.length ? trns[idx] & 0xff : 255;
                            l = luma(palette[3 * idx] & 0xff, palette[3 * idx + 1] & 0xff, palette[3 * idx + 2] & 0xff);
                        }
                        case 4 -> {
                            l = scale(sample(cur, 2 * i, depth), depth);
                            a = scale(sample(cur, 2 * i + 1, depth), depth);
                        }
                        default -> {
                            int r = scale(sample(cur, 4 * i, depth), depth);
                            int g = scale(sample(cur, 4 * i + 1, depth), depth);
                            int b = scale(sample(cur, 4 * i + 2, depth), depth);
                            l = luma(r, g, b);
                            a = scale(sample(cur, 4 * i + 3, depth), depth);
                        }
                    }
                    int at = y * w + x0 + i * dx;
                    alpha[at] = (byte) a;
                    luma[at] = (byte) l;
                }
                byte[] t = prev;
                prev = cur;
                cur = t;
            }
        }
        return new Pixels(alpha, luma);
    }

    private static int passWidth(Header h, int p) {
        if (!h.interlaced()) {
            return h.width();
        }
        return h.width() > ADAM_X0[p] ? (h.width() - ADAM_X0[p] + ADAM_DX[p] - 1) / ADAM_DX[p] : 0;
    }

    private static int passHeight(Header h, int p) {
        if (!h.interlaced()) {
            return h.height();
        }
        return h.height() > ADAM_Y0[p] ? (h.height() - ADAM_Y0[p] + ADAM_DY[p] - 1) / ADAM_DY[p] : 0;
    }

    /** Inflates to exactly {@code size} bytes: more or fewer is corrupt, so a bomb stops at the bound. */
    private static byte[] inflateExactly(byte[] zlib, int size) throws IconException {
        Inflater inf = new Inflater();
        try {
            inf.setInput(zlib);
            byte[] out = new byte[size];
            int n = 0;
            while (n < size) {
                int got = inf.inflate(out, n, size - n);
                if (got == 0) {
                    // Needs input (too little data), needs a dictionary, or finished early: all corrupt.
                    throw corrupt();
                }
                n += got;
            }
            // Exactly full: the stream must end here, with its checksum good and nothing after it.
            byte[] probe = new byte[1];
            if (inf.inflate(probe) != 0 || !inf.finished() || inf.getRemaining() != 0) {
                throw corrupt();
            }
            return out;
        } catch (DataFormatException e) {
            throw corrupt();
        } finally {
            inf.end();
        }
    }

    private static void unfilter(int type, byte[] cur, byte[] prev, int bpp) throws IconException {
        int n = cur.length;
        switch (type) {
            case 0 -> { }
            case 1 -> {
                for (int i = bpp; i < n; i++) {
                    cur[i] = (byte) (cur[i] + cur[i - bpp]);
                }
            }
            case 2 -> {
                for (int i = 0; i < n; i++) {
                    cur[i] = (byte) (cur[i] + prev[i]);
                }
            }
            case 3 -> {
                for (int i = 0; i < n; i++) {
                    int left = i >= bpp ? cur[i - bpp] & 0xff : 0;
                    cur[i] = (byte) (cur[i] + ((left + (prev[i] & 0xff)) >> 1));
                }
            }
            case 4 -> {
                for (int i = 0; i < n; i++) {
                    int a = i >= bpp ? cur[i - bpp] & 0xff : 0;
                    int b = prev[i] & 0xff;
                    int c = i >= bpp ? prev[i - bpp] & 0xff : 0;
                    int pa = Math.abs(b - c);
                    int pb = Math.abs(a - c);
                    int pc = Math.abs(a + b - 2 * c);
                    int pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
                    cur[i] = (byte) (cur[i] + pr);
                }
            }
            default -> throw corrupt();
        }
    }

    /** Sample number {@code idx} of a row, at {@code depth} bits. */
    private static int sample(byte[] row, int idx, int depth) {
        return switch (depth) {
            case 8 -> row[idx] & 0xff;
            case 16 -> ((row[2 * idx] & 0xff) << 8) | (row[2 * idx + 1] & 0xff);
            default -> {
                int bit = idx * depth;
                int shift = 8 - depth - (bit & 7);
                yield ((row[bit >> 3] & 0xff) >> shift) & ((1 << depth) - 1);
            }
        };
    }

    /** A sample at {@code depth} bits scaled to 0-255, exactly (rounded for 16 bits). */
    private static int scale(int v, int depth) {
        return switch (depth) {
            case 8 -> v;
            case 16 -> (int) (((long) v * 255 + 32_767) / 65_535);
            default -> v * 255 / ((1 << depth) - 1);
        };
    }

    /** Rec. 709 luma of 8-bit components, rounded. */
    private static int luma(int r, int g, int b) {
        return (2126 * r + 7152 * g + 722 * b + 5000) / 10_000;
    }

    // ---------------------------------------------------------------- encode

    /** Coverage before the floor, for tests: what {@link #mask} starts from, without any refusal. */
    static int[] coverageOf(byte[] png) throws IconException {
        Decoded d = parse(png);
        return coverage(d.pixels(), d.header().width(), d.header().height(), false);
    }

    /**
     * Each pixel's coverage: its alpha, or, with no transparency anywhere, its distance from the median brightness of
     * the one-pixel border. With {@code strict}, a border whose brightness varies by more than
     * {@link #BORDER_SPREAD} (no plain background) is {@code NO_SHAPE}.
     */
    private static int[] coverage(Pixels px, int w, int ht, boolean strict) throws IconException {
        byte[] alpha = px.alpha();
        byte[] luma = px.luma();
        boolean opaque = true;
        for (byte a : alpha) {
            if ((a & 0xff) != 255) {
                opaque = false;
                break;
            }
        }
        int[] cov = new int[w * ht];
        if (opaque) {
            int[] border = new int[2 * w + 2 * ht];
            int n = 0;
            for (int x = 0; x < w; x++) {
                border[n++] = luma[x] & 0xff;
                border[n++] = luma[(ht - 1) * w + x] & 0xff;
            }
            for (int y = 0; y < ht; y++) {
                border[n++] = luma[y * w] & 0xff;
                border[n++] = luma[y * w + w - 1] & 0xff;
            }
            java.util.Arrays.sort(border, 0, n);
            if (strict && border[n - 1] - border[0] > BORDER_SPREAD) {
                throw new IconException(Reason.NO_SHAPE); // a photo or a busy picture, not a mark on a plain ground
            }
            int background = border[n / 2];
            for (int i = 0; i < cov.length; i++) {
                cov[i] = Math.abs((luma[i] & 0xff) - background);
            }
        } else {
            for (int i = 0; i < cov.length; i++) {
                cov[i] = alpha[i] & 0xff;
            }
        }
        return cov;
    }

    /** Coverage under this is noise or haze and becomes 0. */
    static final int FLOOR = 24;
    /** The share of the square left empty on each side of the shape, in percent. */
    static final int MARGIN_PCT = 8;
    /** The most the border's brightness may vary for a picture with no transparency (one plain background). */
    static final int BORDER_SPREAD = 20;
    /** A shape bigger than this share of its box, in percent, is a filled blob, not a mark. */
    static final int MAX_INK_PCT = 85;
    /** The size an icon is judged at, and the coverage (of 255) its strongest pixel needs there. */
    static final int THIN_PX = 28;
    static final int THIN_MIN = 128;

    /**
     * The mark: coverage from the alpha, or with no transparency the distance from the border's median brightness;
     * coverage under {@link #FLOOR} dropped; the rest stretched so its 98th percentile is full; trimmed to the shape
     * and centred in a square with an 8% margin on each side. A picture with no shape, or one too thin to see at
     * {@link #THIN_PX} pixels, is refused.
     */
    private static byte[] encode(Pixels px, Header h) throws IconException {
        int w = h.width();
        int ht = h.height();
        int[] cov = coverage(px, w, ht, true);

        // Floor, and the box and count of what is left.
        int[] hist = new int[256];
        int ink = 0;
        int x0 = w;
        int y0 = ht;
        int x1 = -1;
        int y1 = -1;
        for (int y = 0; y < ht; y++) {
            for (int x = 0; x < w; x++) {
                int i = y * w + x;
                if (cov[i] < FLOOR) {
                    cov[i] = 0;
                    continue;
                }
                hist[cov[i]]++;
                ink++;
                x0 = Math.min(x0, x);
                x1 = Math.max(x1, x);
                y0 = Math.min(y0, y);
                y1 = Math.max(y1, y);
            }
        }
        if (ink == 0) {
            throw new IconException(Reason.NO_SHAPE);
        }
        int bw = x1 - x0 + 1;
        int bh = y1 - y0 + 1;
        if ((long) ink * 100 > (long) MAX_INK_PCT * bw * bh) {
            throw new IconException(Reason.NO_SHAPE);
        }

        // Levels: the 98th percentile of what is left maps to full.
        int rank = (int) Math.ceil(ink * 0.98);
        int top = 0;
        for (int v = 0, seen = 0; v < 256; v++) {
            seen += hist[v];
            if (seen >= rank) {
                top = v;
                break;
            }
        }

        // Trim and centre in a square: the shape takes 84% of it, but never more than 512 pixels in all.
        int longest = Math.max(bw, bh);
        int side = Math.max(longest, Math.min(MAX_SIDE, (int) Math.ceil(longest * 100.0 / (100 - 2 * MARGIN_PCT))));
        int ox = (side - bw) / 2;
        int oy = (side - bh) / 2;
        int[] square = new int[side * side];
        for (int y = 0; y < bh; y++) {
            for (int x = 0; x < bw; x++) {
                int v = cov[(y0 + y) * w + x0 + x];
                square[(oy + y) * side + ox + x] = v == 0 ? 0 : Math.min(255, (v * 255 + top / 2) / top);
            }
        }

        // Thin: at icon size the strongest pixel must still be at least half covered.
        if (side > THIN_PX) {
            int best = 0;
            for (int cy = 0; cy < THIN_PX; cy++) {
                int ya = cy * side / THIN_PX;
                int yb = Math.max(ya + 1, (cy + 1) * side / THIN_PX);
                for (int cx = 0; cx < THIN_PX; cx++) {
                    int xa = cx * side / THIN_PX;
                    int xb = Math.max(xa + 1, (cx + 1) * side / THIN_PX);
                    long sum = 0;
                    for (int y = ya; y < yb; y++) {
                        for (int x = xa; x < xb; x++) {
                            sum += square[y * side + x];
                        }
                    }
                    best = Math.max(best, (int) (sum / ((long) (yb - ya) * (xb - xa))));
                }
            }
            if (best < THIN_MIN) {
                throw new IconException(Reason.TOO_THIN);
            }
        } else {
            int best = 0;
            for (int v : square) {
                best = Math.max(best, v);
            }
            if (best < THIN_MIN) {
                throw new IconException(Reason.TOO_THIN);
            }
        }

        w = side;
        ht = side;
        byte[] rows = new byte[ht * (1 + 2 * w)];
        int o = 0;
        for (int y = 0; y < ht; y++) {
            rows[o++] = 0; // filter: none
            for (int x = 0; x < w; x++) {
                rows[o++] = (byte) 255;
                rows[o++] = (byte) square[y * w + x];
            }
        }
        ByteArrayOutputStream z = new ByteArrayOutputStream();
        Deflater def = new Deflater(9);
        try {
            def.setInput(rows);
            def.finish();
            byte[] buf = new byte[8192];
            while (!def.finished()) {
                int n = def.deflate(buf);
                z.write(buf, 0, n);
            }
        } finally {
            def.end();
        }
        byte[] zdata = z.toByteArray();

        ByteArrayOutputStream out = new ByteArrayOutputStream(zdata.length + 64);
        out.write(SIGNATURE, 0, SIGNATURE.length);
        byte[] ihdr = new byte[13];
        putU32(ihdr, 0, w);
        putU32(ihdr, 4, ht);
        ihdr[8] = 8;
        ihdr[9] = 4; // gray + alpha; compression, filter, interlace stay 0
        chunk(out, IHDR, ihdr, 0, ihdr.length);
        for (int i = 0; i < zdata.length; i += IDAT_MAX) {
            chunk(out, IDAT, zdata, i, Math.min(IDAT_MAX, zdata.length - i));
        }
        chunk(out, IEND, zdata, 0, 0);
        if (out.size() > MAX_OUTPUT_BYTES) {
            throw new IconException(Reason.TOO_LARGE);
        }
        return out.toByteArray();
    }

    private static void chunk(ByteArrayOutputStream out, int type, byte[] data, int off, int len) {
        byte[] head = new byte[8];
        putU32(head, 0, len);
        putU32(head, 4, type);
        out.write(head, 0, 8);
        out.write(data, off, len);
        CRC32 crc = new CRC32();
        crc.update(head, 4, 4);
        crc.update(data, off, len);
        byte[] tail = new byte[4];
        putU32(tail, 0, (int) crc.getValue());
        out.write(tail, 0, 4);
    }

    // ---------------------------------------------------------------- bytes

    private static long u32(byte[] b, int off) {
        return ((b[off] & 0xffL) << 24) | ((b[off + 1] & 0xffL) << 16) | ((b[off + 2] & 0xffL) << 8) | (b[off + 3] & 0xffL);
    }

    private static void putU32(byte[] b, int off, int v) {
        b[off] = (byte) (v >>> 24);
        b[off + 1] = (byte) (v >>> 16);
        b[off + 2] = (byte) (v >>> 8);
        b[off + 3] = (byte) v;
    }

    private static IconException corrupt() {
        return new IconException(Reason.CORRUPT);
    }
}
