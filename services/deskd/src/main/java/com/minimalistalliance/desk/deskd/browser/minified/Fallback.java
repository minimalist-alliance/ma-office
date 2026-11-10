package com.minimalistalliance.desk.deskd.browser.minified;

import java.util.Locale;

/** Why a tab shows the stream rather than the simplified view: {@code fallback.reason} on the wire (API.md section 14). */
enum Fallback {
    /** Not a web page: an empty tab, the new tab page or an error page. */
    NOT_PAGE(false, false),
    /** The site is on the shipped sensitive list, or the member marked it sensitive. */
    SENSITIVE_SITE(false, false),
    /** The member chose the stream for this site. */
    MEMBER_CHOICE(false, false),
    /** Pages of this site fell back twice lately, for {@code cause}. */
    REMEMBERED(false, false),
    /** The page has a dialog open, which only the stream shows. Never answered for the member. */
    DIALOG(false, false),
    /** The server asked for HTTP sign-in. */
    HTTP_AUTH(false, true),
    /** The server answered with an error (400 or more, but 401 and 407): an error page, which the stream shows as it is. */
    HTTP_ERROR(false, true),
    /**
     * A page only the member can get through, on the real page: {@code cause} is {@link #PERSON_CHECK} (a CAPTCHA or a
     * bot check), {@link #SIGN_IN} (a sign-in page) or {@link #PAYMENT} (a checkout). Looked at again when the page
     * changes, as once they're through it's gone.
     */
    CHALLENGE(false, false),
    /** Only ever a challenge's cause. */
    PERSON_CHECK(false, false),
    /** Only ever a challenge's cause. */
    SIGN_IN(false, false),
    /** Only ever a challenge's cause. */
    PAYMENT(false, false),
    /** An app: the page is mostly a few controls it draws itself, with little to read and nothing to take away. */
    APP(true, true),
    /**
     * The page asks the member to agree to its terms before they read on: only they can, on the real page. Not held
     * against the site, as it's gone once they agree.
     */
    TERMS_WALL(false, false),
    /** The distiller failed or isn't there. */
    DISTILLER_ERROR(false, true),
    /**
     * The distiller took too long. Not held against the site: a Chromium just thawed (ADR 0045) or a busy desk is slow
     * too, and that says nothing of the site.
     */
    TIMEOUT(false, true),
    /** The page is too large to simplify. */
    TOO_LARGE(true, true),
    /** Too little of the page came through. */
    LOW_CONFIDENCE(true, true),
    /** A canvas takes most of the page: maps, drawing, games. */
    CANVAS_APP(true, true),
    /** Another site's frame takes much of the page. */
    CROSS_ORIGIN_FRAMES(true, true);

    /** Whether a site falling back this way counts toward {@link #REMEMBERED}. */
    final boolean rememberable;
    /** Whether it holds for the rest of this document, so it isn't tried again until the page navigates. */
    final boolean forDocument;

    Fallback(boolean rememberable, boolean forDocument) {
        this.rememberable = rememberable;
        this.forDocument = forDocument;
    }

    String wire() {
        return name().toLowerCase(Locale.ROOT);
    }

    static Fallback parse(String wire) {
        for (Fallback reason : values()) {
            if (reason.wire().equals(wire)) {
                return reason;
            }
        }
        return null;
    }
}
