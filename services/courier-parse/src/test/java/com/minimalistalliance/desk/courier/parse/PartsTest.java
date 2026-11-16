package com.minimalistalliance.desk.courier.parse;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.courier.testkit.MimeCorpus;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.Test;

/** The Courier mode's pieces one at a time, and the worker's other requests: a part, an image, an archive. */
class PartsTest {

    @Test
    void theRequestLineIsReadStrictly() throws Exception {
        assertThat(CourierRequest.read(in("courier1 message\nrest"))).isEqualTo(new CourierRequest(CourierRequest.Op.MESSAGE, null));
        assertThat(CourierRequest.read(in("courier1 part 2.1.3\n")).part()).isEqualTo("2.1.3");
        assertThat(CourierRequest.read(in("courier1 image -\n")).part()).isEqualTo("-");
        for (String bad : List.of("courier1 message x\n", "courier1  message\n", "courier1 part 0\n", "courier1 part 1.\n",
                "courier1 part -\n", "courier2 message\n", "courier1 Message\n", "courier1 part 01\n", "courier1 message",
                "courier1 message\r\n", "courier1 part 1\u00002\n", "x".repeat(200) + "\n")) {
            assertThatThrownBy(() -> CourierRequest.read(in(bad))).as(bad).isInstanceOf(CourierRequest.Malformed.class);
        }
        String[] a = CorpusTest.answer("courier1 nothing", new byte[0]);
        assertThat(a[0]).isEqualTo("ERR bad_request");
    }

    @Test
    void linksAreMadePlain() {
        Links.Link l = Links.inspect(" https://Example.COM:443/a b?utm_medium=x&gclid=1&q=2#f ", "Example.com");
        assertThat(l.url()).isEqualTo("https://example.com/a%20b?q=2#f");
        assertThat(l.warnings()).isEmpty();
        assertThat(Links.inspect("java\tscript:alert(1)", null)).isNull();
        assertThat(Links.inspect("data:text/html,<script>", null)).isNull();
        assertThat(Links.inspect("/relative/path", null)).isNull();
        assertThat(Links.inspect("http://2130706433/", null).warnings()).contains("ip");
        assertThat(Links.inspect("http://0x7f.1/", null).warnings()).contains("ip");
        assertThat(Links.inspect("http://[::1]/", null).warnings()).contains("ip");
        assertThat(Links.inspect("https://bücher.example/", null).host()).isEqualTo("xn--bcher-kva.example");
        assertThat(Links.inspect("https://bücher.example/", null).warnings()).contains("punycode");
        assertThat(Links.inspect("https:\\\\evil.example\\x", null).host()).isEqualTo("evil.example");
        assertThat(Links.inspect("mailto:Dana@Example.com?subject=hi", null).url()).isEqualTo("mailto:Dana@example.com");
        assertThat(Links.inspect("https://a.example/", "https://b.example/").warnings()).contains("mismatch");
        assertThat(Links.inspect("https://mail.a.example/", "a.example").warnings()).doesNotContain("mismatch");
        assertThat(Links.cleanText("see https://x.example/p?utm_source=a&id=1. thanks")).isEqualTo("see https://x.example/p?id=1. thanks");
        Trackers.use(Trackers.of(java.util.Set.of("tracker.example")));
        try {
            assertThat(Links.inspect("https://px.tracker.example/o", null).warnings()).contains("tracker");
        } finally {
            Trackers.use(Trackers.of(java.util.Set.of()));
        }
    }

