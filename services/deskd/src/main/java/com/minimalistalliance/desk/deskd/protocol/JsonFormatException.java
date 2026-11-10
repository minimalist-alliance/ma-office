package com.minimalistalliance.desk.deskd.protocol;

/** Bytes that aren't the JSON expected. Carries no excerpt of them, so it's safe to log or return. */
public final class JsonFormatException extends Exception {

    private static final long serialVersionUID = 1L;

    public JsonFormatException() {
        super("invalid JSON", null, false, false);
    }
}
