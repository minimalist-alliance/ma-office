package com.minimalistalliance.desk.deskd.browser;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * The password managers a member may add to the desk's Browser, and nothing else: the same three ids the image's
 * {@code ExtensionInstallAllowlist} names (docs/sub-status/desk-sign-ins.md, "Policies"). deskd opens only these
 * extensions' own pages, at the page each one shows from its toolbar button, and never attaches to one, reads one or runs
 * anything in one.
 *
 * <p>{@code page} is the extension's toolbar page, its manifest's {@code action.default_popup}, as each vendor ships it. A
 * vendor can move it in an update; then the key button opens Chromium's error page in a tab of its own, which the member
 * closes, until a deskd with the new path. The System Engineer's verify reads each installed manifest against this table.
 */
final class PasswordManagers {

    /** One allowed extension. {@code page} is a path in the extension, without a leading slash. */
    record Manager(String id, String name, String page) {

        String pageUrl() {
            return "chrome-extension://" + id + "/" + page;
        }

        String origin() {
            return "chrome-extension://" + id + "/";
        }

        String storeUrl() {
            return "https://chromewebstore.google.com/detail/" + id;
        }
    }

    /** Chromium's extension ids: 32 letters from a to p. */
    private static final Pattern ID = Pattern.compile("[a-p]{32}");
    private static final Pattern PAGE = Pattern.compile("[A-Za-z0-9_./-]{1,128}(\\?[A-Za-z0-9_=&-]{1,64})?");

    /**
     * Bitwarden's own page for use outside its toolbar popup is {@code uilocation=popout}, which lays it out for a page of
     * its own.
     */
    static final List<Manager> LAUNCH = List.of(
            new Manager("nngceckbapebfimnlniiiahkandclblb", "Bitwarden", "popup/index.html?uilocation=popout"),
            new Manager("aeblfdkhhhdcdjpifhhbdiojplfjncoa", "1Password", "popup/index.html"),
            new Manager("ghmbeldphafepmbegfdlkpapadhbakde", "Proton Pass", "popup.html"));

    private final Map<String, Manager> byId = new LinkedHashMap<>();

    PasswordManagers(List<Manager> managers) {
        for (Manager manager : managers) {
            if (!ID.matcher(manager.id()).matches() || !PAGE.matcher(manager.page()).matches() || manager.page().contains("..")) {
                throw new IllegalArgumentException("not an extension id and page");
            }
            byId.put(manager.id(), manager);
        }
    }

    static boolean isId(Object value) {
        return value instanceof String s && ID.matcher(s).matches();
    }

    /** @return null if it isn't on the list */
    Manager get(String id) {
        return byId.get(id);
    }

    List<Manager> all() {
        return List.copyOf(byId.values());
    }

    List<String> ids() {
        return List.copyOf(byId.keySet());
    }
}