    @Test
    void dangerIsTheRealExtensionAndTheBytes() {
        assertThat(Danger.byName("invoice.pdf.exe")).isEqualTo("program");
        assertThat(Danger.byName("invoice‮fdp.exe")).isEqualTo("program");
        assertThat(Danger.byName("run.EXE. . ")).isEqualTo("program");
        assertThat(Danger.byName("notes.txt")).isNull();
        assertThat(sniff("photo.jpg", "MZ\u0090\u0000".getBytes(StandardCharsets.ISO_8859_1))).isEqualTo("program");
        assertThat(sniff("x.bin", "#!/bin/sh\nrm -rf /\n".getBytes(StandardCharsets.US_ASCII))).isEqualTo("program");
        assertThat(sniff("page.txt", "  <!DOCTYPE html><script>".getBytes(StandardCharsets.US_ASCII))).isEqualTo("html");
        assertThat(sniff("archive.zip", zip("readme.txt", "setup.exe"))).isEqualTo("archive_programs");
        assertThat(sniff("archive.zip", zip("readme.txt", "notes/a.md"))).isNull();
        assertThat(sniff("report.docx", zip("[Content_Types].xml", "word/vbaProject.bin"))).isEqualTo("macros");
        assertThat(sniff("tool.zip", zip("META-INF/MANIFEST.MF", "a/B.class"))).isEqualTo("program");
        assertThat(sniff("a.tar", tar("docs/readme.txt", "bin/run.sh"))).isEqualTo("archive_programs");
        assertThat(sniff("x.rar", "Rar!\u001A\u0007\u0000".getBytes(StandardCharsets.ISO_8859_1))).isEqualTo("archive_unread");
        byte[] ole = new byte[4096];
        System.arraycopy(new byte[] {(byte) 0xD0, (byte) 0xCF, 0x11, (byte) 0xE0, (byte) 0xA1, (byte) 0xB1, 0x1A, (byte) 0xE1}, 0, ole, 0, 8);
        byte[] vba = "_VBA_PROJECT".getBytes(StandardCharsets.UTF_16LE);
        System.arraycopy(vba, 0, ole, 3000, vba.length);
        assertThat(sniff("old.doc", ole)).isEqualTo("macros");
    }

    @Test
    void anArchiveIsListedWithoutUnpacking() throws Exception {
        Danger.Sniffer s = new Danger.Sniffer(true);
        byte[] z = zip("a.txt", "dir/", "dir/b.exe");
        s.write(z, 0, z.length);
        Archives.Listing l = s.listing();
        assertThat(l.format()).isEqualTo("zip");
        assertThat(l.entries()).extracting(Archives.Entry::name).containsExactly("a.txt", "dir/", "dir/b.exe");
        assertThat(l.entries().get(1).dir()).isTrue();
        // Fed a byte at a time, the same.
        Danger.Sniffer slow = new Danger.Sniffer(true);
        for (byte b : z) {
            slow.write(new byte[] {b}, 0, 1);
        }
        assertThat(slow.listing().entries()).hasSize(3);
    }

    @Test
    void trackersMatchHostsAndHostAndPathPrefixes() throws Exception {
        Trackers.use(Trackers.read(new ByteArrayInputStream("# test\npx.example\nstats.example/collect?\n".getBytes(StandardCharsets.US_ASCII))));
        try {
            Html.Result r = Html.sanitize("<img src='https://a.px.example/x.png' width=50 height=50>"
                    + "<img src='https://stats.example/collect?v=1&tid=x' width=50 height=50>"
                    + "<img src='https://stats.example/logo.png' width=50 height=50>", new Html.Budget());
            assertThat(r.trackers()).isEqualTo(2);
            assertThat(r.remoteImages()).isEqualTo(1);
            assertThat(r.html()).contains("logo.png").doesNotContain("collect").doesNotContain("px.example");
        } finally {
            Trackers.use(Trackers.of(java.util.Set.of()));
        }
        // ADR 0076's real list, when given (courier-trackers.py's output from blocker.pin's release).
        String real = System.getProperty("courier.trackers.file");
        if (real != null) {
            Trackers t = Trackers.load(real);
            System.out.println("trackers: the pinned list has " + t.size() + " entries");
            assertThat(t.size()).isGreaterThan(40_000);
            assertThat(t.listed("api.mixpanel.com")).isTrue();
            assertThat(t.listed("www.google.com", "/ads/measurement/x?y=1")).isTrue();
            assertThat(t.listed("www.example.com", "/")).isFalse();
        }
    }

