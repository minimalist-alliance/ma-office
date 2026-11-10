package com.minimalistalliance.desk.deskd.files;

import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.Locale;
import java.util.Map;

/**
 * The grammar of a path in the Files app (files.md section 0). Pure functions: a path is checked before anything
 * touches the tree, and deskd never rewrites a name.
 */
final class PathRules {

    static final String INVALID = "invalid";
    static final int MAX_PATH_BYTES = 1024;
    static final int MAX_NAME_BYTES = 255;
    static final String UPLOADS = ".uploads";
    static final String TRASH = ".trash";
    static final String[] ROOT = new String[0];
    /** The pseudo-path prefix of a trash item, in files.delete with {@code permanent}. */
    static final String TRASH_PREFIX = "trash:";

    private PathRules() {}

    /**
     * @param allowRoot true where {@code ""} means the root
     * @return the components, empty for the root
     * @throws RpcException invalid with a reason: empty, length, chars, nfc, dots, reserved
     */
    static String[] parse(Object value, boolean allowRoot, String param) throws RpcException {
        if (!(value instanceof String path)) {
            throw new RpcException(RpcException.BAD_REQUEST, param + " must be a string", Map.of("reason", param));
        }
        if (path.isEmpty()) {
            if (allowRoot) {
                return ROOT;
            }
            throw invalid("empty");
        }
        if (path.getBytes(StandardCharsets.UTF_8).length > MAX_PATH_BYTES) {
            throw invalid("length");
        }
        String[] parts = path.split("/", -1);
        for (String part : parts) {
            checkComponent(part);
        }
        if (isReserved(parts[0])) {
            throw invalid("reserved");
        }
        return parts;
    }

    static boolean isReserved(String rootName) {
        return UPLOADS.equals(rootName) || TRASH.equals(rootName);
    }

    /** One name, as a client may send it. */
    static void checkComponent(String part) throws RpcException {
        if (part.isEmpty()) {
            throw invalid("empty");
        }
        if (part.length() > MAX_NAME_BYTES * 4 || part.getBytes(StandardCharsets.UTF_8).length > MAX_NAME_BYTES) {
            throw invalid("length");
        }
        if (!charsOk(part)) {
            throw invalid("chars");
        }
        if (!Normalizer.isNormalized(part, Normalizer.Form.NFC)) {
            throw invalid("nfc");
        }
        if (part.equals(".") || part.equals("..")) {
            throw invalid("dots");
        }
    }

    /** True for a name that can be listed: a component the grammar allows, and not the lone dots. */
    static boolean validName(String name) {
        try {
            checkComponent(name);
            return true;
        } catch (RpcException e) {
            return false;
        }
    }

    private static boolean charsOk(String s) {
        for (int i = 0; i < s.length(); ) {
            int c = s.codePointAt(i);
            i += Character.charCount(c);
            if (c < 0x20 || c == 0x7F || (c >= 0x80 && c <= 0x9F) || c == '\\' || c == '/'
                    || (c >= 0x202A && c <= 0x202E) || (c >= 0x2066 && c <= 0x2069)
                    || c == 0xFFFD) {
                return false;
            }
        }
        // A lone surrogate is not text.
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (Character.isHighSurrogate(ch)) {
                if (i + 1 >= s.length() || !Character.isLowSurrogate(s.charAt(i + 1))) {
                    return false;
                }
                i++;
            } else if (Character.isLowSurrogate(ch)) {
                return false;
            }
        }
        return true;
    }

    /** The name case-folded the way listings sort: simple folding, approximated by upper then lower. */
    static String fold(String name) {
        return name.toUpperCase(Locale.ROOT).toLowerCase(Locale.ROOT);
    }

    static String join(String[] comps) {
        return String.join("/", comps);
    }

    static boolean startsWith(String[] path, String[] prefix) {
        if (prefix.length > path.length) {
            return false;
        }
        for (int i = 0; i < prefix.length; i++) {
            if (!prefix[i].equals(path[i])) {
                return false;
            }
        }
        return true;
    }

    static RpcException invalid(String reason) {
        return new RpcException(INVALID, "Not a path the Files app can use", Map.of("reason", reason));
    }
}
