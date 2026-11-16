package com.minimalistalliance.desk.deskd.courier.linked;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * IMAP's modified UTF-7 for folder and Gmail label names (RFC 3501 §5.1.3), decoded for showing. A name is always sent back
 * to the server exactly as the server gave it, so there's no encoder; a name that isn't valid modified UTF-7 shows as is.
 */
final class Mutf7 {

    private Mutf7() {}

    static String decode(String s) {
        if (s == null || s.indexOf('&') < 0) {
            return s;
        }
        StringBuilder out = new StringBuilder();
        int i = 0;
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c != '&') {
                out.append(c);
                i++;
                continue;
            }
            int end = s.indexOf('-', i + 1);
            if (end < 0) {
                return s;
            }
            if (end == i + 1) {
                out.append('&');
                i = end + 1;
                continue;
            }
            String b64 = s.substring(i + 1, end).replace(',', '/');
            try {
                byte[] utf16 = Base64.getDecoder().decode(b64 + "==".substring(0, (4 - b64.length() % 4) % 4));
                if (utf16.length % 2 != 0) {
                    return s;
                }
                out.append(StandardCharsets.UTF_16BE.decode(ByteBuffer.wrap(utf16)));
            } catch (IllegalArgumentException e) {
                return s;
            }
            i = end + 1;
        }
        return out.toString();
    }
}