    @Test
    void imagesAreDrawnAgainAndHugeOnesRefusedBeforeDecoding() throws Exception {
        BufferedImage img = new BufferedImage(3000, 1000, BufferedImage.TYPE_INT_RGB);
        ByteArrayOutputStream png = new ByteArrayOutputStream();
        ImageIO.write(img, "png", png);
        byte[] bytes = png.toByteArray();
        Images.Encoded e = Images.reencode(bytes, new ByteArrayInputStream(bytes), Limits.PREVIEW_SIDE);
        assertThat(e.type()).isEqualTo("jpeg");
        assertThat(Math.max(e.width(), e.height())).isLessThanOrEqualTo(Limits.PREVIEW_SIDE);
        // A PNG that says it's 100,000 pixels square: refused from its header, no pixel decoded.
        byte[] huge = pngHeader(100_000, 100_000);
        assertThatThrownBy(() -> Images.reencode(huge, new ByteArrayInputStream(huge), Limits.PREVIEW_SIDE))
                .isInstanceOf(Refusal.class).hasMessage("too_large");
        byte[] svg = "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>".getBytes(StandardCharsets.US_ASCII);
        assertThatThrownBy(() -> Images.reencode(svg, new ByteArrayInputStream(svg), 100)).hasMessage("unsupported");
    }

    @Test
    void charsetsAndFlowedText() {
        assertThat(Charsets.decode("Hi +ZeVnLIqe-".getBytes(StandardCharsets.US_ASCII), 13, "utf-7")).isEqualTo("Hi 日本語");
        byte[] utf8 = "café".getBytes(StandardCharsets.UTF_8);
        assertThat(Charsets.decode(utf8, utf8.length, "us-ascii")).isEqualTo("café");
        assertThat(Charsets.decode(utf8, utf8.length, "x-no-such")).isEqualTo("café");
        byte[] latin = "café".getBytes(StandardCharsets.ISO_8859_1);
        assertThat(Charsets.decode(latin, latin.length, null)).isEqualTo("café");
        assertThat(Flowed.unwrap("one \ntwo\n> quoted \n> more\n-- \nsig", false)).isEqualTo("one two\n> quoted more\n-- \nsig");
        assertThat(Flowed.unwrap("ab \ncd", true)).isEqualTo("abcd");
    }

    @Test
    @SuppressWarnings("unchecked")
    void aPartAnImageAndAnArchiveComeOutOfTheMessage() throws Exception {
        byte[] raw = sample("related-cid-png");
        Map<String, Object> m = CorpusTest.message(raw);
        Map<String, Object> png = ((List<Map<String, Object>>) m.get("attachments")).stream()
                .filter(p -> "image/png".equals(p.get("type"))).findFirst().orElseThrow();
        String id = (String) png.get("part");
        String[] part = CorpusTest.answer("courier1 part " + id, raw);
        assertThat(part[0]).isEqualTo("OK " + png.get("bytes"));
        String[] image = CorpusTest.answer("courier1 image " + id, raw);
        assertThat(image[0]).matches("OK (png|jpeg) \\d+ \\d+");
        assertThat(CorpusTest.answer("courier1 part 9.9", raw)[0]).isEqualTo("ERR not_found");

        byte[] zipped = sample("zip-with-exe");
        Map<String, Object> zm = CorpusTest.message(zipped);
        Map<String, Object> z = ((List<Map<String, Object>>) zm.get("attachments")).get(0);
        assertThat(z.get("danger")).isEqualTo("archive_programs");
        String[] listing = CorpusTest.answer("courier1 archive " + z.get("part"), zipped);
        assertThat(listing[0]).isEqualTo("OK");
        Map<String, Object> l = CorpusTest.JSON_READER.mapFrom(listing[1]);
        assertThat(l.get("format")).isEqualTo("zip");
        assertThat((List<Map<String, Object>>) l.get("entries")).anySatisfy(e -> assertThat(e.get("danger")).isEqualTo("program"));

        ByteArrayOutputStream gif = new ByteArrayOutputStream();
        ImageIO.write(new BufferedImage(10, 10, BufferedImage.TYPE_INT_ARGB), "png", gif);
        assertThat(CorpusTest.answer("courier1 image -", gif.toByteArray())[0]).isEqualTo("OK png 10 10");
        assertThat(CorpusTest.answer("courier1 image -", "not an image".getBytes(StandardCharsets.US_ASCII))[0])
                .isEqualTo("ERR unsupported");
    }

