package com.minimalistalliance.desk.agent.icon;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.agent.icon.IconException.Reason;
import java.awt.image.BufferedImage;
import java.awt.image.Raster;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import java.util.stream.Stream;
import java.util.zip.Deflater;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

class PngMarkTest {

    // ------------------------------------------------------------ helpers

    private static int max(int depth) {
        return (1 << depth) - 1;
    }

    private static int scale(int v, int depth) {
        return depth == 16 ? (int) Math.round(v * 255.0 / 65535.0) : v * 255 / max(depth);
    }

    private static int luma(int r, int g, int b) {
        return (int) Math.round((0.2126 * r + 0.7152 * g + 0.0722 * b) + 1e-9);
    }

    /** What the mask must be, worked out from the samples. */
    private static int[] expectedMask(TestPng t) {
        int n = t.width * t.height;
        int[] alpha = new int[n];
        int[] lum = new int[n];
        for (int i = 0; i < n; i++) {
            int[] s = t.samples[i];
            switch (t.type) {
                case 0 -> {
                    lum[i] = scale(s[0], t.depth);
                    alpha[i] = t.trns != null && s[0] == (((t.trns[0] & 0xff) << 8) | (t.trns[1] & 0xff)) ? 0 : 255;
                }
                case 2 -> {
                    lum[i] = luma(scale(s[0], t.depth), scale(s[1], t.depth), scale(s[2], t.depth));
                    boolean key = t.trns != null && s[0] == word(t.trns, 0) && s[1] == word(t.trns, 2)
                            && s[2] == word(t.trns, 4);
                    alpha[i] = key ? 0 : 255;
                }
                case 3 -> {
                    int k = s[0];
                    lum[i] = luma(t.palette[3 * k] & 0xff, t.palette[3 * k + 1] & 0xff, t.palette[3 * k + 2] & 0xff);
                    alpha[i] = t.trns != null && k < t.trns.length ? t.trns[k] & 0xff : 255;
                }
                case 4 -> {
                    lum[i] = scale(s[0], t.depth);
                    alpha[i] = scale(s[1], t.depth);
                }
                default -> {
                    lum[i] = luma(scale(s[0], t.depth), scale(s[1], t.depth), scale(s[2], t.depth));
                    alpha[i] = scale(s[3], t.depth);
                }
            }
        }
        boolean opaque = true;
        for (int a : alpha) {
            opaque &= a == 255;
        }
        int[] mask = new int[n];
        int background = opaque ? medianBorder(lum, t.width, t.height) : 0;
        for (int i = 0; i < n; i++) {
            mask[i] = opaque ? Math.abs(lum[i] - background) : alpha[i];
        }
        return mask;
    }

    /** The median brightness of the one-pixel border, each border pixel counted once per side it touches. */
    private static int medianBorder(int[] lum, int w, int h) {
        List<Integer> border = new ArrayList<>();
        for (int x = 0; x < w; x++) {
            border.add(lum[x]);
            border.add(lum[(h - 1) * w + x]);
        }
        for (int y = 0; y < h; y++) {
            border.add(lum[y * w]);
            border.add(lum[y * w + w - 1]);
        }
        java.util.Collections.sort(border);
        return border.get(border.size() / 2);
    }

    private static int word(byte[] b, int off) {
        return ((b[off] & 0xff) << 8) | (b[off + 1] & 0xff);
    }

    private static TestPng random(int w, int h, int type, int depth, boolean interlace, boolean translucent, long seed) {
        Random r = new Random(seed);
        TestPng t = new TestPng(w, h, type, depth, interlace);
        int ch = TestPng.channels(type);
        int limit = type == 3 ? Math.min(5, 1 << depth) : 1 << depth;
        t.samples = new int[w * h][ch];
        for (int[] px : t.samples) {
            for (int c = 0; c < ch; c++) {
                px[c] = r.nextInt(limit);
            }
            if ((type == 4 || type == 6) && !translucent) {
                px[ch - 1] = max(depth);
            }
        }
        if (type == 3) {
            int entries = Math.min(5, 1 << depth);
            t.palette = new byte[3 * entries];
            r.nextBytes(t.palette);
            if (translucent) {
                // The first entries get an alpha, the rest are opaque.
                t.trns = java.util.Arrays.copyOf(new byte[]{(byte) 0, (byte) 200, (byte) 17}, Math.min(3, entries));
            }
        } else if (translucent && type == 0) {
            int key = t.samples[0][0];
            t.trns = new byte[]{(byte) (key >> 8), (byte) key};
        } else if (translucent && type == 2) {
            int[] k = t.samples[0];
            t.trns = new byte[]{(byte) (k[0] >> 8), (byte) k[0], (byte) (k[1] >> 8), (byte) k[1], (byte) (k[2] >> 8),
                    (byte) k[2]};
        }
        return t;
    }

