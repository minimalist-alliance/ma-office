package com.minimalistalliance.desk.courier.parse;

import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Iterator;
import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageReadParam;
import javax.imageio.ImageReader;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.ImageInputStream;
import javax.imageio.stream.MemoryCacheImageInputStream;
import javax.imageio.stream.MemoryCacheImageOutputStream;

/**
 * An image decoded and drawn again from its pixels (the launch plan §2.7 and §3.4), so nothing of the sender's file
 * reaches the office: no metadata (a photo's location goes), no second image hidden after the first, no decoder bug of
 * the member's own device triggered by crafted bytes. PNG, JPEG, GIF (its first frame) and BMP are read; anything else
 * is {@code unsupported}. Its size is checked before a pixel is decoded, and it's decoded subsampled, so a 30,000-pixel
 * side costs what the preview costs. Out comes a PNG when it has transparency, a JPEG otherwise.
 */
final class Images {

    private Images() {}

    record Encoded(String type, int width, int height, byte[] bytes) {}

    static {
        // No cache files: the sandbox has nowhere to write, and the security manager allows no write anyway.
        ImageIO.setUseCache(false);
    }

    /** Loads ImageIO's readers and writers, before the security manager is installed. */
    static void init() {
        ImageIO.getReaderFormatNames();
        ImageIO.getWriterFormatNames();
    }

    static String format(byte[] head) {
        if (head.length >= 8 && (head[0] & 0xFF) == 0x89 && head[1] == 'P' && head[2] == 'N' && head[3] == 'G') {
            return "png";
        }
        if (head.length >= 3 && (head[0] & 0xFF) == 0xFF && (head[1] & 0xFF) == 0xD8 && (head[2] & 0xFF) == 0xFF) {
            return "jpeg";
        }
        if (head.length >= 6 && head[0] == 'G' && head[1] == 'I' && head[2] == 'F' && head[3] == '8') {
            return "gif";
        }
        if (head.length >= 14 && head[0] == 'B' && head[1] == 'M') {
            return "bmp";
        }
        return null;
    }

    /** A progressive JPEG (SOF2, 6, 10 or 14 before the first scan), which libjpeg decodes whole in native memory. */
    static boolean progressive(byte[] head) {
        for (int i = 2; i + 1 < head.length; i++) {
            if ((head[i] & 0xFF) == 0xFF) {
                int m = head[i + 1] & 0xFF;
                if (m == 0xC2 || m == 0xC6 || m == 0xCA || m == 0xCE) {
                    return true;
                }
                if (m == 0xDA) {
                    return false;
                }
            }
        }
        return false;
    }

    /**
     * @param head at least the first 64 KiB of the image, for its format and the progressive check
     * @throws Refusal {@code unsupported}, {@code too_large} (its size, before decoding) or {@code malformed}
     */
    static Encoded reencode(byte[] head, InputStream image, int maxSide) {
        String format = format(head);
        if (format == null) {
            throw new Refusal(Refusal.UNSUPPORTED);
        }
        Iterator<ImageReader> readers = ImageIO.getImageReadersByFormatName(format);
        if (!readers.hasNext()) {
            throw new Refusal(Refusal.UNSUPPORTED);
        }
        ImageReader reader = readers.next();
        try (ImageInputStream iis = new MemoryCacheImageInputStream(image)) {
            reader.setInput(iis, true, true);
            int w = reader.getWidth(0);
            int h = reader.getHeight(0);
            long pixels = (long) w * h;
            if (w <= 0 || h <= 0 || w > Limits.MAX_IMAGE_SIDE || h > Limits.MAX_IMAGE_SIDE || pixels > Limits.MAX_IMAGE_PIXELS
                    || format.equals("jpeg") && progressive(head) && pixels > Limits.MAX_PROGRESSIVE_PIXELS) {
                throw new Refusal(Refusal.TOO_LARGE);
            }
            int step = Math.max(1, (Math.max(w, h) + maxSide - 1) / maxSide);
            ImageReadParam param = reader.getDefaultReadParam();
            param.setSourceSubsampling(step, step, 0, 0);
            BufferedImage read = reader.read(0, param);
            return encode(read);
        } catch (Refusal r) {
            throw r;
        } catch (IOException | RuntimeException e) {
            throw new Refusal(Refusal.MALFORMED);
        } finally {
            reader.dispose();
        }
    }

    private static Encoded encode(BufferedImage read) throws IOException {
        boolean alpha = read.getColorModel().hasAlpha();
        int w = read.getWidth();
        int h = read.getHeight();
        BufferedImage drawn = new BufferedImage(w, h, alpha ? BufferedImage.TYPE_INT_ARGB : BufferedImage.TYPE_INT_RGB);
        Graphics2D g = drawn.createGraphics();
        try {
            if (!alpha) {
                g.setColor(java.awt.Color.WHITE);
                g.fillRect(0, 0, w, h);
            }
            g.drawImage(read, 0, 0, null);
        } finally {
            g.dispose();
        }
        read.flush();
        CappedBytes out = new CappedBytes(Limits.MAX_IMAGE_OUT);
        String type = alpha ? "png" : "jpeg";
        ImageWriter writer = ImageIO.getImageWritersByFormatName(type).next();
        try (MemoryCacheImageOutputStream ios = new MemoryCacheImageOutputStream(out)) {
            writer.setOutput(ios);
            ImageWriteParam wp = writer.getDefaultWriteParam();
            if (!alpha) {
                wp.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
                wp.setCompressionQuality(0.85f);
            }
            writer.write(null, new IIOImage(drawn, null, null), wp);
        } finally {
            writer.dispose();
        }
        if (out.over) {
            throw new Refusal(Refusal.TOO_LARGE);
        }
        return new Encoded(type, w, h, out.toByteArray());
    }

    /** A byte array output that stops growing at its cap, and says so. */
    private static final class CappedBytes extends ByteArrayOutputStream {
        private final int cap;
        boolean over;

        CappedBytes(int cap) {
            super(64 * 1024);
            this.cap = cap;
        }

        @Override
        public synchronized void write(byte[] b, int off, int len) {
            if (over || count + len > cap) {
                over = true;
                return;
            }
            super.write(b, off, len);
        }

        @Override
        public synchronized void write(int b) {
            write(new byte[] {(byte) b}, 0, 1);
        }
    }
}
