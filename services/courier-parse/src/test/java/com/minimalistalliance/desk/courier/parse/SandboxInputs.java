package com.minimalistalliance.desk.courier.parse;

import com.minimalistalliance.desk.courier.testkit.MimeCorpus;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.MemoryCacheImageOutputStream;
import org.junit.jupiter.api.Test;

/**
 * Writes the requests {@code scripts/test-courier-sandbox.sh} sends the real sandbox on Docker: the heaviest a message can
 * be (39 MiB, 2 MiB of dense HTML, a 49-megapixel PNG, a 12-megapixel progressive JPEG, a ZIP of 10,000 files) and every
 * limit, each as {@code <name>.req} (the line and the bytes) with the first line expected in {@code <name>.expect}. Runs
 * only with {@code -Dcourier.sandbox.out=DIR}.
 */
class SandboxInputs {

    @Test
    void write() throws Exception {
        String dir = System.getProperty("courier.sandbox.out");
        if (dir == null) {
            return;
        }
        Path out = Path.of(dir);
        Files.createDirectories(out);
        req(out, "large-39mib", "courier1 message", MimeCorpus.large(39 << 20).raw(), "OK");
        req(out, "over-40mib", "courier1 message", MimeCorpus.overLimit().raw(), "ERR too_large");
        req(out, "too-deep", "courier1 message", MimeCorpus.tooDeep(21).raw(), "ERR too_deep");
        req(out, "deep-20", "courier1 message", MimeCorpus.tooDeep(20).raw(), "OK");
        req(out, "too-many-parts", "courier1 message", MimeCorpus.tooManyParts(2001).raw(), "ERR too_many_parts");
        req(out, "parts-2000", "courier1 message", MimeCorpus.tooManyParts(2000).raw(), "OK");
        StringBuilder h = new StringBuilder("From: a@example.com\nContent-Type: text/html; charset=utf-8\n\n");
        while (h.length() < (2 << 20) - 200) {
            h.append("<table><tr><td style=\"color: red\"><a href=\"https://x.example/?utm_source=1\">link</a> word "
                    + "<img src=\"https://cdn.example/p.png\" width=\"40\"></td></tr></table>\n");
        }
        req(out, "html-2mib", "courier1 message", h.toString().getBytes(StandardCharsets.UTF_8), "OK");
        StringBuilder deep = new StringBuilder("From: a@example.com\nContent-Type: text/html\n\n");
        deep.append("<div>".repeat(200_000)).append("x");
        req(out, "html-deep", "courier1 message", deep.toString().getBytes(StandardCharsets.US_ASCII), "OK");
        req(out, "png-49mp", "courier1 image -", png(7000, 7000), "OK png 1750 1750");
        req(out, "jpeg-progressive-12mp", "courier1 image -", progressiveJpeg(4000, 2990), "OK jpeg 2000 1495");
        req(out, "png-bomb-268mp", "courier1 image -", pngBomb(16384, 16384), "ERR too_large");
        byte[] zip = zipMany(10_000);
        String msg = "From: a@example.com\r\nContent-Type: multipart/mixed; boundary=z\r\n\r\n--z\r\nContent-Type: text/plain\r\n\r\nhi\r\n"
                + "--z\r\nContent-Type: application/zip; name=\"many.zip\"\r\nContent-Transfer-Encoding: base64\r\n\r\n"
                + Base64.getMimeEncoder().encodeToString(zip) + "\r\n--z--\r\n";
        req(out, "zip-10000", "courier1 archive 2", msg.getBytes(StandardCharsets.US_ASCII), "OK");
        req(out, "gmail-alternative", "courier1 message", PartsTest.sample("gmail-alternative"), "OK");
        req(out, "bad-line", "courier1 nothing", new byte[0], "ERR bad_request");
    }

    private static void req(Path out, String name, String line, byte[] raw, String expect) throws Exception {
        byte[] head = (line + "\n").getBytes(StandardCharsets.US_ASCII);
        byte[] all = new byte[head.length + raw.length];
        System.arraycopy(head, 0, all, 0, head.length);
        System.arraycopy(raw, 0, all, head.length, raw.length);
        Files.write(out.resolve(name + ".req"), all);
        Files.writeString(out.resolve(name + ".expect"), expect + "\n");
    }

    private static byte[] png(int w, int h) throws Exception {
        BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        ImageIO.write(img, "png", b);
        return b.toByteArray();
    }

    /** A PNG of zeros, deflated: about a megabyte on the wire, 1 GiB of pixels if anything decoded it. */
    private static byte[] pngBomb(int w, int h) throws Exception {
        ByteArrayOutputStream idat = new ByteArrayOutputStream();
        try (java.util.zip.DeflaterOutputStream z = new java.util.zip.DeflaterOutputStream(idat, new java.util.zip.Deflater(9))) {
            byte[] row = new byte[1 + w * 4];
            for (int y = 0; y < h; y++) {
                z.write(row);
            }
        }
        ByteArrayOutputStream png = new ByteArrayOutputStream();
        png.write(new byte[] {(byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n'});
        chunk(png, "IHDR", java.nio.ByteBuffer.allocate(13).putInt(w).putInt(h).put((byte) 8).put((byte) 6).put((byte) 0)
                .put((byte) 0).put((byte) 0).array());
        chunk(png, "IDAT", idat.toByteArray());
        chunk(png, "IEND", new byte[0]);
        return png.toByteArray();
    }

    private static void chunk(ByteArrayOutputStream out, String type, byte[] data) throws Exception {
        java.util.zip.CRC32 crc = new java.util.zip.CRC32();
        byte[] t = type.getBytes(StandardCharsets.US_ASCII);
        crc.update(t);
        crc.update(data);
        out.write(java.nio.ByteBuffer.allocate(4).putInt(data.length).array());
        out.write(t);
        out.write(data);
        out.write(java.nio.ByteBuffer.allocate(4).putInt((int) crc.getValue()).array());
    }

    private static byte[] progressiveJpeg(int w, int h) throws Exception {
        BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < h; y += 7) {
            for (int x = 0; x < w; x += 3) {
                img.setRGB(x, y, (x * 31 + y * 17) & 0xFFFFFF);
            }
        }
        ImageWriter writer = ImageIO.getImageWritersByFormatName("jpeg").next();
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        try (MemoryCacheImageOutputStream ios = new MemoryCacheImageOutputStream(b)) {
            writer.setOutput(ios);
            ImageWriteParam p = writer.getDefaultWriteParam();
            p.setProgressiveMode(ImageWriteParam.MODE_DEFAULT);
            writer.write(null, new IIOImage(img, null, null), p);
        }
        writer.dispose();
        return b.toByteArray();
    }

    private static byte[] zipMany(int n) throws Exception {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        try (java.util.zip.ZipOutputStream z = new java.util.zip.ZipOutputStream(b)) {
            for (int i = 0; i < n; i++) {
                z.putNextEntry(new java.util.zip.ZipEntry("dir/file-" + i + (i == n / 2 ? ".exe" : ".txt")));
                z.write(1);
                z.closeEntry();
            }
        }
        return b.toByteArray();
    }
}
