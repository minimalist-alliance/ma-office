package com.minimalistalliance.desk.agent.attach.worker;

import java.nio.charset.StandardCharsets;

/** Text, Markdown, CSV, JSON and code: decoded as UTF-8 (or UTF-16 with a mark), control characters dropped. */
final class PlainText {

    private PlainText() {}

    static ParseWorker.Result read(byte[] bytes, int maxChars) {
        if (bytes.length == 0) {
            return ParseWorker.Result.error("empty");
        }
        java.nio.charset.Charset charset = StandardCharsets.UTF_8;
        int start = 0;
        if (bytes.length >= 3 && (bytes[0] & 0xFF) == 0xEF && (bytes[1] & 0xFF) == 0xBB && (bytes[2] & 0xFF) == 0xBF) {
            start = 3;
        } else if (bytes.length >= 2 && (bytes[0] & 0xFF) == 0xFF && (bytes[1] & 0xFF) == 0xFE) {
            charset = StandardCharsets.UTF_16LE;
            start = 2;
        } else if (bytes.length >= 2 && (bytes[0] & 0xFF) == 0xFE && (bytes[1] & 0xFF) == 0xFF) {
            charset = StandardCharsets.UTF_16BE;
            start = 2;
        } else {
            int look = Math.min(bytes.length, 8192);
            for (int i = 0; i < look; i++) {
                if (bytes[i] == 0) {
                    return ParseWorker.Result.error("binary");
                }
            }
        }
        // Decode no more than the cap needs: 4 bytes a char at most in UTF-8, plus slack for what is dropped.
        int take = (int) Math.min((long) bytes.length - start, (long) maxChars * 4 + 16);
        String decoded = new String(bytes, start, take, charset);
        boolean cut = take < bytes.length - start;
        ParseWorker.Capped out = new ParseWorker.Capped(maxChars);
        StringBuilder piece = new StringBuilder();
        for (int i = 0; i < decoded.length(); i++) {
            char c = decoded.charAt(i);
            if (c == '\r') {
                if (i + 1 < decoded.length() && decoded.charAt(i + 1) == '\n') {
                    continue;
                }
                c = '\n';
            }
            if (c < 0x20 && c != '\n' && c != '\t' || c == 0x7F || (c >= 0x80 && c < 0xA0)) {
                continue;
            }
            piece.append(c);
            if (piece.length() >= 4096) {
                out.append(piece);
                piece.setLength(0);
            }
        }
        out.append(piece);
        String text = out.toString();
        if (cut && text.endsWith("�")) {
            text = text.substring(0, text.length() - 1);
        }
        if (text.isBlank()) {
            return ParseWorker.Result.error("empty");
        }
        return ParseWorker.Result.ok(text, cut || out.full() ? "cut" : null);
    }
}