    private static int[][] combos() {
        return new int[][]{
            {0, 1}, {0, 2}, {0, 4}, {0, 8}, {0, 16},
            {2, 8}, {2, 16},
            {3, 1}, {3, 2}, {3, 4}, {3, 8},
            {4, 8}, {4, 16},
            {6, 8}, {6, 16}};
    }

    static Stream<Arguments> everyKind() {
        List<Arguments> out = new ArrayList<>();
        for (int[] c : combos()) {
            for (boolean interlace : new boolean[]{false, true}) {
                for (boolean translucent : new boolean[]{false, true}) {
                    out.add(Arguments.of(c[0], c[1], interlace, translucent));
                }
            }
        }
        return out.stream();
    }

    /** The output, checked as a PNG by ImageIO, as mask values (alpha band) and gray values. */
    private static int[][] decodeOutput(byte[] out, int w, int h) throws Exception {
        BufferedImage img = ImageIO.read(new ByteArrayInputStream(out));
        assertThat(img).isNotNull();
        assertThat(img.getWidth()).isEqualTo(w);
        assertThat(img.getHeight()).isEqualTo(h);
        return bands(img, w, h);
    }

    private static int[][] bands(BufferedImage img, int w, int h) {
        Raster raster = img.getRaster();
        assertThat(raster.getNumBands()).isEqualTo(2);
        int[] gray = new int[w * h];
        int[] alpha = new int[w * h];
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                gray[y * w + x] = raster.getSample(x, y, 0);
                alpha[y * w + x] = raster.getSample(x, y, 1);
            }
        }
        return new int[][]{gray, alpha};
    }

    /** The decode is exact: coverage before the floor and the levels is the alpha, or the distance from the border. */
    private static void assertMask(TestPng t) throws Exception {
        assertThat(PngMark.coverageOf(t.build())).as("coverage").containsExactly(expectedMask(t));
    }

    /** A black (or given) disk on a plain ground, as a gray image: a mark the rules accept. */
    private static TestPng logo(int n) {
        TestPng t = new TestPng(n, n, 0, 8, false);
        t.samples = new int[n * n][1];
        double c = (n - 1) / 2.0;
        for (int y = 0; y < n; y++) {
            for (int x = 0; x < n; x++) {
                boolean in = Math.hypot(x - c, y - c) <= n * 0.4;
                t.samples[y * n + x][0] = in ? 0 : 255;
            }
        }
        return t;
    }

    private interface Pixel {
        int[] at(int x, int y);
    }

    private static TestPng image(int w, int h, int type, Pixel f) {
        TestPng t = new TestPng(w, h, type, 8, false);
        t.samples = new int[w * h][];
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                t.samples[y * w + x] = f.at(x, y);
            }
        }
        return t;
    }

    /** The mask as the member gets it: size, and the alpha band. */
    private static int[][] decoded(TestPng t) throws Exception {
        BufferedImage img = ImageIO.read(new ByteArrayInputStream(PngMark.mask(t.build())));
        int[][] g = bands(img, img.getWidth(), img.getHeight());
        assertThat(img.getWidth()).as("a square").isEqualTo(img.getHeight());
        assertThat(g[0]).containsOnly(255);
        return new int[][]{{img.getWidth()}, g[1]};
    }

    private static void assertRefused(byte[] png, Reason reason) {
        assertThatThrownBy(() -> PngMark.mask(png))
                .isInstanceOfSatisfying(IconException.class, e -> assertThat(e.reason()).isEqualTo(reason));
    }

    private static TestPng base() {
        return random(4, 4, 0, 8, false, false, 1);
    }

    // ------------------------------------------------------------ masks

    @ParameterizedTest(name = "type {0} depth {1} interlace {2} translucent {3}")
    @MethodSource("everyKind")
    void maskIsRightForEveryColorTypeAndDepth(int type, int depth, boolean interlace, boolean translucent)
            throws Exception {
        for (int[] size : new int[][]{{1, 1}, {3, 2}, {8, 8}, {13, 11}, {2, 17}}) {
            assertMask(random(size[0], size[1], type, depth, interlace, translucent, 42L + size[0]));
        }
    }

    @Test
    void everyFilterTypeOnItsOwn() throws Exception {
        for (int f = 0; f < 5; f++) {
            for (int[] c : new int[][]{{2, 8}, {0, 1}, {6, 16}, {3, 4}}) {
                TestPng t = random(9, 7, c[0], c[1], false, true, 7L * f);
                t.filter = f;
                assertMask(t);
            }
        }
    }

    @Test
    void imageDataSplitAcrossManyIdats() throws Exception {
        TestPng t = random(16, 16, 6, 8, false, true, 3);
        t.idatSplit = 7;
        assertMask(t);
    }

    @Test
    void handWorkedValues() throws Exception {
        // 8-bit RGBA: alpha is the mask, colors don't matter.
        TestPng t = new TestPng(3, 1, 6, 8, false);
        t.samples = new int[][]{{1, 2, 3, 0}, {255, 255, 255, 128}, {0, 0, 0, 255}};
        assertThat(maskOf(t)).containsExactly(0, 128, 255);

        // 16-bit gray+alpha: 0x8000 is 128, 0xffff 255, 0 is 0.
        t = new TestPng(3, 1, 4, 16, true);
        t.samples = new int[][]{{0, 0x8000}, {0xffff, 0xffff}, {5, 0}};
        assertThat(maskOf(t)).containsExactly(128, 255, 0);

        // Opaque RGB on a white border: the distance from white. Black 255, red 201, green 73.
        t = new TestPng(3, 3, 2, 8, false);
        t.samples = new int[9][];
        java.util.Arrays.fill(t.samples, new int[]{255, 255, 255});
        t.samples[3] = new int[]{0, 0, 0};
        t.samples[4] = new int[]{255, 0, 0};
        t.samples[5] = new int[]{0, 255, 0};
        assertThat(maskOf(t)).containsExactly(0, 0, 0, 255, 201, 73, 0, 0, 0);

        // And white on a dark border works the same way: the distance from black.
        t = new TestPng(3, 1, 0, 8, false);
        t.samples = new int[][]{{0}, {255}, {0}};
        assertThat(maskOf(t)).containsExactly(0, 255, 0);

        // Opaque 1-bit gray: a white background (1) is 0, black (0) is the mark.
        t = new TestPng(4, 1, 0, 1, false);
        t.samples = new int[][]{{1}, {0}, {0}, {1}};
        assertThat(maskOf(t)).containsExactly(0, 255, 255, 0);

        // 2-bit palette with tRNS: transparent entry 0, half entry 1, entry 2 opaque (no tRNS entry).
        t = new TestPng(3, 1, 3, 2, false);
        t.palette = new byte[]{0, 0, 0, 10, 10, 10, 20, 20, 20};
        t.trns = new byte[]{0, (byte) 100};
        t.samples = new int[][]{{0}, {1}, {2}};
        assertThat(maskOf(t)).containsExactly(0, 100, 255);

        // tRNS on gray 16-bit: the key pixel is transparent, the other opaque, so the mask is alpha, not darkness.
        t = new TestPng(2, 1, 0, 16, false);
        t.trns = new byte[]{0x12, 0x34};
        t.samples = new int[][]{{0x1234}, {0}};
        assertThat(maskOf(t)).containsExactly(0, 255);

        // A palette whose tRNS entries are all 255 is still opaque: darkness (white entry 0, black entry 255).
        t = new TestPng(2, 1, 3, 8, false);
        t.palette = new byte[]{(byte) 255, (byte) 255, (byte) 255, 0, 0, 0};
        t.trns = new byte[]{(byte) 255, (byte) 255};
        t.samples = new int[][]{{0}, {1}};
        assertThat(maskOf(t)).containsExactly(0, 255);
    }

    private static int[] maskOf(TestPng t) throws Exception {
        return PngMark.coverageOf(t.build());
    }

    @Test
    void anAlphaChannelThatIsAllOpaqueUsesDarkness() throws Exception {
        TestPng t = new TestPng(2, 1, 4, 8, false);
        t.samples = new int[][]{{255, 255}, {0, 255}};
        assertThat(maskOf(t)).containsExactly(0, 255);
    }

    @Test
    void interlacedMatchesNonInterlacedAndImageIo() throws Exception {
        TestPng a = random(21, 19, 6, 8, true, true, 9);
        TestPng b = random(21, 19, 6, 8, false, true, 9);
        assertThat(maskOf(a)).isEqualTo(maskOf(b));
        BufferedImage img = ImageIO.read(new ByteArrayInputStream(a.build()));
        int[] mask = maskOf(a);
        for (int y = 0; y < 19; y++) {
            for (int x = 0; x < 21; x++) {
                assertThat(img.getRGB(x, y) >>> 24).isEqualTo(mask[y * 21 + x]);
            }
        }
    }

    @Test
    void outputIsAFreshPngWithOnlyIhdrIdatIend() throws Exception {
        TestPng t = logo(40);
        String secret = "SECRET-GPS-AND-AUTHOR";
        t.afterIhdr.add(TestPng.chunk("tEXt", ("Author\0" + secret).getBytes(StandardCharsets.UTF_8)));
        t.afterIhdr.add(TestPng.chunk("iTXt", ("k\0\0\0\0\0" + secret).getBytes(StandardCharsets.UTF_8)));
        t.afterIhdr.add(TestPng.chunk("zTXt", TestPng.concat("k\0\0".getBytes(), TestPng.zlib(secret.getBytes()))));
        t.afterIhdr.add(TestPng.chunk("eXIf", ("MM\0*" + secret).getBytes(StandardCharsets.UTF_8)));
        t.afterIhdr.add(TestPng.chunk("tIME", new byte[]{7, (byte) 0xea, 11, 8, 1, 2, 3}));
        t.afterIhdr.add(TestPng.chunk("gAMA", new byte[]{0, 1, (byte) 0x86, (byte) 0xa0}));
        t.afterIhdr.add(TestPng.chunk("iCCP", TestPng.concat("icc\0\0".getBytes(), TestPng.zlib(secret.getBytes()))));
        t.afterIhdr.add(TestPng.chunk("pHYs", new byte[9]));
        t.afterIhdr.add(TestPng.chunk("acTL", new byte[8]));
        t.afterIhdr.add(TestPng.chunk("prIV", secret.getBytes(StandardCharsets.UTF_8)));
        t.afterIdat.add(TestPng.chunk("fcTL", new byte[26]));
        t.afterIdat.add(TestPng.chunk("fdAT", new byte[10]));
        t.afterIdat.add(TestPng.chunk("tEXt", ("Comment\0" + secret).getBytes(StandardCharsets.UTF_8)));
        byte[] out = PngMark.mask(t.build());
        assertThat(TestPng.chunkTypes(out)).containsExactly("IHDR", "IDAT", "IEND");
        assertThat(new String(out, StandardCharsets.ISO_8859_1)).doesNotContain(secret);
        assertThat(maskOf(t)).containsExactly(expectedMask(t));
        // And it's the same bytes as without the extras: nothing of them leaks into the output.
        assertThat(out).isEqualTo(PngMark.mask(logo(40).build()));
        // The header is 8-bit gray+alpha, no interlace.
        assertThat(out[8 + 8 + 8]).isEqualTo((byte) 8);
        assertThat(out[8 + 8 + 9]).isEqualTo((byte) 4);
        assertThat(out[8 + 8 + 12]).isEqualTo((byte) 0);
    }

    @Test
    void biggestImagesAreBoundedAndIdatsAreAtMost64KiB() throws Exception {
        // 512x512, 4-bit palette of random alpha, a quarter of it clear: 131 KB of noise in, about as much out.
        TestPng t = new TestPng(512, 512, 3, 4, false);
        Random r = new Random(11);
        t.samples = new int[512 * 512][1];
        for (int[] s : t.samples) {
            s[0] = r.nextInt(4) == 0 ? 0 : 1 + r.nextInt(15);
        }
        t.palette = new byte[48];
        t.trns = new byte[16];
        for (int i = 1; i < 16; i++) {
            t.trns[i] = (byte) (140 + (i - 1) * 8);
        }
        byte[] in = t.build();
        assertThat(in.length).isLessThanOrEqualTo(PngMark.MAX_INPUT_BYTES);
        byte[] out = PngMark.mask(in);
        assertThat(out.length).isLessThanOrEqualTo(PngMark.MAX_OUTPUT_BYTES);
        List<String> types = TestPng.chunkTypes(out);
        assertThat(types.stream().filter("IDAT"::equals).count()).isGreaterThan(1);
        int pos = 8;
        while (pos < out.length) {
            int len = ((out[pos] & 0xff) << 24) | ((out[pos + 1] & 0xff) << 16) | ((out[pos + 2] & 0xff) << 8)
                    | (out[pos + 3] & 0xff);
            assertThat(len).isLessThanOrEqualTo(64 * 1024);
            pos += 12 + len;
        }
        decodeOutput(out, 512, 512); // never more than 512 a side
    }

    // ------------------------------------------------------------ the rules for a mark (Design H2)

    @Test
    void aLogoOnWhiteIsTrimmedAndCentredInASquareWithAMargin() throws Exception {
        // A 40 px disk on white with a lot of empty edge, in a 100x60 picture.
        TestPng t = image(100, 60, 0, (x, y) -> new int[]{Math.hypot(x - 70, y - 30) <= 20 ? 0 : 255});
        int[][] d = decoded(t);
        int side = d[0][0];
        int disk = 41; // the trimmed box, +/- 20 around the centre
        assertThat(side).isEqualTo((int) Math.ceil(disk / 0.84));
        int[] alpha = d[1];
        int minX = side;
        int maxX = -1;
        int minY = side;
        int maxY = -1;
        for (int i = 0; i < alpha.length; i++) {
            if (alpha[i] > 0) {
                minX = Math.min(minX, i % side);
                maxX = Math.max(maxX, i % side);
                minY = Math.min(minY, i / side);
                maxY = Math.max(maxY, i / side);
            }
        }
        assertThat(maxX - minX + 1).isEqualTo(disk);
        assertThat(maxY - minY + 1).isEqualTo(disk);
        assertThat(minX).isEqualTo(side - 1 - maxX).isBetween(side / 12, side / 8 + 1); // the 8% margin, centred
        assertThat(alpha[(side / 2) * side + side / 2]).isEqualTo(255);
    }

    @Test
    void aRedLogoIsAFullMarkNotAGreyOne() throws Exception {
        TestPng t = image(60, 60, 2, (x, y) -> Math.hypot(x - 30, y - 30) <= 22 ? new int[]{255, 0, 0}
                : new int[]{255, 255, 255});
        int[][] d = decoded(t);
        int side = d[0][0];
        assertThat(d[1][(side / 2) * side + side / 2]).isEqualTo(255); // not 201, and not 79%
    }

    @Test
    void whiteOnDarkAndOnTransparentWorkToo() throws Exception {
        TestPng dark = image(60, 60, 0, (x, y) -> new int[]{Math.hypot(x - 30, y - 30) <= 22 ? 255 : 10});
        int side = decoded(dark)[0][0];
        assertThat(decoded(dark)[1][(side / 2) * side + side / 2]).isEqualTo(255);
        TestPng clear = image(60, 60, 6, (x, y) -> new int[]{255, 255, 255, Math.hypot(x - 30, y - 30) <= 22 ? 255 : 0});
        assertThat(decoded(clear)[0][0]).isEqualTo(side);
    }

    @Test
    void hazeAndNoiseUnderTheFloorAreDropped() throws Exception {
        // A disk with faint (alpha 20) haze all around it: the haze is 0 in the mask.
        TestPng t = image(80, 80, 6, (x, y) -> new int[]{0, 0, 0, Math.hypot(x - 40, y - 40) <= 20 ? 255 : 20});
        int[][] d = decoded(t);
        int side = d[0][0];
        assertThat(side).isEqualTo((int) Math.ceil(41 / 0.84));
        assertThat(d[1][0]).isZero();
    }

    @Test
    void aPhotoHasNoShape() {
        Random r = new Random(5);
        TestPng t = image(64, 64, 0, (x, y) -> new int[]{r.nextInt(256)});
        assertRefused(t.build(), Reason.NO_SHAPE);
        TestPng smooth = image(64, 64, 0, (x, y) -> new int[]{(x * 4) % 256});
        assertRefused(smooth.build(), Reason.NO_SHAPE);
    }

    @Test
    void blanksHaveNoShape() {
        assertRefused(image(32, 32, 6, (x, y) -> new int[]{9, 9, 9, 0}).build(), Reason.NO_SHAPE); // all clear
        assertRefused(image(32, 32, 0, (x, y) -> new int[]{255}).build(), Reason.NO_SHAPE); // all white
        assertRefused(image(32, 32, 0, (x, y) -> new int[]{0}).build(), Reason.NO_SHAPE); // all one colour
        assertRefused(image(32, 32, 6, (x, y) -> new int[]{0, 0, 0, 10}).build(), Reason.NO_SHAPE); // only haze
        // A solid block fills its whole box.
        assertRefused(image(32, 32, 6, (x, y) -> new int[]{0, 0, 0, 255}).build(), Reason.NO_SHAPE);
        assertRefused(image(32, 32, 0, (x, y) -> new int[]{x > 4 && x < 28 && y > 4 && y < 28 ? 0 : 255}).build(),
                Reason.NO_SHAPE);
    }

    @Test
    void hairlinesAreTooThin() {
        // A 1 px cross and frame on a 200 px square.
        TestPng t = image(200, 200, 0, (x, y) -> new int[]{x >= 20 && x <= 180 && y >= 20 && y <= 180
                && (x == 100 || y == 100 || x == 20 || y == 20) ? 0 : 255});
        assertRefused(t.build(), Reason.TOO_THIN);
        TestPng ring = image(300, 300, 6, (x, y) -> new int[]{0, 0, 0,
                Math.abs(Math.hypot(x - 150, y - 150) - 120) < 1 ? 255 : 0});
        assertRefused(ring.build(), Reason.TOO_THIN);
    }

    @Test
    void aOneByEightStripHasNoShape() {
        assertRefused(image(1, 8, 0, (x, y) -> new int[]{y < 3 ? 255 : 0}).build(), Reason.NO_SHAPE);
        assertRefused(image(1, 8, 6, (x, y) -> new int[]{0, 0, 0, y >= 2 && y < 6 ? 255 : 0}).build(),
                Reason.NO_SHAPE);
    }

    @Test
    void aWordmarkIsCentredInASquareNotSquashed() throws Exception {
        // 512x96 of bold bars on white: the output is 512 square with the bars in the middle band.
        TestPng t = image(512, 96, 0, (x, y) -> new int[]{x % 64 >= 8 && x % 64 < 38 && y >= 18 && y < 78 ? 0 : 255});
        int[][] d = decoded(t);
        int side = d[0][0];
        assertThat(side).isEqualTo(512);
        int bandTop = (side - 60) / 2;
        for (int y = 0; y < side; y++) {
            boolean inBand = y >= bandTop && y < bandTop + 60;
            boolean any = false;
            for (int x = 0; x < side; x++) {
                any |= d[1][y * side + x] > 0;
            }
            assertThat(any).as("row " + y).isEqualTo(inBand);
        }
    }

    // ------------------------------------------------------------ refusals

    @Test
    void notPng() {
        assertRefused(new byte[0], Reason.NOT_PNG);
        assertRefused(new byte[7], Reason.NOT_PNG);
        assertRefused("GIF89a-not-a-png".getBytes(StandardCharsets.US_ASCII), Reason.NOT_PNG);
        byte[] png = base().build();
        png[1] = 'p';
        assertRefused(png, Reason.NOT_PNG);
        assertRefused(new byte[PngMark.MAX_INPUT_BYTES], Reason.NOT_PNG);
        assertThatThrownBy(() -> PngMark.mask(null)).isInstanceOf(IconException.class);
    }

    @Test
    void tooLargeIsCheckedFirst() {
        assertRefused(new byte[PngMark.MAX_INPUT_BYTES + 1], Reason.TOO_LARGE);
        byte[] png = TestPng.concat(base().build(), new byte[PngMark.MAX_INPUT_BYTES]);
        assertRefused(png, Reason.TOO_LARGE);
    }

    @Test
    void tooManyPixelsFromTheHeaderAlone() throws Exception {
        for (int[] wh : new int[][]{{513, 1}, {1, 513}, {513, 513}, {100000, 100000}}) {
            TestPng t = new TestPng(wh[0], wh[1], 0, 8, false);
            // No image data at all: the header decides before any inflating.
            byte[] png = TestPng.concat(TestPng.SIGNATURE, TestPng.chunk("IHDR", t.ihdr()),
                    TestPng.chunk("IEND", new byte[0]));
            assertRefused(png, Reason.TOO_MANY_PIXELS);
        }
        // 512 by 512 is fine.
        assertMask(random(512, 1, 0, 8, false, false, 2));
        assertMask(random(1, 512, 0, 8, false, false, 2));
        // 4 billion by 4 billion, and zero.
        TestPng t = new TestPng(1, 1, 0, 8, false);
        byte[] ihdr = t.ihdr();
        TestPng.putInt(ihdr, 0, -1);
        assertRefused(TestPng.concat(TestPng.SIGNATURE, TestPng.chunk("IHDR", ihdr)), Reason.TOO_MANY_PIXELS);
        TestPng.putInt(ihdr, 0, 0);
        assertRefused(TestPng.concat(TestPng.SIGNATURE, TestPng.chunk("IHDR", ihdr)), Reason.CORRUPT);
    }

    @Test
    void badCrcInAnyChunk() {
        byte[] png = base().build();
        // Flip one bit in each byte of the file in turn after the signature: always refused (CORRUPT, or for the
        // IHDR size bytes TOO_MANY_PIXELS can't happen from one bit with a good CRC check first).
        for (int i = 8; i < png.length; i++) {
            byte[] bad = png.clone();
            bad[i] ^= 0x01;
            assertThatThrownBy(() -> PngMark.mask(bad)).isInstanceOf(IconException.class);
        }
        // The CRC of a chunk whose data is intact but the CRC isn't.
        byte[] bad = png.clone();
        bad[8 + 8 + 13] ^= (byte) 0xff; // IHDR's CRC
        assertRefused(bad, Reason.CORRUPT);
    }

    @Test
    void truncatedAtEveryLength() {
        byte[] png = base().build();
        for (int n = 8; n < png.length; n++) {
            assertRefused(java.util.Arrays.copyOf(png, n), Reason.CORRUPT);
        }
    }

    @Test
    void chunkAfterIend() {
        byte[] png = base().build();
        assertRefused(TestPng.concat(png, TestPng.chunk("tEXt", "a\0b".getBytes())), Reason.CORRUPT);
        assertRefused(TestPng.concat(png, new byte[]{0}), Reason.CORRUPT);
        assertRefused(TestPng.concat(png, png), Reason.CORRUPT);
    }

    @Test
    void headerRules() {
        TestPng t = base();
        // Missing IHDR; IHDR not first.
        assertRefused(TestPng.concat(TestPng.SIGNATURE, TestPng.chunk("IDAT", TestPng.zlib(new byte[20])),
                TestPng.chunk("IEND", new byte[0])), Reason.CORRUPT);
        assertRefused(TestPng.concat(TestPng.SIGNATURE, TestPng.chunk("tEXt", "a\0b".getBytes()),
                TestPng.chunk("IHDR", t.ihdr()), TestPng.chunk("IDAT", TestPng.zlib(t.filteredStream())),
                TestPng.chunk("IEND", new byte[0])), Reason.CORRUPT);
        // A second IHDR.
        t.afterIhdr.add(TestPng.chunk("IHDR", t.ihdr()));
        assertRefused(t.build(), Reason.CORRUPT);
        // Illegal bit depth and color type pairs, unknown values, compression, filter, interlace.
        int[][] illegal = {{0, 3}, {0, 0}, {2, 4}, {2, 1}, {3, 16}, {4, 4}, {6, 2}, {5, 8}, {1, 8}, {7, 8}};
        for (int[] p : illegal) {
            TestPng x = base();
            x.type = p[0];
            x.depth = p[1];
            assertRefused(TestPng.concat(TestPng.SIGNATURE, TestPng.chunk("IHDR", x.ihdr()),
                    TestPng.chunk("IDAT", TestPng.zlib(new byte[40])), TestPng.chunk("IEND", new byte[0])),
                    Reason.CORRUPT);
        }
        for (int field : new int[]{10, 11, 12}) {
            byte[] ihdr = base().ihdr();
            ihdr[field] = (byte) (field == 12 ? 2 : 1);
            assertRefused(TestPng.concat(TestPng.SIGNATURE, TestPng.chunk("IHDR", ihdr),
                    TestPng.chunk("IDAT", TestPng.zlib(new byte[40])), TestPng.chunk("IEND", new byte[0])),
                    Reason.CORRUPT);
        }
        // IHDR of the wrong length.
        assertRefused(TestPng.concat(TestPng.SIGNATURE, TestPng.chunk("IHDR", new byte[12]),
                TestPng.chunk("IEND", new byte[0])), Reason.CORRUPT);
    }

    @Test
    void imageDataSizeMustBeExact() {
        TestPng t = base();
        byte[] stream = t.filteredStream();
        byte[] longer = java.util.Arrays.copyOf(stream, stream.length + 1);
        assertRefused(t.build(TestPng.zlib(longer)), Reason.CORRUPT);
        byte[] shorter = java.util.Arrays.copyOf(stream, stream.length - 1);
        assertRefused(t.build(TestPng.zlib(shorter)), Reason.CORRUPT);
        assertRefused(t.build(TestPng.zlib(new byte[0])), Reason.CORRUPT);
        // Bytes after the zlib stream; a damaged checksum; a stream that is cut off.
        assertRefused(t.build(TestPng.concat(TestPng.zlib(stream), new byte[]{1})), Reason.CORRUPT);
        byte[] z = TestPng.zlib(stream);
        z[z.length - 1] ^= 1;
        assertRefused(t.build(z), Reason.CORRUPT);
        assertRefused(t.build(java.util.Arrays.copyOf(TestPng.zlib(stream), TestPng.zlib(stream).length - 5)),
                Reason.CORRUPT);
        assertRefused(t.build(new byte[]{1, 2, 3, 4}), Reason.CORRUPT);
        // Interlaced: the expected size counts the passes.
        TestPng i = random(13, 11, 6, 8, true, true, 1);
        byte[] s = i.filteredStream();
        assertRefused(i.build(TestPng.zlib(java.util.Arrays.copyOf(s, s.length - 1))), Reason.CORRUPT);
        assertRefused(i.build(TestPng.zlib(java.util.Arrays.copyOf(s, s.length + 1))), Reason.CORRUPT);
        // A filter byte that isn't 0-4.
        byte[] badFilter = stream.clone();
        badFilter[0] = 5;
        assertRefused(t.build(TestPng.zlib(badFilter)), Reason.CORRUPT);
    }

    @Test
    void decompressionBombStopsAtTheBound() throws Exception {
        // The header claims 512x512 8-bit gray (262,656 bytes of data); the stream holds 256 MiB of zeros in under
        // 256 KiB. The decoder must stop at the bound, long before, and refuse.
        TestPng t = new TestPng(512, 512, 0, 8, false);
        Deflater d = new Deflater(9);
        ByteArrayOutputStream z = new ByteArrayOutputStream();
        byte[] zeros = new byte[1 << 20];
        byte[] buf = new byte[1 << 16];
        for (int i = 0; i < 256; i++) {
            d.setInput(zeros);
            while (!d.needsInput()) {
                z.write(buf, 0, d.deflate(buf));
            }
        }
        d.finish();
        while (!d.finished()) {
            z.write(buf, 0, d.deflate(buf));
        }
        d.end();
        byte[] bomb = t.build(z.toByteArray());
        assertThat(bomb.length).isLessThanOrEqualTo(PngMark.MAX_INPUT_BYTES);
        long start = System.nanoTime();
        assertRefused(bomb, Reason.CORRUPT);
        assertThat((System.nanoTime() - start) / 1_000_000).isLessThan(1000);
    }

    @Test
    void chunkOrderAndKinds() {
        // Unknown critical chunk: refused. Unknown ancillary: dropped.
        TestPng t = base();
        t.afterIhdr.add(TestPng.chunk("ABCD", new byte[3]));
        assertRefused(t.build(), Reason.CORRUPT);
        t = logo(12);
        t.afterIhdr.add(TestPng.chunk("abcd", new byte[3]));
        assertThat(TestPng.chunkTypes(mask(t.build()))).containsExactly("IHDR", "IDAT", "IEND");
        // Chunk types that aren't letters.
        t = base();
        t.afterIhdr.add(TestPng.chunk("ab1d", new byte[3]));
        assertRefused(t.build(), Reason.CORRUPT);
        // IDATs not consecutive.
        t = random(8, 8, 0, 8, false, false, 3);
        byte[] z = TestPng.zlib(t.filteredStream());
        byte[] png = TestPng.concat(TestPng.SIGNATURE, TestPng.chunk("IHDR", t.ihdr()),
                TestPng.chunk("IDAT", java.util.Arrays.copyOfRange(z, 0, 10)),
                TestPng.chunk("tEXt", "a\0b".getBytes()),
                TestPng.chunk("IDAT", java.util.Arrays.copyOfRange(z, 10, z.length)),
                TestPng.chunk("IEND", new byte[0]));
        assertRefused(png, Reason.CORRUPT);
        // No IDAT at all; IEND with data.
        assertRefused(TestPng.concat(TestPng.SIGNATURE, TestPng.chunk("IHDR", base().ihdr()),
                TestPng.chunk("IEND", new byte[0])), Reason.CORRUPT);
        assertRefused(TestPng.concat(TestPng.SIGNATURE, TestPng.chunk("IHDR", base().ihdr()),
                TestPng.chunk("IDAT", TestPng.zlib(base().filteredStream())), TestPng.chunk("IEND", new byte[1])),
                Reason.CORRUPT);
    }

    private static byte[] mask(byte[] png) {
        try {
            return PngMark.mask(png);
        } catch (IconException e) {
            throw new AssertionError(e.reason().name());
        }
    }

    @Test
    void paletteRules() throws Exception {
        // Type 3 without PLTE.
        TestPng t = random(4, 4, 3, 8, false, false, 1);
        t.palette = null;
        assertRefused(t.build(), Reason.CORRUPT);
        // Index past the palette.
        t = random(4, 4, 3, 8, false, false, 1);
        t.palette = new byte[6]; // 2 entries, samples go to 4
        assertRefused(t.build(), Reason.CORRUPT);
        // Bad palette sizes: not a multiple of 3, empty, too many for the depth.
        for (int len : new int[]{4, 0, 12}) { // 12 = 4 entries, over 2^1
            TestPng x = random(4, 4, 3, 1, false, false, 1);
            for (int[] s : x.samples) {
                s[0] &= 1;
            }
            x.palette = new byte[len];
            assertRefused(x.build(), Reason.CORRUPT);
        }
        // tRNS longer than the palette; PLTE twice; PLTE after IDAT; PLTE in a gray image.
        t = random(4, 4, 3, 8, false, true, 1);
        t.trns = new byte[6];
        assertRefused(t.build(), Reason.CORRUPT);
        t = random(4, 4, 3, 8, false, false, 1);
        t.afterIhdr.add(TestPng.chunk("PLTE", new byte[15]));
        assertRefused(t.build(), Reason.CORRUPT);
        t = random(4, 4, 3, 8, false, false, 1);
        t.afterIdat.add(TestPng.chunk("PLTE", new byte[15]));
        assertRefused(t.build(), Reason.CORRUPT);
        t = random(4, 4, 0, 8, false, false, 1);
        t.afterIhdr.add(TestPng.chunk("PLTE", new byte[15]));
        assertRefused(t.build(), Reason.CORRUPT);
        // tRNS of the wrong length for gray and RGB; tRNS twice; tRNS after IDAT.
        t = random(4, 4, 0, 8, false, false, 1);
        t.trns = new byte[3];
        assertRefused(t.build(), Reason.CORRUPT);
        t = random(4, 4, 2, 8, false, false, 1);
        t.trns = new byte[2];
        assertRefused(t.build(), Reason.CORRUPT);
        t = random(4, 4, 0, 8, false, true, 1);
        t.afterIhdr.add(TestPng.chunk("tRNS", new byte[2]));
        assertRefused(t.build(), Reason.CORRUPT);
        t = random(4, 4, 0, 8, false, false, 1);
        t.afterIdat.add(TestPng.chunk("tRNS", new byte[2]));
        assertRefused(t.build(), Reason.CORRUPT);
        // A palette in an RGB image is allowed (a suggestion) and dropped.
        t = random(4, 4, 2, 8, false, false, 1);
        t.palette = new byte[9];
        assertThat(PngMark.coverageOf(t.build())).hasSize(16);
    }

    @Test
    void reasonWireNames() {
        assertThat(Reason.NOT_PNG.wireName()).isEqualTo("not_png");
        assertThat(Reason.TOO_LARGE.wireName()).isEqualTo("too_large");
        assertThat(Reason.TOO_MANY_PIXELS.wireName()).isEqualTo("too_many_pixels");
        assertThat(Reason.CORRUPT.wireName()).isEqualTo("corrupt");
        assertThat(Reason.NO_SHAPE.wireName()).isEqualTo("no_shape");
        assertThat(Reason.TOO_THIN.wireName()).isEqualTo("too_thin");
        assertThat(new IconException(Reason.CORRUPT).getMessage()).isEqualTo("corrupt");
    }
}
