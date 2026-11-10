package com.minimalistalliance.desk.deskd.browser.minified;

/**
 * What kind of image some bytes are, by their first bytes alone: deskd never decodes an image (Security T47-5). Only
 * raster formats a browser shows safely as a blob: never SVG, which is a document with script, or anything else.
 */
final class ImageBytes {

    private ImageBytes() {}

    /** @return the media type, or null if it isn't PNG, JPEG, GIF, WebP or AVIF */
    static String sniff(byte[] b) {
        if (b.length >= 8 && (b[0] & 0xFF) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G'
                && b[4] == 0x0D && b[5] == 0x0A && b[6] == 0x1A && b[7] == 0x0A) {
            return "image/png";
        }
        if (b.length >= 3 && (b[0] & 0xFF) == 0xFF && (b[1] & 0xFF) == 0xD8 && (b[2] & 0xFF) == 0xFF) {
            return "image/jpeg";
        }
        if (b.length >= 6 && b[0] == 'G' && b[1] == 'I' && b[2] == 'F' && b[3] == '8' && (b[4] == '7' || b[4] == '9') && b[5] == 'a') {
            return "image/gif";
        }
        if (b.length >= 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F'
                && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') {
            return "image/webp";
        }
        if (b.length >= 12 && b[4] == 'f' && b[5] == 't' && b[6] == 'y' && b[7] == 'p'
                && b[8] == 'a' && b[9] == 'v' && b[10] == 'i' && (b[11] == 'f' || b[11] == 's')) {
            return "image/avif";
        }
        return null;
    }
}
