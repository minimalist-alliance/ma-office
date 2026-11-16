package com.minimalistalliance.desk.deskd.docs;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import javax.imageio.ImageIO;

/**
 * A stand-in for the sandbox's documents mode: a "PDF" here is {@code %PDF-} then pages split by form feeds, lines by
 * newlines; a line {@code [sign]} is an empty signature field and {@code [signed]} a filled one. Pages are drawn as small
 * JPEGs. It can be made unavailable, and counts its calls.
 */
final class FakeDocsSandbox implements DocsSandbox {

    volatile boolean unavailable;
    final AtomicInteger reads = new AtomicInteger();
    final AtomicInteger renders = new AtomicInteger();

    static byte[] pdf(String... pages) {
        return ("%PDF-1.7\n" + String.join("\f", pages)).getBytes(StandardCharsets.UTF_8);
    }

    @Override
    public DocText read(String kind, byte[] file) throws Unavailable, Refused {
        reads.incrementAndGet();
        if (unavailable) {
            throw new Unavailable("test");
        }
        String all = new String(file, StandardCharsets.UTF_8);
        if (all.contains("[encrypted]")) {
            throw new Refused("encrypted");
        }
        List<DocText.Page> pages = new ArrayList<>();
        int sig = 0;
        int empty = 0;
        if (kind.equals("pdf")) {
            String body = all.substring(all.indexOf('\n') + 1);
            String[] ps = body.split("\f", -1);
            for (int i = 0; i < ps.length; i++) {
                List<DocText.Line> lines = new ArrayList<>();
                String[] ls = ps[i].split("\n");
                for (int k = 0; k < ls.length; k++) {
                    if (ls[k].isBlank()) {
                        continue;
                    }
                    if (ls[k].contains("[sign]")) {
                        sig++;
                        empty++;
                    } else if (ls[k].contains("[signed]")) {
                        sig++;
                    }
                    lines.add(new DocText.Line(ls[k].strip(), 0.1, Math.min(0.95, 0.05 + k * 0.03), 0.8, 0.02));
                }
                pages.add(new DocText.Page(i + 1, 612, 792, ps[i].strip(), lines));
            }
            return new DocText("pdf", pages.size(), false, pages, List.of(), sig, empty, 0);
        }
        if (kind.equals("text")) {
            pages.add(new DocText.Page(1, 0, 0, all.strip(), List.of()));
            return new DocText("text", 1, false, pages, List.of(), 0, 0, 0);
        }
        return new DocText(kind, 0, false, List.of(), List.of(new DocText.Section("p", all.strip(), null)), 0, 0, 0);
    }

    @Override
    public Image render(byte[] pdf, int page, int width) throws Unavailable, Refused {
        renders.incrementAndGet();
        if (unavailable) {
            throw new Unavailable("test");
        }
        DocText t;
        try {
            t = read("pdf", pdf);
        } catch (Unavailable e) {
            throw e;
        }
        if (page > t.pages().size()) {
            throw new Refused("not_found");
        }
        return new Image("jpeg", width, (int) (width * 1.294), jpeg(Math.min(width, 64), 80));
    }

    @Override
    public Image image(byte[] bytes) throws Unavailable {
        if (unavailable) {
            throw new Unavailable("test");
        }
        return new Image("png", 4, 4, bytes);
    }

    static byte[] jpeg(int w, int h) {
        try {
            BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            ImageIO.write(img, "jpeg", out);
            return out.toByteArray();
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }
}