    @Test
    void aSlowParseIsRefusedAsTimeout() {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] big = MimeCorpus.large(20 << 20).raw();
        byte[] req = new byte[big.length + 17];
        System.arraycopy("courier1 message\n".getBytes(StandardCharsets.US_ASCII), 0, req, 0, 17);
        System.arraycopy(big, 0, req, 17, big.length);
        CourierWorker.serve(new ByteArrayInputStream(req), out, 1);
        assertThat(out.toString(StandardCharsets.US_ASCII)).isEqualTo("ERR timeout\n");
    }

    // ---- helpers

    static byte[] sample(String name) {
        return MimeCorpus.handWritten().stream().filter(s -> s.name().equals(name)).findFirst().orElseThrow().raw();
    }

    private static ByteArrayInputStream in(String s) {
        return new ByteArrayInputStream(s.getBytes(StandardCharsets.ISO_8859_1));
    }

    private static String sniff(String name, byte[] bytes) {
        Danger.Sniffer s = new Danger.Sniffer(false);
        s.write(bytes, 0, bytes.length);
        return s.danger(name, "application/octet-stream");
    }

    static byte[] zip(String... names) {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            try (ZipOutputStream z = new ZipOutputStream(out)) {
                for (String n : names) {
                    z.putNextEntry(new ZipEntry(n));
                    if (!n.endsWith("/")) {
                        z.write(("content of " + n).getBytes(StandardCharsets.US_ASCII));
                    }
                    z.closeEntry();
                }
            }
            return out.toByteArray();
        } catch (java.io.IOException e) {
            throw new IllegalStateException(e);
        }
    }

    static byte[] tar(String... names) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (String n : names) {
            byte[] body = ("data " + n).getBytes(StandardCharsets.US_ASCII);
            byte[] h = new byte[512];
            byte[] nb = n.getBytes(StandardCharsets.US_ASCII);
            System.arraycopy(nb, 0, h, 0, nb.length);
            byte[] size = String.format("%011o", body.length).getBytes(StandardCharsets.US_ASCII);
            System.arraycopy(size, 0, h, 124, size.length);
            h[156] = '0';
            System.arraycopy("ustar".getBytes(StandardCharsets.US_ASCII), 0, h, 257, 5);
            out.writeBytes(h);
            out.writeBytes(body);
            out.writeBytes(new byte[(512 - body.length % 512) % 512]);
        }
        out.writeBytes(new byte[1024]);
        return out.toByteArray();
    }

    private static byte[] pngHeader(int w, int h) {
        ByteBuffer b = ByteBuffer.allocate(8 + 25 + 12);
        b.put(new byte[] {(byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n'});
        byte[] ihdr = ByteBuffer.allocate(17).put("IHDR".getBytes(StandardCharsets.US_ASCII)).putInt(w).putInt(h)
                .put((byte) 8).put((byte) 2).put((byte) 0).put((byte) 0).put((byte) 0).array();
        CRC32 crc = new CRC32();
        crc.update(ihdr);
        b.putInt(13).put(ihdr).putInt((int) crc.getValue());
        b.putInt(0).put("IEND".getBytes(StandardCharsets.US_ASCII)).putInt(0xAE426082);
        return b.array();
    }

    static String b64(byte[] b) {
        return Base64.getEncoder().encodeToString(b);
    }
}
