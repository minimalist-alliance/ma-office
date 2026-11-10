package com.minimalistalliance.desk.agent.icon;

import java.util.Locale;

/** An upload that was refused. Carries a reason and never any of the upload's content. */
public final class IconException extends Exception {

    private static final long serialVersionUID = 1L;

    public enum Reason {
        /** Not a PNG: empty, or the 8-byte signature is wrong. */
        NOT_PNG,
        /** Over 256 KiB in, or (never in practice) over 512 KiB out. */
        TOO_LARGE,
        /** Wider or taller than 512 pixels. */
        TOO_MANY_PIXELS,
        /** Has the signature but isn't a well-formed PNG. */
        CORRUPT,
        /** Nothing in the picture stands out as a shape: blank, a photo, a filled block. */
        NO_SHAPE,
        /** The shape's lines are too thin to see at icon size. */
        TOO_THIN;

        /**
         * The word the wire uses: {@code not_png}, {@code too_large}, {@code too_many_pixels}, {@code corrupt},
         * {@code no_shape}, {@code too_thin}.
         */
        public String wireName() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    private final Reason reason;

    public IconException(Reason reason) {
        super(reason.wireName(), null, false, false);
        this.reason = reason;
    }

    public Reason reason() {
        return reason;
    }
}
